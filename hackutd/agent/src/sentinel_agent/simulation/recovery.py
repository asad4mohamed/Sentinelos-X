"""Deterministic recovery simulator. Independent of any language model.

The model may pick a strategy; this module computes the consequences. Outcomes of the target action
(e.g. "does a restart fix it?") are scenario assumptions carried in `CandidateStrategy`, never measurements.
No durations or costs are produced.
"""

from __future__ import annotations

from typing import Any

from ..models import (
    STATUS_RANK,
    AssetOutcome,
    AssetStatus,
    CandidateStrategy,
    RecoveryOption,
    StrategyName,
)
from .graph import InfraGraph
from .propagation import derive_intrinsic, propagate

H, D, U = AssetStatus.HEALTHY, AssetStatus.DEGRADED, AssetStatus.UNAVAILABLE


class SimulationError(ValueError):
    pass


def _lateral_paths(graph: InfraGraph, target: str | None) -> list[str]:
    if target is None:
        return []
    return sorted(graph.edge_label(e) for e in graph.edges_touching(target))


def simulate_strategy(
    graph: InfraGraph,
    observed: dict[str, AssetStatus],
    spec: CandidateStrategy,
) -> RecoveryOption:
    strategy, target = spec.strategy, spec.target_asset_id
    if strategy != StrategyName.MAINTAIN and (target is None or not graph.has_asset(target)):
        raise SimulationError(f"strategy {strategy.value} needs a valid target_asset_id")
    if target is not None and not graph.has_asset(target):
        raise SimulationError(f"unknown target asset {target}")

    before = {a: observed.get(a, H) for a in graph.assets}
    intrinsic = derive_intrinsic(graph, before)
    warnings: list[str] = []
    baseline = propagate(graph, intrinsic)
    for asset_id in sorted(graph.assets):
        if baseline.effective[asset_id] != before[asset_id]:
            warnings.append(
                f"model of dependencies predicts {asset_id}={baseline.effective[asset_id].value} "
                f"but observed {before[asset_id].value}"
            )

    # preconditions (scenario-defined): required assets must not be unavailable right now
    executable = True
    notes: list[str] = []
    for required in spec.requires_operational:
        if not graph.has_asset(required):
            raise SimulationError(f"unknown precondition asset {required}")
        if before[required] == U:
            executable = False
            notes.append(f"precondition failed: {required} is unavailable")
        else:
            notes.append(f"precondition met: {required} is {before[required].value}")

    modified = dict(intrinsic)
    isolated: list[str] = []
    if executable:
        if strategy == StrategyName.MAINTAIN:
            pass
        elif strategy == StrategyName.RESTART:
            if spec.assumed_restart_resolves:
                modified[target] = H
                notes.append("assumption: restart clears the target's own fault")
            else:
                notes.append("assumption: restart does not clear the target's own fault")
        elif strategy == StrategyName.ISOLATE:
            modified[target] = U
            isolated = [target]
            notes.append("isolated asset is treated as unavailable to every dependent")
        elif strategy == StrategyName.RESTORE:
            modified[target] = H
            notes.append("assumption: restoration succeeds")
        elif strategy == StrategyName.SWITCH_BACKUP:
            modified[target] = D
            notes.append("assumption: backup replica is stale, so the target is degraded not healthy")
    else:
        notes.append("strategy cannot be executed; state is unchanged")

    after_result = propagate(graph, modified)
    after = after_result.effective

    outcomes: list[AssetOutcome] = []
    for asset_id in sorted(graph.assets):
        b, a = before[asset_id], after[asset_id]
        change = "unchanged"
        if STATUS_RANK[a] < STATUS_RANK[b]:
            change = "improved"
        elif STATUS_RANK[a] > STATUS_RANK[b]:
            change = "worsened"
        asset = graph.assets[asset_id]
        outcomes.append(
            AssetOutcome(
                asset_id=asset_id,
                display_name=asset.display_name,
                criticality=asset.criticality,
                before=b,
                after=a,
                changed=change,
            )
        )

    operational = sorted(a for a, s in after.items() if s == H)
    degraded = sorted(a for a, s in after.items() if s == D)
    unavailable = sorted(a for a, s in after.items() if s == U)
    critical_affected = sorted(
        a for a, s in after.items() if s != H and graph.assets[a].criticality.value == "critical"
    )
    lateral = _lateral_paths(graph, target) if strategy != StrategyName.MAINTAIN else []
    severed = lateral if (executable and strategy == StrategyName.ISOLATE) else []
    still_open = [] if severed else lateral

    return RecoveryOption(
        strategy=strategy,
        target_asset_id=target,
        executable=executable,
        precondition_notes=notes,
        assets_operational=operational,
        assets_degraded=degraded,
        assets_unavailable=unavailable,
        status_counts={"operational": len(operational), "degraded": len(degraded), "unavailable": len(unavailable)},
        restored_services=sum(1 for o in outcomes if o.changed == "improved"),
        regressed_services=sum(1 for o in outcomes if o.changed == "worsened"),
        critical_services_affected=critical_affected,
        isolated_assets=isolated,
        open_lateral_paths=still_open,
        severed_lateral_paths=severed,
        asset_outcomes=outcomes,
        propagation=after_result.steps,
        assumptions=list(spec.assumptions),
        tradeoffs=list(spec.tradeoffs),
        chart=_chart(graph, before, after),
        warnings=warnings,
    )


def _chart(graph: InfraGraph, before: dict[str, AssetStatus], after: dict[str, AssetStatus]) -> dict[str, Any]:
    ids = sorted(graph.assets)
    levels = {"healthy": 0, "degraded": 1, "unavailable": 2}
    return {
        "status_levels": levels,
        "assets": ids,
        "labels": [graph.assets[a].display_name for a in ids],
        "before": [levels[before[a].value] for a in ids],
        "after": [levels[after[a].value] for a in ids],
        "counts_before": {k: sum(1 for a in ids if before[a].value == k) for k in levels},
        "counts_after": {k: sum(1 for a in ids if after[a].value == k) for k in levels},
    }


def rank_options(options: list[RecoveryOption]) -> list[dict[str, Any]]:
    """Order options by service impact only (fewest critical outages first). It deliberately ignores forensic
    value, data-loss risk and containment, which the assumptions/tradeoffs describe; a human decides."""

    def key(o: RecoveryOption):
        critical_unavailable = sum(1 for a in o.critical_services_affected if a in o.assets_unavailable)
        return (
            0 if o.executable else 1,
            critical_unavailable,
            len(o.assets_unavailable),
            len(o.critical_services_affected),
            len(o.assets_degraded),
            o.strategy.value,
            o.target_asset_id or "",
        )

    ordered = sorted(options, key=key)
    return [
        {
            "rank": i + 1,
            "strategy": o.strategy.value,
            "target_asset_id": o.target_asset_id,
            "executable": o.executable,
            "status_counts": o.status_counts,
            "critical_services_affected": o.critical_services_affected,
            "basis": "service impact only; excludes forensic value, data loss and containment",
        }
        for i, o in enumerate(ordered)
    ]
