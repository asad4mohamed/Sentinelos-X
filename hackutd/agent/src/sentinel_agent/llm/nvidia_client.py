"""NVIDIA chat-completions client (OpenAI-compatible endpoint).

Verified facts (2026-11-07):
  * Base URL https://integrate.api.nvidia.com/v1, route POST /chat/completions, `Authorization: Bearer <key>`.
  * Public GET /v1/models lists `nvidia/nemotron-3-super-120b-a12b` (default here), `nvidia/nemotron-3-ultra-550b-a55b`,
    `nvidia/llama-3.1-nemotron-ultra-253b-v1`, `nvidia/nemotron-3.5-lightning-30b-a3b` and others.
  * Tool calling follows the OpenAI schema (`tools`, `tool_choice`, `message.tool_calls[].function.{name,arguments}`).
NOT verified here: live tool-calling behaviour of any specific model (no API key was available when this was
written). Run `pytest -m live_nvidia` with a key to verify. Per-model quirks can be tuned via NVIDIA_EXTRA_BODY.
"""

from __future__ import annotations

import asyncio
import logging
import random
import re
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

from ..config import Settings
from ..security.audit import redact

logger = logging.getLogger("sentinel_agent.llm")


class LLMError(Exception):
    code = "LLM_ERROR"

    def __init__(self, message: str, *, status: int | None = None):
        super().__init__(message)
        self.message, self.status = message, status


class LLMNotConfigured(LLMError):
    code = "LLM_NOT_CONFIGURED"


class LLMAuthError(LLMError):
    code = "LLM_AUTH_FAILED"


class LLMRateLimited(LLMError):
    code = "LLM_RATE_LIMITED"


class LLMTimeout(LLMError):
    code = "LLM_TIMEOUT"


class LLMUnavailable(LLMError):
    code = "LLM_UNAVAILABLE"


class LLMBadResponse(LLMError):
    code = "LLM_BAD_RESPONSE"


@dataclass
class LLMToolCall:
    id: str
    name: str
    arguments_raw: str  # exactly as returned by the model; validated later by the registry


@dataclass
class LLMResponse:
    content: str | None
    tool_calls: list[LLMToolCall] = field(default_factory=list)
    finish_reason: str | None = None
    usage: dict[str, Any] | None = None


class LLMClient(Protocol):
    provider: str
    model_id: str

    async def chat(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> LLMResponse: ...


_THINK_RE = re.compile(r"<think>.*?</think>", re.S)
RETRYABLE_STATUS = {408, 409, 429, 500, 502, 503, 504}
MAX_RETRY_AFTER_S = 20.0


class NvidiaClient:
    provider = "nvidia"

    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None, sleep=asyncio.sleep):
        if not settings.nvidia_api_key:
            raise LLMNotConfigured("NVIDIA_API_KEY is not set")
        self._s = settings
        self.model_id = settings.model_id
        self._sleep = sleep
        self._http = httpx.AsyncClient(
            base_url=settings.nvidia_base_url,
            timeout=httpx.Timeout(settings.request_timeout_s),
            transport=transport,
            headers={"Accept": "application/json"},
        )

    async def aclose(self) -> None:
        await self._http.aclose()

    def _body(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": self._s.model_id,
            "messages": messages,
            "temperature": self._s.temperature,
            "max_tokens": self._s.max_tokens,
            "stream": False,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        body.update(self._s.nvidia_extra_body)
        return body

    async def chat(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> LLMResponse:
        """One completion with bounded retries on transient failures.

        Retrying a chat completion is safe: the call has no side effects in this system (tools run only after a response
        has been parsed, in our code). Non-transient errors (4xx other than 408/409/429) are never retried.
        """
        body = self._body(messages, tools)
        headers = {"Authorization": f"Bearer {self._s.nvidia_api_key}"}
        last_error: LLMError | None = None
        for attempt in range(self._s.max_retries + 1):
            try:
                resp = await self._http.post("/chat/completions", json=body, headers=headers)
            except httpx.TimeoutException:
                last_error = LLMTimeout("request to NVIDIA timed out")
            except httpx.TransportError as exc:
                last_error = LLMUnavailable(f"network error talking to NVIDIA: {type(exc).__name__}")
            else:
                if resp.status_code == 200:
                    return self._parse(resp)
                last_error = self._error_for(resp)
                if resp.status_code not in RETRYABLE_STATUS:
                    raise last_error
                retry_after = _retry_after(resp)
                if attempt < self._s.max_retries:
                    await self._sleep(self._delay(attempt, retry_after))
                    continue
            if attempt < self._s.max_retries:
                await self._sleep(self._delay(attempt, None))
        assert last_error is not None
        logger.warning("NVIDIA call failed after retries", extra={"code": last_error.code})
        raise last_error

    def _delay(self, attempt: int, retry_after: float | None) -> float:
        if retry_after is not None:
            return min(retry_after, MAX_RETRY_AFTER_S)
        base = self._s.retry_backoff_s * (2**attempt)
        return base + random.uniform(0, base * 0.2)

    @staticmethod
    def _error_for(resp: httpx.Response) -> LLMError:
        status = resp.status_code
        detail = redact(resp.text[:200]) if resp.text else ""
        if status in (401, 403):
            return LLMAuthError("NVIDIA rejected the API key (check NVIDIA_API_KEY and model access)", status=status)
        if status == 429:
            return LLMRateLimited("NVIDIA rate limit reached", status=status)
        if status in (404,):
            return LLMError(f"model or endpoint not found: {detail}", status=status)
        if status >= 500 or status in (408, 409):
            return LLMUnavailable(f"NVIDIA service error {status}", status=status)
        return LLMError(f"NVIDIA rejected the request ({status}): {detail}", status=status)

    @staticmethod
    def _parse(resp: httpx.Response) -> LLMResponse:
        try:
            payload = resp.json()
            choice = payload["choices"][0]
            message = choice["message"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise LLMBadResponse("NVIDIA response did not match the chat-completions shape") from exc
        if not isinstance(message, dict) or not isinstance(choice, dict):
            raise LLMBadResponse("NVIDIA response message was not an object")
        content = message.get("content")
        if isinstance(content, str):
            content = _THINK_RE.sub("", content).strip() or None  # never keep/expose reasoning blocks
        else:
            content = None
        calls: list[LLMToolCall] = []
        for i, raw in enumerate(message.get("tool_calls") or []):
            try:
                fn = raw["function"]
                args = fn.get("arguments", "")
                if not isinstance(args, str):  # some servers return an object
                    import json

                    args = json.dumps(args)
                calls.append(LLMToolCall(id=str(raw.get("id") or f"call_{i}"), name=str(fn["name"]), arguments_raw=args))
            except (KeyError, TypeError):
                calls.append(LLMToolCall(id=f"call_bad_{i}", name="", arguments_raw=""))
        # `reasoning_content` (if the model emits it) is intentionally discarded.
        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else None
        return LLMResponse(content=content, tool_calls=calls, finish_reason=choice.get("finish_reason"), usage=usage)


def _retry_after(resp: httpx.Response) -> float | None:
    raw = resp.headers.get("retry-after")
    if raw is None:
        return None
    try:
        return max(0.0, float(raw))
    except ValueError:
        return None
