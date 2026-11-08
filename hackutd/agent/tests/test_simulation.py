from __future__ import annotations

import pytest

from sentinel_agent.models import (
    Asset, AssetStatus as S, CandidateStrategy, Dependency, StrategyName,
)
from sentinel_agent.simulation.graph import GraphError, InfraGraph
from sentinel_agent.simulation.propagation import (
    blast_radius, derive_intrinsic, propagate, root_cause_candidates,
)
from sentinel_agent.simulation.recovery import SimulationError, rank_options, simulate_strategy
from sentinel_agent.tools.simulation_tools import observed_statuses
from sentinel_agent.tools.base import ToolContext
from conftest import fast_settings


def mk_graph(edges, assets=None):
    ids = assets or sorted({x for e in edges for x in e[:2]})
    a = [Asset(asset_id=i, display_name=i.upper(), asset_type="t", status="healthy", criticality="medium", last_status_update="2026-11-07T08:00:00Z") for i in ids]
    d = [Dependency(dependency_id=f"DEP-{n}", from_asset_id=f, to_asset_id=t, kind=k, description="x") for n, (f, t, k) in enumerate(edges)]
    return InfraGraph.build(a, d)


# ----------------------------------------------------------------------------- graph
def test_edge_direction_means_depends_on(graph):
    deps = {e.to_asset_id for e in graph.dependencies_of("application-api")}
    assert "primary-database" in deps
    assert "application-api" in {e.from_asset_id for e in graph.dependents_of("primary-database")}


def test_fixture_graph_is_acyclic(graph):
    assert graph.detect_cycles() == []


def test_graph_rejects_unknown_endpoint_and_duplicates():
    with pytest.raises(GraphError):
        mk_graph([("aa", "bb", "critical")], assets=["aa"])
    with pytest.raises(GraphError):
        mk_graph([("aa", "bb", "critical"), ("aa", "bb", "optional")])


def test_cycle_detection_and_self_loop():
    g = mk_graph([("aa", "bb", "critical"), ("bb", "cc", "critical"), ("cc", "aa", "optional"), ("dd", "dd", "optional")])
    assert g.detect_cycles() == [["aa", "bb", "cc"], ["dd"]]


# ----------------------------------------------------------------------------- propagation
def test_direct_critical_outage():
    g = mk_graph([("api", "db", "critical")])
    r = propagate(g, {"db": S.UNAVAILABLE})
    assert r.effective["api"] == S.UNAVAILABLE


def test_optional_dependency_only_degrades():
    g = mk_graph([("api", "storage", "optional")])
    assert propagate(g, {"storage": S.UNAVAILABLE}).effective["api"] == S.DEGRADED
    assert propagate(g, {"storage": S.DEGRADED}).effective["api"] == S.HEALTHY


def test_critical_degraded_degrades_dependent():
    g = mk_graph([("api", "db", "critical")])
    assert propagate(g, {"db": S.DEGRADED}).effective["api"] == S.DEGRADED


def test_cascading_outage_through_chain():
    g = mk_graph([("gw", "api", "critical"), ("api", "db", "critical")])
    r = propagate(g, {"db": S.UNAVAILABLE})
    assert r.effective == {"gw": S.UNAVAILABLE, "api": S.UNAVAILABLE, "db": S.UNAVAILABLE}
    assert {s.asset_id for s in r.steps} == {"gw", "api"}


def test_unaffected_assets_stay_healthy(graph):
    br = blast_radius(graph, "primary-database")
    assert "file-storage" in br.unaffected and "monitoring-service" in br.unaffected
    assert set(br.impacted_by_status["unavailable"]) == {"application-api", "external-gateway"}


def test_cyclic_graph_terminates_with_consistent_result():
    g = mk_graph([("aa", "bb", "critical"), ("bb", "aa", "critical"), ("cc", "aa", "critical")])
    r = propagate(g, {"aa": S.DEGRADED})
    assert r.effective == {"aa": S.DEGRADED, "bb": S.DEGRADED, "cc": S.DEGRADED}
    assert r.cycles == [["aa", "bb"]]
    # order independence: same result with the fault elsewhere in the cycle
    assert propagate(g, {"bb": S.DEGRADED}).effective["aa"] == S.DEGRADED


def test_propagation_is_deterministic(graph):
    runs = [propagate(graph, {"primary-database": S.UNAVAILABLE}).effective for _ in range(5)]
    assert all(r == runs[0] for r in runs)


def test_unknown_asset_in_intrinsic_state_rejected(graph):
    with pytest.raises(ValueError):
        propagate(graph, {"ghost": S.DEGRADED})


def test_derive_intrinsic_separates_root_from_dependents(graph):
    observed = {"primary-database": S.UNAVAILABLE, "application-api": S.UNAVAILABLE, "external-gateway": S.UNAVAILABLE}
    assert root_cause_candidates(graph, observed) == ["primary-database"]


def test_faulty_cycle_is_not_self_explained():
    g = mk_graph([("aa", "bb", "critical"), ("bb", "aa", "critical")])
    intr = derive_intrinsic(g, {"aa": S.UNAVAILABLE, "bb": S.UNAVAILABLE})
    assert intr == {"aa": S.UNAVAILABLE, "bb": S.UNAVAILABLE}


def test_dependent_with_own_fault_beyond_dependency_keeps_it():
    g = mk_graph([("api", "storage", "optional")])
    # storage down explains api degraded, but api observed unavailable => own fault
    assert derive_intrinsic(g, {"storage": S.UNAVAILABLE, "api": S.UNAVAILABLE})["api"] == S.UNAVAILABLE


# ----------------------------------------------------------------------------- ground truth vs simulator
@pytest.mark.parametrize("incident_id", ["INC-001", "INC-002", "INC-003"])
async def test_observed_state_matches_ground_truth(incident_id, make_ctx, graph, ground_truth):
    ctx = await make_ctx(incident_id)
    observed = observed_statuses(ctx)
    gt = ground_truth[incident_id]
    assert root_cause_candidates(graph, observed) == gt["root_cause_candidates"]
    assert sorted(a for a, s in observed.items() if s != S.HEALTHY) == gt["affected_assets"]
    # the dependency model fully explains the observed state: no contradictions
    assert propagate(graph, derive_intrinsic(graph, observed)).effective == observed


# ----------------------------------------------------------------------------- recovery strategies
async def sim(make_ctx, graph, incident_id, strategy, target=None):
    ctx = await make_ctx(incident_id)
    spec = next(c for c in ctx.incident.candidate_strategies if c.strategy.value == strategy and (target is None or c.target_asset_id == target))
    return simulate_strategy(graph, observed_statuses(ctx), spec)


async def test_restore_beats_maintain_inc003(make_ctx, graph):
    restore = await sim(make_ctx, graph, "INC-003", "restore_virtual_dependency")
    maintain = await sim(make_ctx, graph, "INC-003", "maintain_current_state")
    assert restore.status_counts == {"operational": 8, "degraded": 0, "unavailable": 0}
    assert restore.restored_services == 6 and restore.critical_services_affected == []
    assert maintain.restored_services == 0
    assert set(maintain.critical_services_affected) == {"application-api", "auth-service", "external-gateway", "primary-database"}


async def test_restart_assumed_not_to_resolve(make_ctx, graph):
    r = await sim(make_ctx, graph, "INC-003", "restart_virtual_service", "primary-database")
    assert r.restored_services == 0
    assert any("does not clear" in n for n in r.precondition_notes)


async def test_restarting_dependent_cannot_fix_root_cause(make_ctx, graph):
    r = await sim(make_ctx, graph, "INC-003", "restart_virtual_service", "application-api")
    assert r.restored_services == 0 and "application-api" in r.assets_unavailable


async def test_switch_to_backup_leaves_stale_target_degraded(make_ctx, graph):
    r = await sim(make_ctx, graph, "INC-003", "switch_to_simulated_backup")
    assert "primary-database" in r.assets_degraded
    assert r.assets_unavailable == []


async def test_isolation_is_proportionate_or_not(make_ctx, graph):
    admin = await sim(make_ctx, graph, "INC-002", "isolate_virtual_asset", "admin-portal")
    auth = await sim(make_ctx, graph, "INC-002", "isolate_virtual_asset", "auth-service")
    assert admin.assets_unavailable == ["admin-portal"] and admin.regressed_services == 1
    assert len(auth.assets_unavailable) == 4 and auth.regressed_services == 4
    assert auth.severed_lateral_paths and admin.isolated_assets == ["admin-portal"]


async def test_isolation_severs_lateral_paths_maintain_keeps_them(make_ctx, graph):
    iso = await sim(make_ctx, graph, "INC-001", "isolate_virtual_asset")
    assert "application-api->file-storage" in iso.severed_lateral_paths and iso.open_lateral_paths == []
    restart = await sim(make_ctx, graph, "INC-001", "restart_virtual_service")
    assert restart.open_lateral_paths  # still connected


async def test_unmet_precondition_makes_strategy_not_executable(graph):
    from sentinel_agent.models import AssetStatus
    observed = {a: S.HEALTHY for a in graph.assets} | {"primary-database": S.UNAVAILABLE, "backup-service": S.UNAVAILABLE}
    spec = CandidateStrategy(strategy=StrategyName.RESTORE, target_asset_id="primary-database", requires_operational=["backup-service"])
    r = simulate_strategy(graph, observed, spec)
    assert r.executable is False and r.restored_services == 0
    assert any("precondition failed" in n for n in r.precondition_notes)


async def test_simulation_rejects_bad_targets(graph):
    with pytest.raises(SimulationError):
        simulate_strategy(graph, {}, CandidateStrategy(strategy=StrategyName.RESTORE, target_asset_id=None))
    with pytest.raises(SimulationError):
        simulate_strategy(graph, {}, CandidateStrategy(strategy=StrategyName.ISOLATE, target_asset_id="ghost-asset"))


async def test_simulation_is_deterministic_and_chart_ready(make_ctx, graph):
    a = await sim(make_ctx, graph, "INC-001", "restore_virtual_dependency")
    b = await sim(make_ctx, graph, "INC-001", "restore_virtual_dependency")
    assert a.model_dump() == b.model_dump()
    assert len(a.chart["assets"]) == len(a.chart["before"]) == len(a.chart["after"]) == 8
    assert sum(a.chart["counts_after"].values()) == 8
    assert "scenario assumptions" in a.assumption_label


async def test_every_incident_compares_at_least_two_strategies(provider):
    for inc_id in ("INC-001", "INC-002", "INC-003"):
        inc = await provider.get_incident(inc_id)
        assert len(inc.candidate_strategies) >= 2


async def test_ranking_orders_by_service_impact(make_ctx, graph):
    ctx = await make_ctx("INC-003")
    opts = [simulate_strategy(graph, observed_statuses(ctx), c) for c in ctx.incident.candidate_strategies]
    ranking = rank_options(opts)
    assert ranking[0]["strategy"] == "restore_virtual_dependency"
    assert ranking[-1]["status_counts"]["unavailable"] == 3
