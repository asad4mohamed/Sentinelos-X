"""Incident-centric tools: details, timeline, related incidents, evidence lookup."""

from __future__ import annotations

from pydantic import Field

from ..models import EVIDENCE_ID_PATTERN, INCIDENT_ID_PATTERN, ASSET_ID_PATTERN
from ..security.untrusted_content import sanitize_text
from .base import ToolArgs, ToolContext, ToolFailure, ToolOutput, ToolSpec


class IncidentArgs(ToolArgs):
    incident_id: str = Field(pattern=INCIDENT_ID_PATTERN, description="Incident id, e.g. INC-001")


class AssetArgs(ToolArgs):
    asset_id: str = Field(pattern=ASSET_ID_PATTERN, description="Asset id, e.g. primary-database")


class EvidenceArgs(ToolArgs):
    evidence_id: str = Field(pattern=EVIDENCE_ID_PATTERN, description="Evidence id such as EVT-001, DEP-003 or AST-INC-001-file-storage")


async def get_incident_details(ctx: ToolContext, args: IncidentArgs) -> ToolOutput:
    inc = ctx.incident
    data = {
        "incident": {
            "incident_id": inc.incident_id,
            "title": sanitize_text(inc.title, 200),
            "description": sanitize_text(inc.description, 800),
            "status": inc.status,
            "severity": inc.severity,
            "detected_at": inc.detected_at.isoformat().replace("+00:00", "Z"),
            "window": {
                "start": inc.window_start.isoformat().replace("+00:00", "Z"),
                "end": inc.window_end.isoformat().replace("+00:00", "Z"),
            },
            "reported_by": inc.reported_by,
            "primary_asset_ids": inc.primary_asset_ids,
            "observed_non_healthy_assets": {
                a: s.status.value for a, s in inc.observed_asset_states.items() if s.status.value != "healthy"
            },
            "triage_hypotheses": [h.model_dump() for h in inc.triage_hypotheses],
            "available_recovery_options": [
                {"strategy": c.strategy.value, "target_asset_id": c.target_asset_id} for c in inc.candidate_strategies
            ],
            "data_source": inc.data_source,
        }
    }
    return ToolOutput(data=data, summary=f"incident {inc.incident_id}")


async def get_incident_timeline(ctx: ToolContext, args: IncidentArgs) -> ToolOutput:
    inc = ctx.incident
    entries = []
    evidence = []
    seen: set[str] = set()
    for entry in sorted(inc.timeline, key=lambda e: e.time):
        entries.append(
            {
                "time": entry.time.isoformat().replace("+00:00", "Z"),
                "description": sanitize_text(entry.description, 300),
                "evidence_ids": entry.evidence_ids,
            }
        )
        for eid in entry.evidence_ids:
            if eid not in seen:
                seen.add(eid)
                rec = await ctx.provider.get_evidence(eid)
                if rec is not None:
                    evidence.append(rec)
    return ToolOutput(data={"incident_id": inc.incident_id, "entries": entries}, evidence=evidence, summary=f"{len(entries)} timeline entries")


async def get_related_incidents(ctx: ToolContext, args: AssetArgs) -> ToolOutput:
    if not ctx.graph.has_asset(args.asset_id):
        raise ToolFailure("ASSET_NOT_FOUND", f"unknown asset {args.asset_id}")
    related = []
    for inc in await ctx.provider.list_incidents():
        if inc.incident_id == ctx.incident_id:
            continue
        touches = args.asset_id in inc.primary_asset_ids or any(
            a == args.asset_id and s.status.value != "healthy" for a, s in inc.observed_asset_states.items()
        )
        if touches:
            related.append(
                {
                    "incident_id": inc.incident_id,
                    "title": sanitize_text(inc.title, 200),
                    "summary": sanitize_text(inc.description, 400),
                    "status": inc.status,
                    "severity": inc.severity,
                    "detected_at": inc.detected_at.isoformat().replace("+00:00", "Z"),
                    "historical": inc.historical,
                }
            )
    return ToolOutput(data={"asset_id": args.asset_id, "related_incidents": related}, summary=f"{len(related)} related incidents")


async def get_evidence_record(ctx: ToolContext, args: EvidenceArgs) -> ToolOutput:
    rec = await ctx.provider.get_evidence(args.evidence_id)
    if rec is None:
        raise ToolFailure("EVIDENCE_NOT_FOUND", f"no evidence record {args.evidence_id}")
    return ToolOutput(data={"evidence_id": rec.evidence_id}, evidence=[rec], summary=rec.evidence_id)


TOOLS = [
    ToolSpec("get_incident_details", "Get the incident record: severity, time window, observed non-healthy assets, triage hypotheses and the recovery options available for simulation. Start here.", IncidentArgs, get_incident_details),
    ToolSpec("get_incident_timeline", "Get the incident's timeline of alert milestones, each linked to evidence ids. Returns the referenced evidence records.", IncidentArgs, get_incident_timeline),
    ToolSpec("get_related_incidents", "List other (often historical) incidents that involved the given asset.", AssetArgs, get_related_incidents),
    ToolSpec("get_evidence_record", "Fetch one evidence record by id (EVT-*, DEP-*, AST-*). Use it to verify an id before citing it.", EvidenceArgs, get_evidence_record),
]
