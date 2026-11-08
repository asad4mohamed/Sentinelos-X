"""Asset state tool."""

from __future__ import annotations

from ..timeutil import iso_z
from .base import ToolContext, ToolFailure, ToolOutput, ToolSpec
from .incident_tools import AssetArgs


async def get_asset_status(ctx: ToolContext, args: AssetArgs) -> ToolOutput:
    asset = ctx.graph.assets.get(args.asset_id)
    if asset is None:
        raise ToolFailure("ASSET_NOT_FOUND", f"unknown asset {args.asset_id}")
    observed = await ctx.provider.get_observed_state(ctx.incident, args.asset_id)
    evidence = await ctx.provider.get_asset_state_evidence(ctx.incident_id, args.asset_id)
    data = {
        "asset": {
            "asset_id": asset.asset_id,
            "display_name": asset.display_name,
            "asset_type": asset.asset_type,
            "criticality": asset.criticality.value,
            "baseline_status": asset.status.value,
            "last_status_update": iso_z(asset.last_status_update),
            "source_label": asset.source_label,
        },
        "observed_status_during_incident": {
            "status": observed.status.value,
            "observed_at": iso_z(observed.observed_at),
            "note": observed.note,
        },
        "incident_id": ctx.incident_id,
    }
    return ToolOutput(
        data=data,
        evidence=[evidence] if evidence else [],
        summary=f"{asset.asset_id} observed {observed.status.value}",
    )


TOOLS = [
    ToolSpec(
        "get_asset_status",
        "Get one virtual asset's metadata and its observed operational status (healthy/degraded/unavailable) during this incident.",
        AssetArgs,
        get_asset_status,
    ),
]
