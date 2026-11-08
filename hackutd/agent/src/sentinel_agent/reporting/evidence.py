"""Evidence ledger and citation validation.

A citation is valid only if (1) the id exists in the data provider AND (2) this investigation actually retrieved
it through a tool call. The model therefore cannot cite fabricated ids, nor ids it never looked at.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from ..integrations.data_provider import DataProvider
from ..models import EVIDENCE_ID_PATTERN, EvidenceRecord, EvidenceSummary

_ID_RE = re.compile(EVIDENCE_ID_PATTERN)


@dataclass
class CitationCheck:
    valid: list[str] = field(default_factory=list)
    fabricated: list[str] = field(default_factory=list)  # does not exist in the provider (or malformed)
    unseen: list[str] = field(default_factory=list)  # exists, but this investigation never retrieved it

    @property
    def ok(self) -> bool:
        return not self.fabricated and not self.unseen

    def problems(self) -> list[str]:
        out = []
        if self.fabricated:
            out.append(f"evidence ids do not exist: {self.fabricated}")
        if self.unseen:
            out.append(f"evidence ids exist but were never retrieved in this investigation: {self.unseen}")
        return out


class EvidenceLedger:
    def __init__(self, provider: DataProvider):
        self._provider = provider
        self._seen: dict[str, EvidenceRecord] = {}
        self._retrieved_by: dict[str, list[int]] = {}

    def register(self, records: list[EvidenceRecord], tool_seq: int) -> list[str]:
        ids = []
        for rec in records:
            self._seen.setdefault(rec.evidence_id, rec)
            calls = self._retrieved_by.setdefault(rec.evidence_id, [])
            if tool_seq not in calls:
                calls.append(tool_seq)
            ids.append(rec.evidence_id)
        return ids

    def has_seen(self, evidence_id: str) -> bool:
        return evidence_id in self._seen

    def get(self, evidence_id: str) -> EvidenceRecord | None:
        return self._seen.get(evidence_id)

    @property
    def count(self) -> int:
        return len(self._seen)

    async def check(self, ids: list[str]) -> CitationCheck:
        result = CitationCheck()
        for eid in dict.fromkeys(ids):  # de-dupe, keep order
            if not isinstance(eid, str) or not _ID_RE.fullmatch(eid):
                result.fabricated.append(str(eid)[:60])
            elif eid in self._seen:
                result.valid.append(eid)
            elif await self._provider.get_evidence(eid) is not None:
                result.unseen.append(eid)
            else:
                result.fabricated.append(eid)
        return result

    def summaries(self) -> list[EvidenceSummary]:
        return [
            EvidenceSummary(evidence=rec, retrieved_by_tool_calls=sorted(self._retrieved_by[eid]))
            for eid, rec in sorted(self._seen.items())
        ]
