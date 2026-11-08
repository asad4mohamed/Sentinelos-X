from __future__ import annotations

import asyncio
import json

import pytest

from sentinel_agent.tools.base import ToolArgs, ToolOutput, ToolSpec
from sentinel_agent.tools.registry import REQUIRED_TOOL_NAMES, ToolRegistry, build_default_registry


# ----------------------------------------------------------------------------- registry
def test_all_required_tools_registered_with_schemas(registry):
    assert set(REQUIRED_TOOL_NAMES) == registry.names
    for tool in registry.openai_tools():
        fn = tool["function"]
        assert tool["type"] == "function" and fn["description"]
        schema = fn["parameters"]
        assert schema["type"] == "object" and schema["additionalProperties"] is False
        assert "$defs" not in json.dumps(schema) and "$ref" not in json.dumps(schema)
        json.dumps(schema)  # serialisable


def test_search_schema_inlines_nested_time_range(registry):
    schema = registry.json_schema("search_security_events")
    assert schema["properties"]["time_range"]["type"] == "object"
    assert set(schema["properties"]["time_range"]["properties"]) == {"start", "end"}


def test_registry_refuses_mutating_or_duplicate_tools(registry):
    async def h(ctx, args):
        return ToolOutput(data={})

    class A(ToolArgs):
        pass

    with pytest.raises(ValueError, match="not read-only"):
        ToolRegistry([ToolSpec("write_thing", "x", A, h, read_only=False)])
    with pytest.raises(ValueError, match="duplicate"):
        ToolRegistry([ToolSpec("t", "x", A, h), ToolSpec("t", "x", A, h)])


def test_no_shell_filesystem_or_network_tool_exists(registry):
    forbidden = {"shell", "exec", "bash", "command", "file", "http", "fetch", "url", "write", "delete", "secret", "credential"}
    for name in registry.names:
        assert not any(word in name for word in forbidden), name


# ----------------------------------------------------------------------------- dispatch
async def test_dispatch_get_incident_details(registry, make_ctx):
    ctx = await make_ctx("INC-003")
    r = await registry.execute("get_incident_details", {"incident_id": "INC-003"}, ctx)
    assert r.ok and r.data["incident"]["incident_id"] == "INC-003"
    assert {o["strategy"] for o in r.data["incident"]["available_recovery_options"]} >= {"restore_virtual_dependency", "maintain_current_state"}
    assert "ground" not in json.dumps(r.data).lower()


async def test_dispatch_accepts_json_string_arguments(registry, make_ctx):
    ctx = await make_ctx()
    r = await registry.execute("get_asset_status", '{"asset_id": "primary-database"}', ctx)
    assert r.ok and r.data["observed_status_during_incident"]["status"] == "unavailable"
    assert r.evidence[0].evidence_id == "AST-INC-003-primary-database"


@pytest.mark.parametrize("raw, code", [
    ("{broken", "MALFORMED_ARGUMENTS"),
    ('["asset"]', "MALFORMED_ARGUMENTS"),
    ('{"asset_id": "primary-database", "shell": "rm -rf /"}', "INVALID_ARGUMENTS"),
    ('{"asset_id": "../../etc/passwd"}', "INVALID_ARGUMENTS"),
    ('{"asset_id": "Primary Database; DROP"}', "INVALID_ARGUMENTS"),
    ("{}", "INVALID_ARGUMENTS"),
    ('{"asset_id": 7}', "INVALID_ARGUMENTS"),
])
async def test_malformed_and_unexpected_arguments_rejected(registry, make_ctx, raw, code):
    r = await registry.execute("get_asset_status", raw, await make_ctx())
    assert not r.ok and r.error_code == code


async def test_invalid_asset_id_unknown_but_well_formed(registry, make_ctx):
    ctx = await make_ctx()
    for tool in ("get_asset_status", "get_infrastructure_dependencies", "calculate_blast_radius", "get_related_incidents"):
        r = await registry.execute(tool, {"asset_id": "no-such-asset"}, ctx)
        assert not r.ok and r.error_code == "ASSET_NOT_FOUND", tool
    r = await registry.execute("get_recent_logs", {"asset_id": "no-such-asset"}, ctx)
    assert r.error_code == "ASSET_NOT_FOUND"


async def test_unknown_tool_is_a_structured_failure(registry, make_ctx):
    r = await registry.execute("execute_shell", {"cmd": "id"}, await make_ctx())
    assert not r.ok and r.error_code == "UNKNOWN_TOOL"


async def test_tool_timeout_and_crash_are_contained(make_ctx):
    class A(ToolArgs):
        pass

    async def slow(ctx, args):
        await asyncio.sleep(5)

    async def boom(ctx, args):
        raise RuntimeError("secret internal detail nvapi-ABCDEFGH12345678")

    reg = ToolRegistry([ToolSpec("slow", "x", A, slow), ToolSpec("boom", "x", A, boom)])
    ctx = await make_ctx(tool_timeout_s=0.1)
    assert (await reg.execute("slow", {}, ctx)).error_code == "TOOL_TIMEOUT"
    crashed = await reg.execute("boom", {}, ctx)
    assert crashed.error_code == "INTERNAL_ERROR" and "secret" not in crashed.error_message


# ----------------------------------------------------------------------------- logs
async def test_log_retrieval_defaults_to_incident_window_and_is_chronological(registry, make_ctx):
    ctx = await make_ctx("INC-001")
    r = await registry.execute("get_recent_logs", {"asset_id": "file-storage"}, ctx)
    ids = [e.evidence_id for e in r.evidence]
    assert ids == ["EVT-001", "EVT-002", "EVT-003", "EVT-005", "EVT-007"]
    times = [e.timestamp for e in r.evidence]
    assert times == sorted(times)
    assert r.data["time_range"] == {"start": "2026-11-07T14:00:00Z", "end": "2026-11-07T14:45:00Z"}


async def test_log_filtering_by_time_and_limit(registry, make_ctx):
    ctx = await make_ctx("INC-001")
    r = await registry.execute("get_recent_logs", {"asset_id": "file-storage", "start_time": "2026-11-07T14:04:00Z", "end_time": "2026-11-07T14:07:00Z"}, ctx)
    assert [e.evidence_id for e in r.evidence] == ["EVT-002", "EVT-003"]
    r = await registry.execute("get_recent_logs", {"asset_id": "file-storage", "limit": 2}, ctx)
    assert [e.evidence_id for e in r.evidence] == ["EVT-005", "EVT-007"] and r.truncated  # most recent two


async def test_log_retrieval_is_bounded_by_server_limit(registry, make_ctx):
    ctx = await make_ctx("INC-001", max_log_results=3)
    r = await registry.execute("get_recent_logs", {"asset_id": "file-storage", "limit": 500}, ctx)
    assert len(r.evidence) == 3 and r.data["applied_limit"] == 3 and r.truncated


async def test_naive_and_reversed_timestamps_rejected(registry, make_ctx):
    ctx = await make_ctx("INC-001")
    r = await registry.execute("get_recent_logs", {"asset_id": "file-storage", "start_time": "2026-11-07T14:00:00"}, ctx)
    assert r.error_code == "INVALID_ARGUMENTS"
    r = await registry.execute("get_recent_logs", {"asset_id": "file-storage", "start_time": "2026-11-07T15:00:00Z", "end_time": "2026-11-07T14:00:00Z"}, ctx)
    assert r.error_code == "INVALID_ARGUMENTS"


async def test_timestamps_with_offsets_normalise_to_utc(registry, make_ctx):
    ctx = await make_ctx("INC-001")
    r = await registry.execute("get_recent_logs", {"asset_id": "file-storage", "start_time": "2026-11-07T09:04:00-05:00", "end_time": "2026-11-07T09:07:00-05:00"}, ctx)
    assert r.ok and r.data["time_range"]["start"] == "2026-11-07T14:04:00Z"
    assert [e.evidence_id for e in r.evidence] == ["EVT-002", "EVT-003"]


async def test_search_ranks_filters_and_widens(registry, make_ctx):
    ctx = await make_ctx("INC-003")
    r = await registry.execute("search_security_events", {"query": "WAL archive failing"}, ctx)
    assert "EVT-214" not in [e.evidence_id for e in r.evidence]  # outside the incident window by default
    r = await registry.execute("search_security_events", {"query": "WAL archive failing", "time_range": {"start": "2026-11-06T00:00:00Z"}}, ctx)
    assert r.evidence[0].evidence_id == "EVT-214"
    r = await registry.execute("search_security_events", {"query": "503", "asset_ids": ["external-gateway"]}, ctx)
    assert {e.asset_id for e in r.evidence} == {"external-gateway"}
    bad = await registry.execute("search_security_events", {"query": "x"}, ctx)
    assert bad.error_code == "INVALID_ARGUMENTS"


# ----------------------------------------------------------------------------- evidence provenance
async def test_evidence_records_carry_provenance_and_reliability(registry, make_ctx):
    ctx = await make_ctx("INC-001")
    r = await registry.execute("get_recent_logs", {"asset_id": "file-storage"}, ctx)
    for ev in r.evidence:
        assert ev.provenance.origin == "synthetic_fixture" and ev.provenance.record_ref.startswith("logs.json#")
        assert ev.reliability in {"high", "medium", "low"} and ev.reliability_basis
        assert ev.timestamp.tzinfo is not None
    low = next(e for e in r.evidence if e.evidence_id == "EVT-007")
    assert low.reliability == "low" and "possible_prompt_injection" in low.content_flags


async def test_get_evidence_record_covers_all_kinds(registry, make_ctx):
    ctx = await make_ctx("INC-003")
    for eid, kind in [("EVT-202", "log_event"), ("DEP-003", "dependency"), ("AST-INC-003-primary-database", "asset_state")]:
        r = await registry.execute("get_evidence_record", {"evidence_id": eid}, ctx)
        assert r.ok and r.evidence[0].kind == kind
    for bad in ("EVT-9999", "DEP-777", "AST-INC-003-ghost-asset"):
        assert (await registry.execute("get_evidence_record", {"evidence_id": bad}, ctx)).error_code == "EVIDENCE_NOT_FOUND"
    assert (await registry.execute("get_evidence_record", {"evidence_id": "bogus"}, ctx)).error_code == "INVALID_ARGUMENTS"


async def test_timeline_returns_referenced_evidence(registry, make_ctx):
    r = await registry.execute("get_incident_timeline", {"incident_id": "INC-003"}, await make_ctx("INC-003"))
    assert [e["time"] for e in r.data["entries"]] == sorted(e["time"] for e in r.data["entries"])
    assert {e.evidence_id for e in r.evidence} == {"EVT-201", "EVT-202", "EVT-204", "EVT-206"}


async def test_dependencies_tool(registry, make_ctx):
    r = await registry.execute("get_infrastructure_dependencies", {"asset_id": "application-api"}, await make_ctx("INC-003"))
    deps = {d["asset_id"]: d for d in r.data["depends_on"]}
    assert deps["primary-database"]["kind"] == "critical" and deps["primary-database"]["observed_status"] == "unavailable"
    assert deps["file-storage"]["kind"] == "optional"
    assert "external-gateway" in {d["asset_id"] for d in r.data["depended_on_by"]}
    assert "DEP-003" in {e.evidence_id for e in r.evidence}


async def test_related_incidents(registry, make_ctx):
    r = await registry.execute("get_related_incidents", {"asset_id": "primary-database"}, await make_ctx("INC-003"))
    assert [i["incident_id"] for i in r.data["related_incidents"]] == ["INC-090"]


async def test_blast_radius_tool_reports_cascade_and_unaffected(registry, make_ctx):
    r = await registry.execute("calculate_blast_radius", {"asset_id": "primary-database"}, await make_ctx("INC-003"))
    assert set(r.data["impacted_by_status"]["unavailable"]) == {"application-api", "external-gateway"}
    assert set(r.data["unaffected_assets"]) == {"file-storage", "monitoring-service"}
    assert r.data["root_cause_candidates_from_observed_state"] == ["primary-database"]


async def test_simulate_tool_errors_are_structured(registry, make_ctx):
    ctx = await make_ctx("INC-003")
    amb = await registry.execute("simulate_recovery_strategy", {"incident_id": "INC-003", "strategy": "restart_virtual_service"}, ctx)
    assert amb.error_code == "AMBIGUOUS_TARGET"
    missing = await registry.execute("simulate_recovery_strategy", {"incident_id": "INC-003", "strategy": "isolate_virtual_asset", "target_asset_id": "primary-database"}, ctx)
    assert missing.error_code == "STRATEGY_NOT_AVAILABLE"
    bad = await registry.execute("simulate_recovery_strategy", {"incident_id": "INC-003", "strategy": "format_disk"}, ctx)
    assert bad.error_code == "INVALID_ARGUMENTS"
    ok = await registry.execute("simulate_recovery_strategy", {"incident_id": "INC-003", "strategy": "restore_virtual_dependency"}, ctx)
    assert ok.ok and ctx.simulations[("restore_virtual_dependency", "primary-database")].restored_services == 6
