"""Deterministic simulation tools. The model chooses inputs; the simulator computes the outputs."""

from __future__ import annotations

from pydantic import Field

from ..models import INCIDENT_ID_PATTERN, ASSET_ID_PATTERN, AssetStatus, StrategyName
from ..simulation.propagation import blast_radius, root_cause_candidates
from ..simulation.recovery import SimulationError, simulate_strategy
from .base import ToolArgs, ToolContext, ToolFailure, ToolOutput, ToolSpec
from .incident_tools import AssetArgs


def observed_statuses(ctx: ToolContext) -> dict[str, AssetStatus]:
    return {a: ctx.incident.observed_asset_states[a].status if a in ctx.incident.observed_asset_states else AssetStatus.HEALTHY for a in ctx.graph.assets}


class SimulateArgs(ToolArgs):
    incident_id: str = Field(pattern=INCIDENT_ID_PATTERN)
    strategy: StrategyName = Field(description="One of the strategies listed in the incident's available_recovery_options")
    target_asset_id: str | None = Field(default=None, pattern=ASSET_ID_PATTERN, description="Required when the strategy is offered for more than one asset")


async def calculate_blast_radius(ctx: ToolContext, args: AssetArgs) -> ToolOutput:
    if not ctx.graph.has_asset(args.asset_id):
        raise ToolFailure("ASSET_NOT_FOUND", f"unknown asset {args.asset_id}")
    br = blast_radius(ctx.graph, args.asset_id)
    observed = observed_statuses(ctx)
    edge_ids = {c["edge_id"] for step in br.impacted for c in step.caused_by}
    evidence = [r for eid in sorted(edge_ids) if (r := await ctx.provider.get_evidence(eid))]
    data = {
        "asset_id": args.asset_id,
        "hypothetical": f"{args.asset_id} fails (unavailable) on an otherwise healthy infrastructure",
        "impacted_assets": [s.model_dump(mode="json") for s in br.impacted],
        "impacted_by_status": br.impacted_by_status,
        "unaffected_assets": br.unaffected,
        "critical_assets_impacted": br.critical_assets_impacted,
        "dependency_cycles": br.cycles,
        "current_observed_non_healthy_assets": sorted(a for a, s in observed.items() if s != AssetStatus.HEALTHY),
        "root_cause_candidates_from_observed_state": root_cause_candidates(ctx.graph, observed),
        "note": "Computed by the deterministic propagation engine from the dependency graph, not by the model.",
    }
    return ToolOutput(data=data, evidence=evidence, summary=f"{len(br.impacted)} assets impacted if {args.asset_id} fails")


async def simulate_recovery_strategy(ctx: ToolContext, args: SimulateArgs) -> ToolOutput:
    offered = [c for c in ctx.incident.candidate_strategies if c.strategy == args.strategy]
    if args.target_asset_id is not None:
        offered = [c for c in offered if c.target_asset_id == args.target_asset_id]
    if not offered:
        listing = [f"{c.strategy.value}:{c.target_asset_id}" for c in ctx.incident.candidate_strategies]
        raise ToolFailure("STRATEGY_NOT_AVAILABLE", f"strategy/target not offered for this incident; offered: {listing}")
    if len(offered) > 1:
        targets = [c.target_asset_id for c in offered]
        raise ToolFailure("AMBIGUOUS_TARGET", f"strategy offered for several targets {targets}; pass target_asset_id")
    spec = offered[0]
    try:
        option = simulate_strategy(ctx.graph, observed_statuses(ctx), spec)
    except SimulationError as exc:
        raise ToolFailure("SIMULATION_FAILED", str(exc)) from exc
    ctx.simulations[(spec.strategy.value, spec.target_asset_id)] = option
    data = {
        "incident_id": ctx.incident_id,
        "simulation": option.model_dump(mode="json"),
        "note": "Deterministic simulation. Assumptions are scenario assumptions, not measured facts. No action was executed.",
    }
    return ToolOutput(
        data=data,
        summary=f"{spec.strategy.value}({spec.target_asset_id}): {option.status_counts}",
    )


TOOLS = [
    ToolSpec(
        "calculate_blast_radius",
        "Compute which assets would be degraded or unavailable if the given asset failed, using the dependency graph (deterministic). Also lists root-cause candidates implied by the observed state.",
        AssetArgs,
        calculate_blast_radius,
    ),
    ToolSpec(
        "simulate_recovery_strategy",
        "Run the deterministic simulator for one recovery strategy and return resulting asset states, restored/regressed counts, critical services affected, assumptions and tradeoffs. Nothing is executed.",
        SimulateArgs,
        simulate_recovery_strategy,
    ),
]
