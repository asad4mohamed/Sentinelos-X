import asyncio
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from stdb_adapter import IncidentAdapter, SensorGateway, StdbError  # noqa: E402

DEV = "d" * 24
READING = {"device_id": "uno-r4-01", "event_type": "sensor_reading", "temp_c": 23.5, "humidity_pct": 41.0, "simulated": False}


class FakeClient:
    def __init__(self):
        self.calls = []
        self.registered = True
        self.fail = {}
        self.incidents = []  # {"incident_id", "status", "scenario_type"}
        self.recovery = []
        self.findings = []
        self.investigations = []

    def call(self, reducer, args):
        self.calls.append((reducer, args))
        if reducer in self.fail:
            raise StdbError(f"{reducer}: {self.fail[reducer]}")
        if reducer == "ingest_sensor_reading" and not self.registered:
            raise StdbError("ingest_sensor_reading: HTTP 530: Sensor node 'uno-r4-01' is not registered")
        if reducer == "register_sensor_node":
            self.registered = True

    def sql(self, q):
        if "FROM incident WHERE incident_id" in q:
            iid = int(q.rsplit("=", 1)[1])
            return [{"status": i["status"]} for i in self.incidents if i["incident_id"] == iid]
        if "FROM incident" in q:
            return list(self.incidents)
        if "FROM recovery_action" in q:
            return list(self.recovery)
        if "FROM ai_finding" in q:
            return list(self.findings)
        if "FROM ai_investigation" in q:
            return list(self.investigations)
        raise AssertionError(q)


@pytest.fixture()
def env(monkeypatch):
    monkeypatch.setenv("SENTINEL_DEVICE_TOKEN", DEV)
    monkeypatch.setenv("SENTINEL_ADMIN_TOKEN", "a" * 24)
    monkeypatch.setenv("SENSOR_MIN_INTERVAL_S", "0")  # rate limit tested separately
    import bridge

    bridge.store.__init__()
    bridge.reset_sensor_state()
    fake = FakeClient()
    bridge.set_gateway(SensorGateway(fake, "uno-r4-01", "Server closet", 30, 70))
    bridge.set_adapter(IncidentAdapter(fake))
    yield bridge, fake, TestClient(bridge.app)
    bridge.set_gateway(None)
    bridge.set_adapter(None)


def post(client, body):
    return client.post("/hardware/events", json=body, headers={"X-Device-Token": DEV})


def test_sensor_reading_is_forwarded_with_real_values(env):
    bridge, fake, client = env
    r = post(client, READING)
    assert r.status_code == 202
    assert r.json() == {"accepted": True, "forwarded_to_spacetimedb": True}
    assert fake.calls[-1] == ("ingest_sensor_reading", ["uno-r4-01", 23.5, 41.0])
    assert client.get("/health").json()["sensor"]["temp_c"] == 23.5


def test_registers_lazily_on_first_reading(env):
    bridge, fake, client = env
    fake.registered = False
    assert post(client, READING).json()["forwarded_to_spacetimedb"] is True
    names = [c[0] for c in fake.calls]
    assert names == ["ingest_sensor_reading", "register_sensor_node", "ingest_sensor_reading"]
    assert fake.calls[1][1] == ["uno-r4-01", "Server closet", 30, 70]


def test_forward_failure_is_reported_not_hidden(env):
    bridge, fake, client = env
    fake.fail["ingest_sensor_reading"] = "HTTP 530: boom"
    body = post(client, READING).json()
    assert body["accepted"] is True and body["forwarded_to_spacetimedb"] is False and "adapter_error" in body


@pytest.mark.parametrize(
    "patch",
    [
        {"simulated": True},  # a real reading must not claim to be simulated
        {"temp_c": 500},
        {"temp_c": float("nan")},
        {"humidity_pct": -1},
        {"humidity_pct": 120},
        {"device_id": "other"},
        {"extra": 1},
        {"temp_c": "hot"},
    ],
)
def test_invalid_sensor_events_rejected(env, patch):
    import json

    bridge, fake, client = env
    raw = json.dumps({**READING, **patch}, allow_nan=True)
    r = client.post("/hardware/events", content=raw, headers={"X-Device-Token": DEV, "Content-Type": "application/json"})
    assert r.status_code == 422
    assert not [c for c in fake.calls if c[0] == "ingest_sensor_reading"]


def test_sensor_events_need_the_device_token(env):
    bridge, fake, client = env
    assert client.post("/hardware/events", json=READING).status_code == 401
    assert client.post("/hardware/events", json=READING, headers={"X-Device-Token": "x" * 24}).status_code == 401


def test_watchdog_reports_silence_once_and_rearms_on_next_reading(env):
    bridge, fake, client = env
    post(client, READING)
    t0 = bridge.sensor_state["ts"]
    asyncio.run(bridge.watchdog_once(now=t0 + 5))
    assert not [c for c in fake.calls if c[0] == "report_sensor_fault"]
    asyncio.run(bridge.watchdog_once(now=t0 + 31))
    asyncio.run(bridge.watchdog_once(now=t0 + 90))  # must not repeat
    faults = [c for c in fake.calls if c[0] == "report_sensor_fault"]
    assert len(faults) == 1 and faults[0][1][:2] == ["uno-r4-01", "silent"]
    post(client, READING)  # sensor is back
    assert bridge.sensor_state["silent_reported"] is False


def test_watchdog_does_nothing_before_the_first_reading(env):
    bridge, fake, client = env
    asyncio.run(bridge.watchdog_once(now=10**12))
    assert not fake.calls


def test_device_state_follows_a_real_incident_opened_by_the_module(env):
    bridge, fake, client = env
    asyncio.run(bridge.sync_state_once())
    assert client.get("/hardware/status", headers={"X-Device-Token": DEV}).text == "HEALTHY"
    fake.incidents.append({"incident_id": 4, "status": "open", "scenario_type": "environmental_excursion"})
    fake.investigations.append({"status": "requested"})
    asyncio.run(bridge.sync_state_once())
    assert client.get("/hardware/status", headers={"X-Device-Token": DEV}).text == "INVESTIGATING"
    fake.investigations[0]["status"] = "completed"
    fake.findings.append({"kind": "recommendation", "approval_status": "pending"})
    asyncio.run(bridge.sync_state_once())
    assert client.get("/hardware/status", headers={"X-Device-Token": DEV}).text == "AWAITING_APPROVAL"
    fake.recovery.append({"status": "approved"})
    asyncio.run(bridge.sync_state_once())
    assert client.get("/hardware/status", headers={"X-Device-Token": DEV}).text == "RECOVERED"


def test_simulated_incidents_are_ignored_by_real_incident_tracking(env):
    bridge, fake, client = env
    fake.incidents.append({"incident_id": 2, "status": "open", "scenario_type": "database_outage"})
    asyncio.run(bridge.sync_state_once())
    assert bridge.adapter.incident_id is None


def test_reading_flood_is_rejected_and_not_forwarded(env, monkeypatch):
    bridge, fake, c = env
    monkeypatch.setenv("SENSOR_MIN_INTERVAL_S", "5")
    assert post(c, READING).status_code == 202
    r = post(c, READING)
    assert r.status_code == 429
    assert [x for x in fake.calls if x[0] == "ingest_sensor_reading"] == [("ingest_sensor_reading", ["uno-r4-01", 23.5, 41.0])]


def test_oversized_body_rejected_before_parsing(env):
    _, fake, c = env
    r = c.post("/hardware/events", content=b"{" + b" " * 5000 + b"}", headers={"X-Device-Token": DEV, "Content-Type": "application/json"})
    assert r.status_code == 413
    assert fake.calls == []


def test_bridge_keeps_working_without_spacetimedb(env):
    bridge, _, c = env
    bridge.set_gateway(None)
    bridge.set_adapter(None)
    r = post(c, READING)
    assert r.status_code == 202 and r.json()["forwarded_to_spacetimedb"] is False
    assert c.get("/health").json()["sensor"]["temp_c"] == 23.5
