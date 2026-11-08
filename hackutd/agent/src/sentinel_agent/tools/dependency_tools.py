"""Dependency graph tool. Edge A -> B always means 'A depends on B'."""

from __future__ import annotations

from .base import ToolContext, ToolFailure, ToolOutput, ToolSpec
from .incident_tools import AssetArgs
from .simulation_tools import observed_statuses


async def get_infrastructure_dependencies(ctx: ToolContext, args: AssetArgs) -> ToolOutput:
    g = ctx.graph
    if not g.has_asset(args.asset_id):
        raise ToolFailure("ASSET_NOT_FOUND", f"unknown asset {args.asset_id}")
    status = observed_statuses(ctx)
    depends_on = [
        {"asset_id": e.to_asset_id, "kind": e.kind.value, "edge_id": e.dependency_id, "observed_status": status[e.to_asset_id].value}
        for e in g.dependencies_of(args.asset_id)
    ]
    depended_on_by = [
        {"asset_id": e.from_asset_id, "kind": e.kind.value, "edge_id": e.dependency_id, "observed_status": status[e.from_asset_id].value}
        for e in g.dependents_of(args.asset_id)
    ]
    evidence = []
    for e in g.edges_touching(args.asset_id):
        rec = await ctx.provider.get_evidence(e.dependency_id)
        if rec:
            evidence.append(rec)
    data = {
        "asset_id": args.asset_id,
        "edge_semantics": "an edge A->B means A depends on B; 'depends_on' lists B's, 'depended_on_by' lists A's",
        "depends_on": depends_on,
        "depended_on_by": depended_on_by,
        "transitive_dependencies": sorted(g.transitive_dependencies(args.asset_id)),
        "transitive_dependents": sorted(g.transitive_dependents(args.asset_id)),
        "dependency_cycles_in_graph": g.detect_cycles(),
    }
    return ToolOutput(data=data, evidence=evidence, summary=f"{len(depends_on)} dependencies, {len(depended_on_by)} dependents")


TOOLS = [
    ToolSpec(
        "get_infrastructure_dependencies",
        "Get what an asset depends on and what depends on it (direct and transitive), with edge kinds (critical/optional) and observed statuses. Returns DEP-* evidence.",
        AssetArgs,
        get_infrastructure_dependencies,
    ),
]
