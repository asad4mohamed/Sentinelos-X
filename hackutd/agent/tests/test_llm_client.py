"""NVIDIA client tests against a MOCKED HTTP transport. These do not prove the live API works (see test_live_nvidia.py)."""

from __future__ import annotations

import json

import httpx
import pytest

from sentinel_agent.config import Settings
from sentinel_agent.llm.nvidia_client import (
    LLMAuthError, LLMBadResponse, LLMError, LLMNotConfigured, LLMRateLimited, LLMTimeout, LLMUnavailable, NvidiaClient,
)

TOOLS = [{"type": "function", "function": {"name": "t", "description": "d", "parameters": {"type": "object", "properties": {}}}}]
OK_BODY = {
    "choices": [{"finish_reason": "tool_calls", "message": {
        "role": "assistant", "content": "<think>private reasoning</think>Checking.",
        "reasoning_content": "private chain of thought",
        "tool_calls": [{"id": "abc", "type": "function", "function": {"name": "get_asset_status", "arguments": "{\"asset_id\": \"auth-service\"}"}}],
    }}],
    "usage": {"prompt_tokens": 10, "completion_tokens": 5},
}


def settings(**kw):
    from dataclasses import replace
    return replace(Settings(nvidia_api_key="nvapi-TESTKEY1234567890", retry_backoff_s=0.01, max_retries=2), **kw)


def client(handler, **kw):
    async def no_sleep(_):
        return None

    return NvidiaClient(settings(**kw), transport=httpx.MockTransport(handler), sleep=no_sleep)


async def test_requires_api_key():
    with pytest.raises(LLMNotConfigured):
        NvidiaClient(Settings())


async def test_request_shape_and_response_parsing():
    seen = {}

    def handler(request: httpx.Request):
        seen["url"], seen["auth"], seen["body"] = str(request.url), request.headers["authorization"], json.loads(request.content)
        return httpx.Response(200, json=OK_BODY)

    c = client(handler, nvidia_extra_body={"chat_template_kwargs": {"enable_thinking": False}})
    resp = await c.chat([{"role": "user", "content": "hi"}], TOOLS)
    assert seen["url"] == "https://integrate.api.nvidia.com/v1/chat/completions"
    assert seen["auth"] == "Bearer nvapi-TESTKEY1234567890"
    b = seen["body"]
    assert b["model"] == "nvidia/nemotron-3-ultra-550b-a55b" and b["tools"] == TOOLS and b["tool_choice"] == "auto" and b["stream"] is False
    assert b["chat_template_kwargs"] == {"enable_thinking": False}
    assert resp.tool_calls[0].name == "get_asset_status" and json.loads(resp.tool_calls[0].arguments_raw) == {"asset_id": "auth-service"}
    assert resp.content == "Checking." and "private" not in json.dumps(resp.__dict__, default=str)
    assert resp.usage["prompt_tokens"] == 10


async def test_no_tools_means_no_tool_choice():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=OK_BODY)

    await client(handler).chat([{"role": "user", "content": "x"}], [])
    assert "tools" not in seen["body"] and "tool_choice" not in seen["body"]


async def test_rate_limit_is_retried_then_succeeds():
    attempts = []

    def handler(request):
        attempts.append(1)
        return httpx.Response(429, headers={"retry-after": "1"}) if len(attempts) < 3 else httpx.Response(200, json=OK_BODY)

    resp = await client(handler).chat([], TOOLS)
    assert len(attempts) == 3 and resp.tool_calls


async def test_rate_limit_exhaustion_raises_after_bounded_retries():
    attempts = []

    def handler(request):
        attempts.append(1)
        return httpx.Response(429)

    with pytest.raises(LLMRateLimited):
        await client(handler).chat([], TOOLS)
    assert len(attempts) == 3  # 1 + max_retries(2)


async def test_server_errors_retried_but_auth_errors_are_not():
    n = []

    def boom(request):
        n.append(1)
        return httpx.Response(503, text="overloaded")

    with pytest.raises(LLMUnavailable):
        await client(boom).chat([], TOOLS)
    assert len(n) == 3

    n.clear()

    def unauthorized(request):
        n.append(1)
        return httpx.Response(401, text="nvapi-TESTKEY1234567890 rejected")

    with pytest.raises(LLMAuthError) as e:
        await client(unauthorized).chat([], TOOLS)
    assert len(n) == 1 and "nvapi-TEST" not in e.value.message


async def test_non_transient_4xx_not_retried_and_secret_redacted():
    n = []

    def handler(request):
        n.append(1)
        return httpx.Response(400, text="bad request nvapi-TESTKEY1234567890")

    with pytest.raises(LLMError) as e:
        await client(handler).chat([], TOOLS)
    assert len(n) == 1 and "TESTKEY" not in e.value.message


async def test_timeout_is_retried_then_raised():
    n = []

    def handler(request):
        n.append(1)
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(LLMTimeout):
        await client(handler).chat([], TOOLS)
    assert len(n) == 3


async def test_network_error_maps_to_unavailable():
    def handler(request):
        raise httpx.ConnectError("down", request=request)

    with pytest.raises(LLMUnavailable):
        await client(handler, max_retries=0).chat([], TOOLS)


@pytest.mark.parametrize("payload", [{"choices": []}, {"nope": 1}, {"choices": [{"message": None}]}])
async def test_bad_response_shapes(payload):
    with pytest.raises(LLMBadResponse):
        await client(lambda r: httpx.Response(200, json=payload)).chat([], TOOLS)


async def test_non_json_body():
    with pytest.raises(LLMBadResponse):
        await client(lambda r: httpx.Response(200, text="<html>gateway</html>")).chat([], TOOLS)


async def test_object_arguments_and_missing_ids_are_normalised():
    body = {"choices": [{"message": {"content": None, "tool_calls": [
        {"function": {"name": "get_asset_status", "arguments": {"asset_id": "auth-service"}}},
        {"broken": True},
    ]}}]}
    resp = await client(lambda r: httpx.Response(200, json=body)).chat([], TOOLS)
    assert json.loads(resp.tool_calls[0].arguments_raw) == {"asset_id": "auth-service"} and resp.tool_calls[0].id == "call_0"
    assert resp.tool_calls[1].name == ""  # surfaces as a malformed call downstream, never crashes
