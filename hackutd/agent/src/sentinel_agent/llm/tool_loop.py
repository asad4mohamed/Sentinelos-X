"""The real multi-step tool-calling loop.

The model chooses tool calls; this code validates, authorizes, executes and records each one, returns the result to
the model, and repeats until the model submits a validated report or a safety limit trips. Tool-call records are
written only by `ToolExecutor` at actual execution time, so traces cannot be fabricated by the model.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from ..config import Settings
from ..models import ToolCallRecord
from ..orchestration.investigation_state import InvestigationRun
from ..orchestration.control_tools import CONTROL_TOOL_NAMES, control_tool_schemas
from ..security.audit import AuditLog
from ..security.policy import ToolPolicy
from ..security.untrusted_content import scan_for_injection, wrap_untrusted
from ..models import InvestigationState as S
from ..timeutil import now_utc
from ..tools.base import ToolContext
from ..tools.registry import ToolRegistry
from .nvidia_client import LLMClient, LLMToolCall
from .prompts import BUDGET_EXHAUSTED, NUDGE_NO_TOOL

logger = logging.getLogger("sentinel_agent.loop")

MAX_TOOL_PAYLOAD_CHARS = 30000
MAX_NUDGES = 2


class LoopLimitError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


@dataclass
class ControlOutcome:
    content: dict[str, Any]
    done: bool = False


ControlHandler = Callable[[str, str], Awaitable[ControlOutcome]]

_STATE_FOR_TOOL = {
    "calculate_blast_radius": S.ANALYZING,
    "get_infrastructure_dependencies": S.ANALYZING,
    "simulate_recovery_strategy": S.SIMULATING_RECOVERY,
    "update_hypothesis": S.ANALYZING,
}


def _safe_args(raw: str) -> dict[str, Any]:
    try:
        parsed = json.loads(raw) if raw else {}
    except (json.JSONDecodeError, TypeError):
        return {"_unparseable_arguments": str(raw)[:200]}
    if not isinstance(parsed, dict):
        return {"_non_object_arguments": str(parsed)[:200]}
    return {k: (v[:300] if isinstance(v, str) else v) for k, v in parsed.items()}


class ToolExecutor:
    """Authorize -> validate -> execute -> record one investigation tool call."""

    def __init__(self, registry: ToolRegistry, policy: ToolPolicy, ctx: ToolContext, run: InvestigationRun,
                 audit: AuditLog, settings: Settings):
        self.registry, self.policy, self.ctx, self.run, self.audit, self.s = registry, policy, ctx, run, audit, settings
        self.budget_used = 0
        self._seen_calls: dict[str, int] = {}

    @property
    def budget_left(self) -> int:
        return max(0, self.s.max_tool_calls - self.budget_used)

    def _record(self, call: LLMToolCall, status: str, started: float, started_at, *, error_code=None,
                evidence_ids=None, summary="", counted=True) -> ToolCallRecord:
        rec = ToolCallRecord(
            seq=len(self.run.tool_calls) + 1,
            model_tool_call_id=call.id,
            tool_name=(call.name or "")[:80],
            arguments=_safe_args(call.arguments_raw),
            status=status,  # type: ignore[arg-type]
            error_code=error_code,
            started_at=started_at,
            duration_ms=int((time.monotonic() - started) * 1000),
            evidence_ids=evidence_ids or [],
            result_summary=summary[:200],
            counted_toward_budget=counted,
        )
        self.run.tool_calls.append(rec)
        return rec

    async def execute(self, call: LLMToolCall) -> dict[str, Any]:
        started, started_at = time.monotonic(), now_utc()
        seq = len(self.run.tool_calls) + 1
        self.run.emit("tool_call_started", f"Calling {call.name or '<unnamed>'}", seq=seq, tool=call.name[:80])
        parsed = _safe_args(call.arguments_raw)

        # 1. budget: hard stop, not counted again
        if self.budget_used >= self.s.max_tool_calls:
            self._record(call, "denied", started, started_at, error_code="TOOL_BUDGET_EXHAUSTED", counted=False)
            self.audit.record("tool_denied", investigation_id=self.run.investigation_id, tool=call.name[:80], code="TOOL_BUDGET_EXHAUSTED")
            self.run.emit("tool_call_denied", f"{call.name}: tool budget exhausted", seq=seq, code="TOOL_BUDGET_EXHAUSTED")
            return self._error_payload("TOOL_BUDGET_EXHAUSTED", "tool budget exhausted; submit your report")

        # 2. every attempt that reaches policy consumes budget (a hijacked model cannot loop on denied calls)
        self.budget_used += 1

        decision = self.policy.authorize(call.name, parsed if "_unparseable_arguments" not in parsed else None)
        if not decision.allowed:
            self._record(call, "denied", started, started_at, error_code=decision.code, summary=decision.reason)
            self.audit.record("tool_denied", investigation_id=self.run.investigation_id, tool=call.name[:80], code=decision.code, reason=decision.reason)
            self.run.emit("tool_call_denied", f"Denied {call.name[:40]}: {decision.code}", seq=seq, code=decision.code)
            return self._error_payload(decision.code, decision.reason)

        # 3. duplicate detection (still executed, but flagged so the model stops wasting budget)
        key = f"{call.name}:{json.dumps(parsed, sort_keys=True, default=str)}"
        duplicate_of = self._seen_calls.get(key)
        self._seen_calls.setdefault(key, seq)

        result = await self.registry.execute(call.name, call.arguments_raw, self.ctx)

        if not result.ok:
            self._record(call, "error", started, started_at, error_code=result.error_code, summary=result.error_message or "")
            self.run.emit("tool_call_failed", f"{call.name} failed: {result.error_code}", seq=seq, code=result.error_code)
            payload = self._error_payload(result.error_code or "ERROR", result.error_message or "")
            return payload

        # 4. bound the payload, THEN register exactly the evidence the model will see
        records = list(result.evidence)
        data = dict(result.data or {})
        truncated = result.truncated
        while True:
            body = {
                "ok": True,
                "tool": call.name,
                **data,
                "evidence": [r.model_dump(mode="json") for r in records],
                "truncated": truncated,
                "tool_budget": {"used": self.budget_used, "max": self.s.max_tool_calls},
            }
            if duplicate_of:
                body["duplicate_call"] = f"identical to call #{duplicate_of}; do not repeat calls"
            wrapped = wrap_untrusted(body)
            text = json.dumps(wrapped, ensure_ascii=True, default=str)
            if len(text) <= MAX_TOOL_PAYLOAD_CHARS or not records:
                break
            records = records[: max(0, len(records) - max(1, len(records) // 4))]
            truncated = True
        ids = self.run.ledger.register(records, seq)
        flags = wrapped["injection_flags"]
        if flags:
            self.audit.record("injection_flagged", investigation_id=self.run.investigation_id, tool=call.name,
                              seq=seq, paths=[f["path"] for f in flags][:10], patterns=sorted({p for f in flags for p in f["patterns"]}))
            self.run.emit("injection_flagged", f"Possible prompt-injection text in {call.name} result; treated as data", seq=seq,
                          evidence_ids=[r.evidence_id for r in records if r.content_flags])
        self._record(call, "ok", started, started_at, evidence_ids=ids, summary=result.summary)
        self.run.emit("tool_call_completed", f"{call.name}: {result.summary}", seq=seq, evidence_ids=ids)
        new_state = _STATE_FOR_TOOL.get(call.name, S.COLLECTING_EVIDENCE)
        self.run.advance(new_state, f"after {call.name}")
        return {"__text__": text}

    @staticmethod
    def _error_payload(code: str, message: str) -> dict[str, Any]:
        return {"__text__": json.dumps(wrap_untrusted({"ok": False, "error": {"code": code, "message": message[:500]}}))}


class ToolLoop:
    def __init__(self, llm: LLMClient, executor: ToolExecutor, run: InvestigationRun, settings: Settings,
                 control: ControlHandler, deadline: float | None = None):
        self.llm, self.executor, self.run, self.s, self.control = llm, executor, run, settings, control
        self.deadline = deadline
        self._budget_notice_sent = False

    def _tools(self) -> list[dict[str, Any]]:
        schemas = control_tool_schemas()
        if self.executor.budget_left > 0:
            return self.executor.registry.openai_tools() + schemas
        return schemas

    async def run_loop(self, system: str, user: str) -> None:
        messages: list[dict[str, Any]] = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        turns = nudges = 0
        while True:
            if turns >= self.s.max_model_turns:
                raise LoopLimitError("MAX_MODEL_TURNS", f"model turn limit ({self.s.max_model_turns}) reached without a valid report")
            if self.deadline is not None and time.monotonic() > self.deadline:
                raise LoopLimitError("INVESTIGATION_TIMEOUT", "maximum investigation duration exceeded")
            response = await self.llm.chat(messages, self._tools())
            turns += 1
            self.run.emit("model_turn", f"Model turn {turns}: {len(response.tool_calls)} tool call(s)", turn=turns,
                          tool_calls=[c.name[:60] for c in response.tool_calls], usage=response.usage)
            assistant: dict[str, Any] = {"role": "assistant", "content": response.content or ""}
            if response.tool_calls:
                assistant["tool_calls"] = [
                    {"id": c.id, "type": "function", "function": {"name": c.name, "arguments": c.arguments_raw}}
                    for c in response.tool_calls
                ]
            messages.append(assistant)

            if not response.tool_calls:
                nudges += 1
                if nudges > MAX_NUDGES:
                    raise LoopLimitError("MODEL_NO_SUBMISSION", "model stopped calling tools without submitting a report")
                messages.append({"role": "user", "content": NUDGE_NO_TOOL})
                continue

            done = False
            for call in response.tool_calls:
                if call.name in CONTROL_TOOL_NAMES:
                    outcome = await self.control(call.name, call.arguments_raw)
                    messages.append({"role": "tool", "tool_call_id": call.id, "content": json.dumps(outcome.content)})
                    done = done or outcome.done
                else:
                    payload = await self.executor.execute(call)
                    messages.append({"role": "tool", "tool_call_id": call.id, "content": payload["__text__"]})
            if done:
                return
            if self.executor.budget_left == 0 and not self._budget_notice_sent:
                self._budget_notice_sent = True
                messages.append({"role": "user", "content": BUDGET_EXHAUSTED})
                self.run.emit("budget_exhausted", f"Tool budget of {self.s.max_tool_calls} reached; model must submit", used=self.executor.budget_used)
