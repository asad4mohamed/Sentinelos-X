"""Mutable state of one investigation plus its explicit state machine and event log."""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from typing import Any

from ..integrations.data_provider import DataProvider
from ..models import (
    ApprovalProposal,
    Finding,
    InvestigationError,
    InvestigationEvent,
    InvestigationState,
    RecommendedAction,
    RecoveryOption,
    ToolCallRecord,
)
from ..reporting.evidence import EvidenceLedger
from ..timeutil import now_utc
from .hypothesis_manager import HypothesisManager

S = InvestigationState
_ORDER = [S.QUEUED, S.COLLECTING_EVIDENCE, S.ANALYZING, S.SIMULATING_RECOVERY, S.AWAITING_APPROVAL, S.COMPLETED]
_RANK = {s: i for i, s in enumerate(_ORDER)}
TERMINAL = {S.COMPLETED, S.FAILED}


class InvalidTransition(RuntimeError):
    pass


def can_transition(src: InvestigationState, dst: InvestigationState) -> bool:
    if src in TERMINAL:
        return False
    if dst == S.FAILED:
        return True
    return _RANK[dst] > _RANK[src]  # forward only; stages may be skipped, never revisited


@dataclass
class InvestigationRun:
    investigation_id: str
    incident_id: str
    provider: DataProvider
    hypotheses: HypothesisManager
    ledger: EvidenceLedger
    state: InvestigationState = S.QUEUED
    created_at: Any = field(default_factory=now_utc)
    started_at: Any = None
    completed_at: Any = None
    events: list[InvestigationEvent] = field(default_factory=list)
    tool_calls: list[ToolCallRecord] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)
    recovery_options: list[RecoveryOption] = field(default_factory=list)
    recommended_action: RecommendedAction | None = None
    proposal: ApprovalProposal | None = None
    summary: str | None = None
    affected_assets: list[str] = field(default_factory=list)
    unaffected_assets: list[str] = field(default_factory=list)
    root_cause_candidates: list[str] = field(default_factory=list)
    simulator_ranking: list[dict[str, Any]] = field(default_factory=list)
    limitations: list[str] = field(default_factory=list)
    rejected_claims: list[str] = field(default_factory=list)
    error: InvestigationError | None = None
    analysis_complete: bool = False
    model_provider: str = "unknown"
    model_id: str = "unknown"
    data_source: str = "unknown"

    @staticmethod
    def new_id() -> str:
        return f"INV-{uuid.uuid4().hex[:8].upper()}"

    # ------------------------------------------------------------------ events
    def emit(self, type_: str, message: str, **data: Any) -> InvestigationEvent:
        event = InvestigationEvent(seq=len(self.events) + 1, timestamp=now_utc(), type=type_, message=message, data=data)
        self.events.append(event)
        return event

    # ------------------------------------------------------------------ state machine
    def transition(self, new: InvestigationState, reason: str = "") -> None:
        if not can_transition(self.state, new):
            raise InvalidTransition(f"{self.state.value} -> {new.value}")
        old, self.state = self.state, new
        if new in TERMINAL:
            self.completed_at = now_utc()
        self.emit("state_changed", f"{old.value} -> {new.value}" + (f": {reason}" if reason else ""), from_state=old.value, to_state=new.value)

    def advance(self, new: InvestigationState, reason: str = "") -> None:
        """Move forward if that is a legal move; silently ignore requests that would go backwards."""
        if can_transition(self.state, new):
            self.transition(new, reason)

    def fail(self, code: str, message: str) -> None:
        self.error = InvestigationError(code=code, message=message[:500])
        self.analysis_complete = False
        if self.state not in TERMINAL:
            self.transition(S.FAILED, code)
        self.emit("investigation_failed", message[:300], code=code)

    # ------------------------------------------------------------------ trace
    def trace(self) -> list[str]:
        if not self.events:
            return []
        t0 = self.events[0].timestamp
        out = []
        for e in self.events:
            if e.type in {"state_changed"}:
                continue
            secs = int((e.timestamp - t0).total_seconds())
            out.append(f"[{secs // 60:02d}:{secs % 60:02d}] {e.message}")
        return out
