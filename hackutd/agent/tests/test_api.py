from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from sentinel_agent.main import create_app
from scripted_llm import SCENARIOS, ScriptedLLM, SlowLLM
from conftest import fast_settings

DEMO = {"x-demo-user": "dev-user", "x-demo-role": "incident_commander"}


def make_client(llm=None, **settings_kw):
    settings = fast_settings(**settings_kw)
    app = create_app(settings, llm=llm)
    transport = httpx.ASGITransport(app=app)
    return app, httpx.AsyncClient(transport=transport, base_url="http://test")


async def wait_done(app, inv_id):
    await app.state.manager.wait(inv_id)


async def test_health_and_capabilities():
    app, c = make_client(ScriptedLLM([]))
    async with c:
        h = (await c.get("/health")).json()
        assert h["status"] == "ok" and h["data_source"] == "synthetic_fixture" and h["nvidia_configured"] is True
        assert "api_key" not in json.dumps(h).lower() and "test-key" not in json.dumps(h)
        cap = (await c.get("/api/agent/capabilities")).json()
        assert {t["name"] for t in cap["investigation_tools"]} >= {"get_incident_details", "simulate_recovery_strategy"}
        assert cap["security"]["operational_actions_require_human_approval"] is True
        assert cap["limits"]["max_tool_calls"] == 12
        assert "restore_virtual_dependency" in cap["recovery_strategies"] or "restore_virtual_dependency" in json.dumps(cap)


async def test_full_investigation_flow_over_http():
    app, c = make_client(ScriptedLLM(SCENARIOS["INC-003"]()))
    async with c:
        r = await c.post("/api/investigations", json={"incident_id": "INC-003"})
        assert r.status_code == 202
        created = r.json()
        inv = created["investigation_id"]
        assert created["status"] in {"queued", "collecting_evidence"} and created["links"]["events"].endswith("/events")
        await wait_done(app, inv)

        res = (await c.get(f"/api/investigations/{inv}")).json()
        assert res["status"] == "awaiting_approval" and res["analysis_complete"] is True
        assert res["recommended_action"]["requires_approval"] is True and res["recommended_action"]["target_asset_id"] == "primary-database"
        assert res["data_source"] == "synthetic_fixture" and res["model_provider"] == "scripted_test_double"
        assert len(res["tool_calls"]) == 10 and len(res["recovery_options"]) == 3 and res["root_cause_candidates"] == ["primary-database"]

        report = await c.get(f"/api/investigations/{inv}/report")
        assert report.status_code == 200 and report.json()["trace"][0].startswith("[00:00]")

        events = (await c.get(f"/api/investigations/{inv}/events")).json()
        types = [e["type"] for e in events["events"]]
        assert types[0] == "investigation_queued" and "tool_call_completed" in types and types[-1] == "awaiting_approval"
        tail = (await c.get(f"/api/investigations/{inv}/events", params={"after": events["next_after"] - 2})).json()
        assert [e["seq"] for e in tail["events"]] == [events["next_after"] - 1, events["next_after"]]


async def test_approval_over_http_demo_mode_and_unauthenticated():
    app, c = make_client(ScriptedLLM(SCENARIOS["INC-003"]()), demo_mode=True)
    async with c:
        inv = (await c.post("/api/investigations", json={"incident_id": "INC-003"})).json()["investigation_id"]
        await wait_done(app, inv)
        pid = (await c.get(f"/api/investigations/{inv}")).json()["proposal"]["proposal_id"]

        no_id = await c.post(f"/api/proposals/{pid}/decision", json={"decision": "approve"})
        assert no_id.status_code == 401 and no_id.json()["error"]["code"] == "IDENTITY_MISSING"

        viewer = await c.post(f"/api/proposals/{pid}/decision", json={"decision": "approve"}, headers={"x-demo-user": "v", "x-demo-role": "viewer"})
        assert viewer.status_code == 403

        # identity smuggled in the body is rejected outright (extra=forbid), not trusted
        smuggled = await c.post(f"/api/proposals/{pid}/decision", json={"decision": "approve", "role": "security_admin", "approved": True}, headers=DEMO)
        assert smuggled.status_code == 422

        ok = await c.post(f"/api/proposals/{pid}/decision", json={"decision": "approve", "reason": "reviewed"}, headers=DEMO)
        assert ok.status_code == 200
        body = ok.json()
        assert body["status"] == "approved" and body["authorization_mode"] == "demo_local_NOT_PRODUCTION"
        assert body["execution"] == "not_performed_by_agent" and body["investigation_status"] == "completed"

        again = await c.post(f"/api/proposals/{pid}/decision", json={"decision": "reject"}, headers=DEMO)
        assert again.status_code == 409
        missing = await c.post("/api/proposals/PRP-nope/decision", json={"decision": "approve"}, headers=DEMO)
        assert missing.status_code == 404


async def test_approval_without_demo_mode_requires_service_token():
    app, c = make_client(ScriptedLLM(SCENARIOS["INC-003"]()), service_token="backend-secret")
    tok = {"x-sentinel-service-token": "backend-secret"}
    async with c:
        inv = (await c.post("/api/investigations", json={"incident_id": "INC-003"}, headers=tok)).json()["investigation_id"]
        await wait_done(app, inv)
        pid = (await c.get(f"/api/investigations/{inv}", headers=tok)).json()["proposal"]["proposal_id"]
        r = await c.post(f"/api/proposals/{pid}/decision", json={"decision": "approve"}, headers=DEMO)
        assert r.status_code == 401  # demo headers ignored when demo mode is off
        r = await c.post(f"/api/proposals/{pid}/decision", json={"decision": "approve"},
                         headers={"x-sentinel-service-token": "wrong", "x-authenticated-user-id": "u", "x-authenticated-user-role": "incident_commander"})
        assert r.status_code == 401
        r = await c.post(f"/api/proposals/{pid}/decision", json={"decision": "reject", "reason": "no"},
                         headers={"x-sentinel-service-token": "backend-secret", "x-authenticated-user-id": "u1", "x-authenticated-user-role": "security_admin"})
        assert r.status_code == 200 and r.json()["status"] == "rejected" and r.json()["authorization_mode"] == "service_token_backend_asserted"


async def test_validation_and_error_codes():
    app, c = make_client(ScriptedLLM([]))
    async with c:
        for body in ({}, {"incident_id": "not-an-id"}, {"incident_id": "INC-001", "extra": 1}, {"incident_id": 5}):
            r = await c.post("/api/investigations", json=body)
            assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION_ERROR", body
        r = await c.post("/api/investigations", content="{bad", headers={"content-type": "application/json"})
        assert r.status_code == 422
        missing = await c.post("/api/investigations", json={"incident_id": "INC-404"})
        assert missing.status_code == 404 and missing.json()["error"]["code"] == "INCIDENT_NOT_FOUND"
        historical = await c.post("/api/investigations", json={"incident_id": "INC-090"})
        assert historical.status_code == 404
        for path in ("/api/investigations/INV-NOPE", "/api/investigations/INV-NOPE/events", "/api/investigations/INV-NOPE/report"):
            r = await c.get(path)
            assert r.status_code == 404 and r.json()["error"]["code"] == "INVESTIGATION_NOT_FOUND"
        assert (await c.get("/nope")).status_code == 404
        assert (await c.get("/api/investigations/x/events", params={"after": -1})).status_code in (404, 422)


async def test_report_not_ready_returns_409_while_running():
    app, c = make_client(SlowLLM(2), max_investigation_seconds=5)
    async with c:
        inv = (await c.post("/api/investigations", json={"incident_id": "INC-003"})).json()["investigation_id"]
        await asyncio.sleep(0.05)
        r = await c.get(f"/api/investigations/{inv}/report")
        assert r.status_code == 409 and r.json()["error"]["code"] == "REPORT_NOT_READY" and r.headers["retry-after"]
        await app.state.manager.shutdown()


async def test_failed_investigation_is_reported_as_failed():
    from sentinel_agent.llm.nvidia_client import LLMRateLimited
    from scripted_llm import RaisingLLM
    app, c = make_client(RaisingLLM(LLMRateLimited("NVIDIA rate limit reached", status=429)))
    async with c:
        inv = (await c.post("/api/investigations", json={"incident_id": "INC-003"})).json()["investigation_id"]
        await wait_done(app, inv)
        res = (await c.get(f"/api/investigations/{inv}/report")).json()
        assert res["status"] == "failed" and res["analysis_complete"] is False
        assert res["error"]["code"] == "LLM_RATE_LIMITED" and res["recommended_action"] is None and res["findings"] == []


async def test_missing_nvidia_key_returns_503_not_a_fake_result():
    app = create_app(fast_settings(nvidia_api_key=""))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        assert (await c.get("/health")).json()["nvidia_configured"] is False
        r = await c.post("/api/investigations", json={"incident_id": "INC-003"})
        assert r.status_code == 503 and r.json()["error"]["code"] == "LLM_NOT_CONFIGURED"


async def test_queue_limit_returns_429():
    app, c = make_client(SlowLLM(1), max_queued_investigations=0)
    async with c:
        r = await c.post("/api/investigations", json={"incident_id": "INC-003"})
        assert r.status_code == 429 and r.headers["retry-after"]


async def test_cors_is_narrow():
    app, c = make_client(ScriptedLLM([]), cors_origins=("http://localhost:5173",))
    async with c:
        ok = await c.get("/health", headers={"origin": "http://localhost:5173"})
        assert ok.headers["access-control-allow-origin"] == "http://localhost:5173"
        other = await c.get("/health", headers={"origin": "http://evil.example"})
        assert "access-control-allow-origin" not in other.headers
        pre = await c.options("/api/proposals/x/decision", headers={"origin": "http://localhost:5173", "access-control-request-method": "POST", "access-control-request-headers": "x-demo-role"})
        assert "x-demo-role" not in pre.headers.get("access-control-allow-headers", "").lower()
    app2, c2 = make_client(ScriptedLLM([]))
    async with c2:
        assert "access-control-allow-origin" not in (await c2.get("/health", headers={"origin": "http://localhost:5173"})).headers


async def test_json_serialisation_of_every_scenario_result():
    for incident_id in ("INC-001", "INC-002", "INC-003"):
        app, c = make_client(ScriptedLLM(SCENARIOS[incident_id]()))
        async with c:
            inv = (await c.post("/api/investigations", json={"incident_id": incident_id})).json()["investigation_id"]
            await wait_done(app, inv)
            r = await c.get(f"/api/investigations/{inv}/report")
            body = r.json()  # parses => valid JSON
            assert body["status"] in {"awaiting_approval", "completed"} and body["created_at"].endswith("Z")
            assert all(t["started_at"].endswith("Z") for t in body["tool_calls"])
            assert body["evidence"] and all(e["evidence"]["provenance"]["origin"] == "synthetic_fixture" for e in body["evidence"])


async def test_api_requires_service_token_when_configured():
    app, c = make_client(ScriptedLLM(SCENARIOS["INC-003"]()), service_token="backend-secret")
    async with c:
        assert (await c.get("/health")).status_code == 200  # liveness stays open
        for method, path, kw in [("post", "/api/investigations", {"json": {"incident_id": "INC-003"}}),
                                 ("get", "/api/agent/capabilities", {}), ("get", "/api/investigations/INV-X", {}),
                                 ("get", "/api/investigations/INV-X/events", {}), ("get", "/api/investigations/INV-X/report", {})]:
            r = await getattr(c, method)(path, **kw)
            assert r.status_code == 401 and r.json()["error"]["code"] == "SERVICE_AUTH_REQUIRED", path
            r = await getattr(c, method)(path, headers={"x-sentinel-service-token": "nope"}, **kw)
            assert r.status_code == 401, path
        ok = await c.post("/api/investigations", json={"incident_id": "INC-003"}, headers={"x-sentinel-service-token": "backend-secret"})
        assert ok.status_code == 202
        await app.state.manager.shutdown()
