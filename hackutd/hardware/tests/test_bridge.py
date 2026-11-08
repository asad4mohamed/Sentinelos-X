import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

DEV = "d" * 24
ADM = "a" * 24
EVENT = {"device_id": "uno-r4-01", "event_type": "simulated_incident", "scenario_id": "INC-003", "simulated": True}


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("SENTINEL_DEVICE_TOKEN", DEV)
    monkeypatch.setenv("SENTINEL_ADMIN_TOKEN", ADM)
    import bridge

    bridge.store.__init__()
    return TestClient(bridge.app)


def dh(token=DEV):
    return {"X-Device-Token": token}


def ah(token=ADM):
    return {"X-Admin-Token": token}


def test_incident_accepted_sets_alert(client):
    r = client.post("/hardware/events", json=EVENT, headers=dh())
    assert r.status_code == 202
    body = r.json()
    assert body["accepted"] is True and body["forwarded_to_spacetimedb"] is False
    assert client.get("/hardware/status", headers=dh()).text == "ALERT"


def test_heartbeat_does_not_change_state(client):
    r = client.post("/hardware/events", json={**EVENT, "event_type": "heartbeat"}, headers=dh())
    assert r.status_code == 202
    assert client.get("/hardware/status", headers=dh()).text == "HEALTHY"


def test_repeat_trigger_is_deduplicated(client):
    client.post("/hardware/events", json=EVENT, headers=dh())
    r = client.post("/hardware/events", json=EVENT, headers=dh())
    assert r.status_code == 202 and r.json()["duplicate"] is True


def test_retrigger_allowed_after_recovery(client):
    client.post("/hardware/events", json=EVENT, headers=dh())
    client.post("/demo/status", json={"state": "RECOVERED"}, headers=ah())
    r = client.post("/hardware/events", json=EVENT, headers=dh())
    assert r.json()["duplicate"] is False
    assert client.get("/hardware/status", headers=dh()).text == "ALERT"


@pytest.mark.parametrize("token", [None, "", "wrong-token-wrong-token-wrong"])
def test_bad_device_token_rejected(client, token):
    headers = {} if token is None else dh(token)
    assert client.post("/hardware/events", json=EVENT, headers=headers).status_code == 401
    assert client.get("/hardware/status", headers=headers).status_code == 401


@pytest.mark.parametrize(
    "patch",
    [
        {"device_id": "other-device"},
        {"scenario_id": "INC-999"},
        {"event_type": "shell"},
        {"simulated": False},
        {"extra": "field"},
    ],
)
def test_invalid_payloads_rejected(client, patch):
    r = client.post("/hardware/events", json={**EVENT, **patch}, headers=dh())
    assert r.status_code == 422


def test_malformed_and_oversized_body(client):
    h = {**dh(), "Content-Type": "application/json"}
    assert client.post("/hardware/events", content=b"{not json", headers=h).status_code == 422
    assert client.post("/hardware/events", content=b"x" * 5000, headers=h).status_code == 413


def test_admin_status_transitions(client):
    for s in ("INVESTIGATING", "AWAITING_APPROVAL", "RECOVERED"):
        assert client.post("/demo/status", json={"state": s}, headers=ah()).status_code == 200
        assert client.get("/hardware/status", headers=dh()).text == s
    assert client.post("/demo/status", json={"state": "BOGUS"}, headers=ah()).status_code == 422


def test_device_token_cannot_use_admin_routes(client):
    assert client.post("/demo/status", json={"state": "RECOVERED"}, headers=dh()).status_code == 401
    assert client.get("/demo/events", headers=dh()).status_code == 401


def test_fails_closed_without_tokens(monkeypatch):
    monkeypatch.delenv("SENTINEL_DEVICE_TOKEN", raising=False)
    monkeypatch.delenv("SENTINEL_ADMIN_TOKEN", raising=False)
    import bridge

    c = TestClient(bridge.app)
    assert c.get("/hardware/status", headers=dh()).status_code == 503
