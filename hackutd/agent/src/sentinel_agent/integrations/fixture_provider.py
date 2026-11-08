"""FixtureProvider: reads local synthetic data. Contains NO ground truth (that lives under tests/)."""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from ..models import (
    DATA_SOURCE_FIXTURE,
    Asset,
    Dependency,
    EvidenceRecord,
    Incident,
    Provenance,
)
from ..security.untrusted_content import flag_text, sanitize_text
from .data_provider import DataProvider, ProviderError

FIXTURE_DIR = Path(__file__).resolve().parent.parent / "fixtures"
_AST_RE = re.compile(r"^AST-(INC-[A-Za-z0-9]+)-([a-z0-9][a-z0-9-]+)$")
_TERM_RE = re.compile(r"[\w.\-]+")


def _load(name: str, directory: Path) -> Any:
    path = directory / name
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ProviderError(f"cannot load fixture {name}: {exc}") from exc


class FixtureProvider(DataProvider):
    name = "fixture"
    data_source = DATA_SOURCE_FIXTURE

    def __init__(self, directory: Path | None = None):
        directory = directory or FIXTURE_DIR
        self._assets = [Asset.model_validate(a) for a in _load("assets.json", directory)]
        self._deps = [Dependency.model_validate(d) for d in _load("dependencies.json", directory)]
        self._incidents = {i.incident_id: i for i in map(Incident.model_validate, _load("incidents.json", directory))}
        self._evidence: dict[str, EvidenceRecord] = {}
        for raw in _load("logs.json", directory):
            record = self._log_to_evidence(raw)
            if record.evidence_id in self._evidence:
                raise ProviderError(f"duplicate evidence id {record.evidence_id}")
            self._evidence[record.evidence_id] = record
        for edge in self._deps:
            self._evidence[edge.dependency_id] = self._dependency_to_evidence(edge)
        self._asset_ids = {a.asset_id for a in self._assets}

    # ------------------------------------------------------------------ conversion
    @staticmethod
    def _log_to_evidence(raw: dict[str, Any]) -> EvidenceRecord:
        summary = sanitize_text(raw["message"])
        return EvidenceRecord(
            evidence_id=raw["evidence_id"],
            kind="log_event",
            source=raw["source"],
            timestamp=raw["timestamp"],
            asset_id=raw["asset_id"],
            event_type=raw["event_type"],
            summary=summary,
            severity=raw.get("severity"),
            reliability=raw.get("reliability", "unknown"),
            reliability_basis=raw.get("reliability_basis"),
            provenance=Provenance(record_ref=f"logs.json#{raw['evidence_id']}"),
            content_flags=flag_text(summary),
        )

    @staticmethod
    def _dependency_to_evidence(edge: Dependency) -> EvidenceRecord:
        return EvidenceRecord(
            evidence_id=edge.dependency_id,
            kind="dependency",
            source="infrastructure-model",
            asset_id=edge.from_asset_id,
            event_type="dependency_edge",
            summary=sanitize_text(
                f"{edge.from_asset_id} depends on {edge.to_asset_id} ({edge.kind.value}). {edge.description}"
            ),
            reliability="high",
            reliability_basis="configuration model of the simulated infrastructure",
            provenance=Provenance(record_ref=f"dependencies.json#{edge.dependency_id}"),
        )

    # ------------------------------------------------------------------ interface
    async def get_incident(self, incident_id: str) -> Incident | None:
        return self._incidents.get(incident_id)

    async def list_incidents(self) -> list[Incident]:
        return sorted(self._incidents.values(), key=lambda i: i.incident_id)

    async def list_assets(self) -> list[Asset]:
        return list(self._assets)

    async def list_dependencies(self) -> list[Dependency]:
        return list(self._deps)

    async def get_logs(self, asset_id, start, end, limit):
        rows = [
            r for r in self._evidence.values()
            if r.kind == "log_event" and r.asset_id == asset_id and _in_range(r.timestamp, start, end)
        ]
        rows.sort(key=lambda r: (r.timestamp, r.evidence_id))
        return rows[-limit:] if limit > 0 else []

    async def search_events(self, query, asset_ids, start, end, limit):
        terms = [t for t in _TERM_RE.findall(query.lower()) if len(t) >= 2][:8]
        if not terms:
            return []
        scored: list[tuple[int, EvidenceRecord]] = []
        for rec in self._evidence.values():
            if rec.kind != "log_event":
                continue
            if asset_ids and rec.asset_id not in asset_ids:
                continue
            if not _in_range(rec.timestamp, start, end):
                continue
            haystack = f"{rec.summary} {rec.event_type} {rec.source} {rec.asset_id}".lower()
            score = sum(1 for t in terms if t in haystack)
            if score:
                scored.append((score, rec))
        scored.sort(key=lambda p: (-p[0], p[1].timestamp, p[1].evidence_id))
        return [rec for _, rec in scored[:limit]]

    async def get_evidence(self, evidence_id: str) -> EvidenceRecord | None:
        if evidence_id in self._evidence:
            return self._evidence[evidence_id]
        match = _AST_RE.match(evidence_id)
        if match:
            return await self.get_asset_state_evidence(match.group(1), match.group(2))
        return None

    async def get_asset_state_evidence(self, incident_id: str, asset_id: str) -> EvidenceRecord | None:
        incident = self._incidents.get(incident_id)
        if incident is None or asset_id not in self._asset_ids:
            return None
        observed = await self.get_observed_state(incident, asset_id)
        asset = await self.get_asset(asset_id)
        note = f" ({observed.note})" if observed.note else ""
        return EvidenceRecord(
            evidence_id=f"AST-{incident_id}-{asset_id}",
            kind="asset_state",
            source="asset-state-snapshot",
            timestamp=observed.observed_at,
            asset_id=asset_id,
            event_type="asset_status_observation",
            summary=sanitize_text(f"{asset.display_name} observed {observed.status.value} during {incident_id}{note}."),
            reliability="high",
            reliability_basis="state snapshot of the simulated infrastructure",
            provenance=Provenance(record_ref=f"incidents.json#{incident_id}/observed_asset_states/{asset_id}"),
        )


def _in_range(ts: datetime | None, start: datetime | None, end: datetime | None) -> bool:
    if ts is None:
        return False
    return (start is None or ts >= start) and (end is None or ts <= end)
