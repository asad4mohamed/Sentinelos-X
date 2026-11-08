"""Deterministic failure propagation.

Rules (a dependent A with edge A -> B):
    critical edge:  B unavailable => A unavailable;  B degraded => A degraded
    optional edge:  B unavailable => A degraded;     B degraded => A unaffected

effective(A) = worst(intrinsic(A), contributions from every dependency).
The function is monotone over a finite 3-level lattice, so a fixpoint iteration always terminates,
including on cyclic graphs, and the result does not depend on iteration order.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..models import STATUS_RANK, AssetStatus, Dependency, DependencyKind, PropagationStep
from .graph import InfraGraph

H, D, U = AssetStatus.HEALTHY, AssetStatus.DEGRADED, AssetStatus.UNAVAILABLE


def worst(*statuses: AssetStatus) -> AssetStatus:
    return max(statuses, key=lambda s: STATUS_RANK[s])


def edge_contribution(kind: DependencyKind, dependency_status: AssetStatus) -> AssetStatus:
    if dependency_status == H:
        return H
    if kind == DependencyKind.CRITICAL:
        return dependency_status
    return D if dependency_status == U else H  # optional edge


@dataclass
class PropagationResult:
    effective: dict[str, AssetStatus]
    intrinsic: dict[str, AssetStatus]
    steps: list[PropagationStep] = field(default_factory=list)
    cycles: list[list[str]] = field(default_factory=list)
    iterations: int = 0


def propagate(graph: InfraGraph, intrinsic: dict[str, AssetStatus]) -> PropagationResult:
    unknown = set(intrinsic) - set(graph.assets)
    if unknown:
        raise ValueError(f"unknown assets in intrinsic state: {sorted(unknown)}")
    base = {a: intrinsic.get(a, H) for a in graph.assets}
    effective = dict(base)
    max_iterations = len(graph.assets) * 2 + 2  # lattice height (2) * nodes bounds the monotone fixpoint
    iterations = 0
    changed = True
    while changed and iterations < max_iterations:
        changed = False
        iterations += 1
        for asset_id in sorted(graph.assets):
            new = base[asset_id]
            for edge in graph.dependencies_of(asset_id):
                new = worst(new, edge_contribution(edge.kind, effective[edge.to_asset_id]))
            if STATUS_RANK[new] > STATUS_RANK[effective[asset_id]]:
                effective[asset_id] = new
                changed = True
    steps: list[PropagationStep] = []
    for asset_id in sorted(graph.assets):
        if effective[asset_id] == H or STATUS_RANK[effective[asset_id]] <= STATUS_RANK[base[asset_id]]:
            continue
        causes = []
        for edge in graph.dependencies_of(asset_id):
            contribution = edge_contribution(edge.kind, effective[edge.to_asset_id])
            if contribution == effective[asset_id]:
                causes.append(
                    {
                        "dependency": edge.to_asset_id,
                        "edge_id": edge.dependency_id,
                        "kind": edge.kind.value,
                        "dependency_status": effective[edge.to_asset_id].value,
                    }
                )
        steps.append(PropagationStep(asset_id=asset_id, status=effective[asset_id], caused_by=causes))
    return PropagationResult(
        effective=effective, intrinsic=base, steps=steps, cycles=graph.detect_cycles(), iterations=iterations
    )


def derive_intrinsic(graph: InfraGraph, observed: dict[str, AssetStatus]) -> dict[str, AssetStatus]:
    """Split observed (effective) states into the part that dependencies already explain and the
    asset's own fault. An asset keeps its observed status as an own fault only when no dependency outside its
    cycle accounts for it. Members of a dependency cycle never explain each other (otherwise a faulty cycle
    would look self-explained and vanish)."""
    states = {a: observed.get(a, H) for a in graph.assets}
    intrinsic: dict[str, AssetStatus] = {}
    for asset_id, status in states.items():
        if status == H:
            intrinsic[asset_id] = H
            continue
        own_cycle = graph.cyclic_component_of(asset_id)
        contribution = H
        for edge in graph.dependencies_of(asset_id):
            if edge.to_asset_id in own_cycle and len(own_cycle) > 1:
                continue
            if edge.to_asset_id == asset_id:
                continue
            contribution = worst(contribution, edge_contribution(edge.kind, states[edge.to_asset_id]))
        intrinsic[asset_id] = status if STATUS_RANK[contribution] < STATUS_RANK[status] else H
    return intrinsic


def root_cause_candidates(graph: InfraGraph, observed: dict[str, AssetStatus]) -> list[str]:
    intrinsic = derive_intrinsic(graph, observed)
    return sorted(a for a, s in intrinsic.items() if s != H)


@dataclass
class BlastRadius:
    asset_id: str
    assumed_status: AssetStatus
    impacted: list[PropagationStep]
    impacted_by_status: dict[str, list[str]]
    unaffected: list[str]
    critical_assets_impacted: list[str]
    cycles: list[list[str]]


def blast_radius(graph: InfraGraph, asset_id: str, failure: AssetStatus = U) -> BlastRadius:
    """Hypothetical: assume only `asset_id` fails (on an otherwise healthy graph) and compute who is impacted."""
    if not graph.has_asset(asset_id):
        raise KeyError(asset_id)
    result = propagate(graph, {asset_id: failure})
    impacted = [s for s in result.steps if s.asset_id != asset_id]
    by_status: dict[str, list[str]] = {"degraded": [], "unavailable": []}
    for step in impacted:
        by_status[step.status.value].append(step.asset_id)
    impacted_ids = {s.asset_id for s in impacted} | {asset_id}
    critical = sorted(
        a for a in impacted_ids if graph.assets[a].criticality.value == "critical" and a != asset_id
    )
    return BlastRadius(
        asset_id=asset_id,
        assumed_status=failure,
        impacted=impacted,
        impacted_by_status={k: sorted(v) for k, v in by_status.items()},
        unaffected=sorted(a for a in graph.assets if a not in impacted_ids),
        critical_assets_impacted=critical,
        cycles=result.cycles,
    )
