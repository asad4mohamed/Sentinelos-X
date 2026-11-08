"""Audit trail for security-relevant decisions (denied actions, flagged content, approvals)."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any

from ..models import StrictModel
from ..timeutil import UTCDatetime, now_utc

logger = logging.getLogger("sentinel_agent.audit")

_SECRET_PATTERNS = [
    re.compile(r"nvapi-[A-Za-z0-9_\-]{8,}"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]{12,}"),
    re.compile(r"(?i)(api[_-]?key|token|secret|password)(\"?\s*[:=]\s*\"?)[^\s\",}]{6,}"),
]


def redact(text: str) -> str:
    """Mask anything that looks like a credential."""
    out = text
    out = _SECRET_PATTERNS[0].sub("nvapi-[REDACTED]", out)
    out = _SECRET_PATTERNS[1].sub("Bearer [REDACTED]", out)
    out = _SECRET_PATTERNS[2].sub(lambda m: f"{m.group(1)}{m.group(2)}[REDACTED]", out)
    return out


class AuditRecord(StrictModel):
    timestamp: UTCDatetime
    event: str  # tool_denied | injection_flagged | evidence_rejected | approval_denied | approval_granted | ...
    investigation_id: str | None = None
    actor: str | None = None
    detail: dict[str, Any] = {}


@dataclass
class AuditLog:
    records: list[AuditRecord] = field(default_factory=list)
    max_records: int = 5000

    def record(self, event: str, *, investigation_id: str | None = None, actor: str | None = None, **detail: Any) -> AuditRecord:
        safe_detail = {k: (redact(v) if isinstance(v, str) else v) for k, v in detail.items()}
        rec = AuditRecord(timestamp=now_utc(), event=event, investigation_id=investigation_id, actor=actor, detail=safe_detail)
        self.records.append(rec)
        if len(self.records) > self.max_records:
            del self.records[: len(self.records) - self.max_records]
        logger.info("audit", extra={"audit": rec.model_dump(mode="json")})
        return rec

    def find(self, event: str | None = None, investigation_id: str | None = None) -> list[AuditRecord]:
        return [
            r
            for r in self.records
            if (event is None or r.event == event)
            and (investigation_id is None or r.investigation_id == investigation_id)
        ]
