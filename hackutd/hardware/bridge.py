"""SentinelOS X local hardware bridge.

Receives telemetry from the Arduino UNO R4 WiFi and exposes a small status enum for the device
to poll. The device is UNTRUSTED: it can report readings and events, never set state or authorize.

Event types from the device:
  * sensor_reading     REAL temperature/humidity from the physical sensor. Forwarded to SpacetimeDB under
                       the authorized `hardware_gateway` identity; the command-center module itself
                       detects excursions and opens a real (non-simulated) incident.
  * heartbeat          liveness only.
  * simulated_incident an explicitly SYNTHETIC demo trigger (kept as a fallback); launches a simulation
                       under the bridge's analyst identity.

Modes: standalone (nothing configured) or SpacetimeDB-integrated (SPACETIMEDB_URL / _DB plus
SPACETIMEDB_GATEWAY_TOKEN and/or SPACETIMEDB_TOKEN). Fails closed (503) if demo tokens are missing.
"""
from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import os
import threading
import time
from collections import deque
from typing import Deque, Literal, Optional

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, ConfigDict, Field

from stdb_adapter import IncidentAdapter, SensorGateway, StdbClient, StdbError

KNOWN_DEVICE = "uno-r4-01"
MAX_BODY_BYTES = 1024
POLL_INTERVAL_S = 2.0
MIN_READING_INTERVAL_S = 0.5  # flood guard; override with SENSOR_MIN_INTERVAL_S
STATES = ("HEALTHY", "ALERT", "INVESTIGATING", "AWAITING_APPROVAL", "RECOVERED")
BUSY_STATES = {"ALERT", "INVESTIGATING", "AWAITING_APPROVAL"}

State = Literal["HEALTHY", "ALERT", "INVESTIGATING", "AWAITING_APPROVAL", "RECOVERED"]


class HardwareEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    device_id: Literal["uno-r4-01"]
    event_type: Literal["heartbeat", "simulated_incident"]
    scenario_id: Literal["INC-001", "INC-002", "INC-003"]
    simulated: Literal[True]


class SensorEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    device_id: Literal["uno-r4-01"]
    event_type: Literal["sensor_reading"]
    temp_c: float = Field(ge=-40, le=85, allow_inf_nan=False)
    humidity_pct: float = Field(ge=0, le=100, allow_inf_nan=False)
    simulated: Literal[False]  # real measurement


class StatusChange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    state: State


class _Store:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.state: str = "HEALTHY"
        self.events: Deque[dict] = deque(maxlen=100)
        self.last_seen: Optional[float] = None
        self.last_sync_error: Optional[str] = None


store = _Store()
adapter: Optional[IncidentAdapter] = None  # follows incidents (set by lifespan or tests)
gateway: Optional[SensorGateway] = None  # forwards real sensor readings
sensor_state: dict = {}
SILENT_AFTER_S = 30.0
_trigger_lock = asyncio.Lock()


def reset_sensor_state() -> None:
    sensor_state.clear()
    sensor_state.update(temp_c=None, humidity_pct=None, ts=None, silent_reported=False, last_error=None, forwarded=0)


reset_sensor_state()


def set_adapter(a: Optional[IncidentAdapter]) -> None:
    global adapter
    adapter = a


def set_gateway(g: Optional[SensorGateway]) -> None:
    global gateway
    gateway = g


async def sync_state_once() -> None:
    """Follow the authoritative incident and mirror its state into the device status."""
    a = adapter
    if a is None:
        return
    try:
        await asyncio.to_thread(a.refresh_real_incident)
        if a.incident_id is None:
            store.last_sync_error = None
            return
        new_state = await asyncio.to_thread(a.device_state)
        store.last_sync_error = None
    except StdbError as e:
        store.last_sync_error = str(e)[:160]
        return
    if new_state:
        with store.lock:
            store.state = new_state


async def watchdog_once(now: Optional[float] = None) -> None:
    """If the sensor goes quiet, report it once (the module opens a real monitoring-lost incident)."""
    g = gateway
    ts = sensor_state.get("ts")
    if g is None or ts is None or sensor_state["silent_reported"]:
        return
    age = (now if now is not None else time.time()) - ts
    if age < SILENT_AFTER_S:
        return
    try:
        await asyncio.to_thread(g.report_silent, f"No sensor readings received for {int(age)} s")
        sensor_state["silent_reported"] = True
    except StdbError as e:
        sensor_state["last_error"] = str(e)[:160]


async def _poll_loop() -> None:
    while True:
        await sync_state_once()
        await watchdog_once()
        await asyncio.sleep(POLL_INTERVAL_S)


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI):
    global SILENT_AFTER_S
    url, db = os.environ.get("SPACETIMEDB_URL", ""), os.environ.get("SPACETIMEDB_DB", "")
    analyst_tok, gw_tok = os.environ.get("SPACETIMEDB_TOKEN", ""), os.environ.get("SPACETIMEDB_GATEWAY_TOKEN", "")
    SILENT_AFTER_S = float(os.environ.get("SENSOR_SILENT_AFTER_S", SILENT_AFTER_S))
    if url and db:
        if gateway is None and gw_tok:
            set_gateway(
                SensorGateway(
                    StdbClient(url, db, gw_tok),
                    KNOWN_DEVICE,
                    "Server closet",
                    float(os.environ.get("SENSOR_TEMP_LIMIT_C", "30")),
                    float(os.environ.get("SENSOR_HUMIDITY_LIMIT_PCT", "70")),
                )
            )
            with contextlib.suppress(StdbError):
                await asyncio.to_thread(gateway.register)  # best effort; also done lazily on first reading
        if adapter is None and (analyst_tok or gw_tok):
            set_adapter(IncidentAdapter(StdbClient(url, db, analyst_tok or gw_tok)))
    task = asyncio.create_task(_poll_loop()) if (adapter is not None or gateway is not None) else None
    try:
        yield
    finally:
        if task:
            task.cancel()


app = FastAPI(title="SentinelOS X hardware bridge", docs_url=None, redoc_url=None, lifespan=lifespan)


def _check(supplied: Optional[str], env_name: str) -> None:
    expected = os.environ.get(env_name, "")
    if len(expected) < 16:
        # Fail closed: never run with a missing/short token.
        raise HTTPException(status_code=503, detail=f"{env_name} not configured")
    if supplied is None or not hmac.compare_digest(supplied.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="invalid token")


@app.get("/health")
def health() -> dict:
    ts = sensor_state.get("ts")
    return {
        "ok": True,
        "state": store.state,
        "spacetimedb": adapter is not None or gateway is not None,
        "sync_error": store.last_sync_error,
        "sensor": {
            "temp_c": sensor_state.get("temp_c"),
            "humidity_pct": sensor_state.get("humidity_pct"),
            "age_s": None if ts is None else round(time.time() - ts, 1),
            "forwarded": sensor_state.get("forwarded", 0),
            "last_error": sensor_state.get("last_error"),
        },
    }


def _min_interval_s() -> float:
    try:
        return max(0.0, float(os.environ.get("SENSOR_MIN_INTERVAL_S", MIN_READING_INTERVAL_S)))
    except ValueError:
        return MIN_READING_INTERVAL_S


async def _handle_sensor(data: dict) -> dict:
    try:
        ev = SensorEvent.model_validate(data)
    except Exception:
        raise HTTPException(status_code=422, detail="invalid sensor event")
    now = time.time()
    last = sensor_state.get("ts")
    if last is not None and now - last < _min_interval_s():
        # Flood protection: a DHT11 cannot legitimately report this fast. Nothing is forwarded.
        raise HTTPException(status_code=429, detail="readings too frequent")
    with store.lock:
        store.last_seen = time.time()
    sensor_state.update(temp_c=ev.temp_c, humidity_pct=ev.humidity_pct, ts=time.time(), silent_reported=False)
    forwarded = False
    error: Optional[str] = None
    if gateway is not None:
        try:
            await asyncio.to_thread(gateway.ingest, ev.temp_c, ev.humidity_pct)
            forwarded = True
            sensor_state["forwarded"] = sensor_state.get("forwarded", 0) + 1
            sensor_state["last_error"] = None
        except StdbError as e:
            error = str(e)[:120]
            sensor_state["last_error"] = error
    body: dict = {"accepted": True, "forwarded_to_spacetimedb": forwarded}
    if error:
        body["adapter_error"] = error
    return body


@app.post("/hardware/events", status_code=202)
async def hardware_event(request: Request, x_device_token: Optional[str] = Header(default=None)) -> dict:
    _check(x_device_token, "SENTINEL_DEVICE_TOKEN")
    declared = request.headers.get("content-length")
    if declared is not None and (not declared.isdigit() or int(declared) > MAX_BODY_BYTES):
        raise HTTPException(status_code=413, detail="body too large")
    raw = await request.body()
    if len(raw) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="body too large")
    try:
        data = json.loads(raw)
    except ValueError:
        raise HTTPException(status_code=422, detail="invalid event")
    if isinstance(data, dict) and data.get("event_type") == "sensor_reading":
        return await _handle_sensor(data)
    try:
        event = HardwareEvent.model_validate(data)
    except Exception:
        raise HTTPException(status_code=422, detail="invalid event")

    duplicate = False
    forwarded = False
    incident_id: Optional[int] = None
    adapter_error: Optional[str] = None

    async with _trigger_lock:
        with store.lock:
            store.last_seen = time.time()
            wants_trigger = event.event_type == "simulated_incident"
            if wants_trigger and store.state in BUSY_STATES:
                duplicate = True  # do not re-trigger an incident already in flight
                wants_trigger = False
            elif wants_trigger:
                store.state = "ALERT"  # the physical signal was received, whatever happens next

        if wants_trigger and adapter is not None:
            try:
                result = await asyncio.to_thread(adapter.trigger, event.scenario_id)
                forwarded = True
                incident_id = result["incident_id"]
            except StdbError as e:
                adapter_error = str(e)[:120]
        elif duplicate and adapter is not None:
            incident_id = adapter.incident_id

        if event.event_type != "heartbeat" or adapter_error:
            with store.lock:
                store.events.append(
                    {
                        "ts": time.time(),
                        "device_id": event.device_id,
                        "event_type": event.event_type,
                        "scenario_id": event.scenario_id,
                        "duplicate": duplicate,
                        "forwarded": forwarded,
                        "incident_id": incident_id,
                        "adapter_error": adapter_error,
                        "state_after": store.state,
                    }
                )
        state = store.state

    body: dict = {"accepted": True, "duplicate": duplicate, "state": state, "forwarded_to_spacetimedb": forwarded}
    if incident_id is not None:
        body["incident_id"] = incident_id
    if adapter_error:
        body["adapter_error"] = adapter_error
    return body


@app.get("/hardware/status", response_class=PlainTextResponse)
def hardware_status(x_device_token: Optional[str] = Header(default=None)) -> str:
    _check(x_device_token, "SENTINEL_DEVICE_TOKEN")
    return store.state


@app.get("/demo/events")
def demo_events(x_admin_token: Optional[str] = Header(default=None)) -> dict:
    _check(x_admin_token, "SENTINEL_ADMIN_TOKEN")
    with store.lock:
        return {"state": store.state, "last_seen": store.last_seen, "events": list(store.events)}


@app.post("/demo/status")
def demo_status(change: StatusChange, x_admin_token: Optional[str] = Header(default=None)) -> dict:
    _check(x_admin_token, "SENTINEL_ADMIN_TOKEN")
    with store.lock:
        store.state = change.state
    return {"state": store.state}
