import asyncio
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from stdb_adapter import IncidentAdapter, StdbError  # noqa: E402

DEV = "d" * 24
ADM = "a" * 24
EVENT = {"device_id": "uno-r4-01", "event_type": "simulated_incident", "scenario_id": "INC-003", "simulated": True}


class FakeStdb:
    """In-memory stand-in for the SpacetimeDB HTTP API (only what the adapter uses)."""

    def __init__(self):
        self.calls = []
        self.incidents = {}  # id -> {"scenario_type", "status"}
        self.recovery = []
        self.findings = []
        self.investigations = []
        self.fail = {}  # reducer -> error message
        self._next = 1

    def call(self, reducer, args):
        self.calls.append((reducer, args))
        if reducer in self.fail:
            raise StdbError(f"{reducer}: HTTP 530: {self.fail[reducer]}")
        if reducer == "launch_simulated_incident":
            stype = args[0]
            if any(i["scenario_type"] == stype and i["status"] != "resolved" for i in self.incidents.values()):
                raise StdbError("launch_simulated_incident: HTTP 530: Simulation already active (incident #1)")
            self.incidents[self._next] = {"scenario_type": stype, "status": "open"}
            self._next += 1
        elif reducer == "request_ai_investigation":
            self.investigations.append({"incident_id": args[0], "status": "requested"})

    def sql(self, q):
        import re

        if q.endswith("scenario_type FROM incident"):  # real-incident discovery: all incidents
            return [{"incident_id": i, "status": v["status"], "scenario_type": v["scenario_type"]} for i, v in self.incidents.items()]
        if "FROM incident WHERE scenario_type" in q:
            st = re.search(r"'([a-z_]+)'", q).group(1)
            return [{"incident_id": i, "status": v["status"]} for i, v in self.incidents.items() if v["scenario_type"] == st]
        iid = int(re.search(r"incident_id = (\d+)", q).group(1))
        if "FROM incident WHERE incident_id" in q:
            return [{"status": self.incidents[iid]["status"]}] if iid in self.incidents else []
        if "FROM recovery_action" in q:
            return [{"status": r["status"]} for r in self.recovery if r["incident_id"] == iid]
        if "FROM ai_finding" in q:
            return [{"kind": f["kind"], "approval_status": f["approval_status"]} for f in self.findings if f["incident_id"] == iid]
        if "FROM ai_investigation" in q:
            return [{"status": i["status"]} for i in self.investigations if i["incident_id"] == iid]
        raise AssertionError(q)


@pytest.fixture()
def fake():
    return FakeStdb()


def test_trigger_launches_and_requests_investigation(fake):
    a = IncidentAdapter(fake)
    r = a.trigger("INC-003")
    assert r == {"incident_id": 1, "adopted": False, "investigation_requested": True}
    assert fake.calls[0][0] == "launch_simulated_incident" and fake.calls[0][1][0] == "database_outage"
    assert fake.calls[1] == ("request_ai_investigation", [1])


def test_trigger_adopts_existing_active_incident(fake):
    fake.incidents[7] = {"scenario_type": "database_outage", "status": "investigating"}
    fake._next = 8
    r = IncidentAdapter(fake).trigger("INC-003")
    assert r["incident_id"] == 7 and r["adopted"] is True and r["investigation_requested"] is False
    assert not any(c[0] == "request_ai_investigation" for c in fake.calls)


def test_investigation_request_failure_does_not_fail_trigger(fake):
    fake.fail["request_ai_investigation"] = "denied"
    r = IncidentAdapter(fake).trigger("INC-003")
    assert r["incident_id"] == 1 and r["investigation_requested"] is False


def test_launch_failure_propagates(fake):
    fake.fail["launch_simulated_incident"] = "Unauthorized: requires role incident_commander"
    with pytest.raises(StdbError):
        IncidentAdapter(fake).trigger("INC-003")


def test_state_mapping_follows_incident_lifecycle(fake):
    a = IncidentAdapter(fake)
    assert a.device_state() is None  # nothing tracked yet
    a.trigger("INC-003")
    fake.investigations[0]["status"] = "requested"
    assert a.device_state() == "INVESTIGATING"
    fake.investigations[0]["status"] = "running"
    assert a.device_state() == "INVESTIGATING"
    fake.investigations[0]["status"] = "completed"
    assert a.device_state() == "ALERT"  # nothing pending, humans still to act
    fake.findings.append({"incident_id": 1, "kind": "recommendation", "approval_status": "pending"})
    assert a.device_state() == "AWAITING_APPROVAL"
    fake.findings[0]["approval_status"] = "approved"
    fake.recovery.append({"incident_id": 1, "status": "pending"})
    assert a.device_state() == "AWAITING_APPROVAL"
    fake.recovery[0]["status"] = "approved"
    assert a.device_state() == "RECOVERED"
    fake.recovery.clear()
    fake.incidents[1]["status"] = "resolved"
    assert a.device_state() == "RECOVERED"


@pytest.fixture()
def client(monkeypatch, fake):
    monkeypatch.setenv("SENTINEL_DEVICE_TOKEN", DEV)
    monkeypatch.setenv("SENTINEL_ADMIN_TOKEN", ADM)
    import bridge

    bridge.store.__init__()
    bridge.set_adapter(IncidentAdapter(fake))
    yield TestClient(bridge.app)
    bridge.set_adapter(None)


def dh():
    return {"X-Device-Token": DEV}


def test_event_forwards_to_spacetimedb_and_status_follows(client, fake):
    import bridge

    r = client.post("/hardware/events", json=EVENT, headers=dh())
    assert r.status_code == 202
    body = r.json()
    assert body["forwarded_to_spacetimedb"] is True and body["incident_id"] == 1
    assert client.get("/hardware/status", headers=dh()).text == "ALERT"

    asyncio.run(bridge.sync_state_once())  # investigation is 'requested'
    assert client.get("/hardware/status", headers=dh()).text == "INVESTIGATING"

    fake.investigations[0]["status"] = "completed"
    fake.findings.append({"incident_id": 1, "kind": "recommendation", "approval_status": "pending"})
    asyncio.run(bridge.sync_state_once())
    assert client.get("/hardware/status", headers=dh()).text == "AWAITING_APPROVAL"

    fake.recovery.append({"incident_id": 1, "status": "approved"})
    asyncio.run(bridge.sync_state_once())
    assert client.get("/hardware/status", headers=dh()).text == "RECOVERED"


def test_repeat_trigger_creates_no_second_incident(client, fake):
    client.post("/hardware/events", json=EVENT, headers=dh())
    r = client.post("/hardware/events", json=EVENT, headers=dh())
    assert r.json()["duplicate"] is True
    assert sum(1 for c in fake.calls if c[0] == "launch_simulated_incident") == 1


def test_spacetimedb_down_still_acks_and_alerts_locally(client, fake):
    fake.fail["launch_simulated_incident"] = "boom"
    r = client.post("/hardware/events", json=EVENT, headers=dh())
    assert r.status_code == 202
    body = r.json()
    assert body["forwarded_to_spacetimedb"] is False and "adapter_error" in body
    assert body["state"] == "ALERT"


def test_sync_error_is_swallowed_and_reported(client, fake):
    import bridge

    client.post("/hardware/events", json=EVENT, headers=dh())

    def boom(_):
        raise StdbError("sql: transport error: ConnectError")

    fake.sql = boom
    asyncio.run(bridge.sync_state_once())
    assert client.get("/hardware/status", headers=dh()).text == "ALERT"  # last known state kept
    assert "transport error" in client.get("/health").json()["sync_error"]
