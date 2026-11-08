"""SpacetimeDB adapter for the hardware bridge.

Trust model (see HARDWARE_DEMO.md): the Arduino is untrusted. This adapter runs in
the trusted bridge process under its OWN SpacetimeDB identity, registered as a
`security_analyst` responder by an Incident Commander. Authorization is enforced by
the SpacetimeDB module, not here: this identity can launch a simulated incident and
request an AI investigation, but it cannot approve recovery (IC-only, two-person rule).

Talks to SpacetimeDB's HTTP API (no SDK):
  POST /v1/database/{db}/call/{reducer}   JSON array of reducer args
  POST /v1/database/{db}/sql              SQL text
"""
from __future__ import annotations

from typing import Optional

import httpx

# Arduino scenario id -> command-center scenario type. INC-003 (dependency failure)
# maps to database_outage. INC-001/INC-002 are ASSUMED; adjust once confirmed.
SCENARIO_MAP = {
    "INC-001": "auth_compromise",
    "INC-002": "traffic_surge",
    "INC-003": "database_outage",
}


# Incident types opened by the command center itself from REAL sensor data (isSimulation = false).
REAL_SCENARIOS = ("environmental_excursion", "sensor_silent")


class StdbError(Exception):
    pass


class StdbClient:
    def __init__(self, base_url: str, db: str, token: str, timeout: float = 5.0) -> None:
        self._base = base_url.rstrip("/")
        self._db = db
        self._http = httpx.Client(timeout=timeout, headers={"Authorization": f"Bearer {token}"})

    def call(self, reducer: str, args: list) -> None:
        try:
            r = self._http.post(f"{self._base}/v1/database/{self._db}/call/{reducer}", json=args)
        except httpx.HTTPError as e:
            raise StdbError(f"{reducer}: transport error: {type(e).__name__}") from e
        if r.status_code >= 300:
            raise StdbError(f"{reducer}: HTTP {r.status_code}: {r.text.strip()[:200]}")

    def sql(self, query: str) -> list[dict]:
        try:
            r = self._http.post(f"{self._base}/v1/database/{self._db}/sql", content=query, headers={"Content-Type": "text/plain"})
        except httpx.HTTPError as e:
            raise StdbError(f"sql: transport error: {type(e).__name__}") from e
        if r.status_code >= 300:
            raise StdbError(f"sql: HTTP {r.status_code}: {r.text.strip()[:200]}")
        data = r.json()
        result = data[0] if isinstance(data, list) else data
        cols = [el["name"]["some"] if isinstance(el["name"], dict) else el["name"] for el in result["schema"]["elements"]]
        return [dict(zip(cols, row)) for row in result["rows"]]


class SensorGateway:
    """Forwards REAL sensor readings to SpacetimeDB under the authorized `hardware_gateway` identity.

    The module (not this process) validates readings, detects excursions and opens incidents.
    """

    def __init__(self, client, node_id: str, name: str, temp_limit_c: float, humidity_limit_pct: float) -> None:
        self.client = client
        self.node_id = node_id
        self.name = name
        self.temp_limit_c = temp_limit_c
        self.humidity_limit_pct = humidity_limit_pct

    def register(self) -> None:
        self.client.call("register_sensor_node", [self.node_id, self.name, self.temp_limit_c, self.humidity_limit_pct])

    def ingest(self, temp_c: float, humidity_pct: float) -> None:
        try:
            self.client.call("ingest_sensor_reading", [self.node_id, temp_c, humidity_pct])
        except StdbError as e:
            if "not registered" not in str(e):
                raise
            self.register()  # first reading after a fresh database: register lazily, then retry once
            self.client.call("ingest_sensor_reading", [self.node_id, temp_c, humidity_pct])

    def report_silent(self, detail: str) -> None:
        self.client.call("report_sensor_fault", [self.node_id, "silent", detail])


class IncidentAdapter:
    """Creates a server-side incident for a hardware signal and derives the device status."""

    def __init__(self, client) -> None:
        self.client = client
        self.incident_id: Optional[int] = None

    def refresh_real_incident(self) -> Optional[int]:
        """Follow the newest open REAL incident opened by the module from sensor data."""
        rows = self.client.sql("SELECT incident_id, status, scenario_type FROM incident")
        ids = [int(r["incident_id"]) for r in rows if r["scenario_type"] in REAL_SCENARIOS and r["status"] != "resolved"]
        if ids:
            latest = max(ids)
            if self.incident_id is None or latest > self.incident_id:
                self.incident_id = latest
        return self.incident_id

    # ---- trigger -------------------------------------------------------------
    def _active_incident(self, scenario_type: str) -> Optional[int]:
        rows = self.client.sql(f"SELECT incident_id, status FROM incident WHERE scenario_type = '{scenario_type}'")
        ids = [int(r["incident_id"]) for r in rows if r["status"] != "resolved"]
        return max(ids) if ids else None

    def trigger(self, scenario_id: str) -> dict:
        """Launch (or adopt) the incident for this scenario and request an AI investigation."""
        scenario_type = SCENARIO_MAP[scenario_id]
        title = f"Hardware-triggered simulation {scenario_id} from uno-r4-01"
        adopted = False
        try:
            self.client.call("launch_simulated_incident", [scenario_type, title])
        except StdbError as e:
            if "already active" not in str(e):
                raise
            adopted = True  # someone already launched it; follow that incident instead of failing
        incident_id = self._active_incident(scenario_type)
        if incident_id is None:
            raise StdbError("incident not found after launch")
        self.incident_id = incident_id
        investigation_requested = False
        if not adopted:
            try:
                self.client.call("request_ai_investigation", [incident_id])
                investigation_requested = True
            except StdbError:
                pass  # incident still exists; a human can request the investigation from the UI
        return {"incident_id": incident_id, "adopted": adopted, "investigation_requested": investigation_requested}

    # ---- status mapping ------------------------------------------------------
    def device_state(self) -> Optional[str]:
        """Map the tracked incident's authoritative state to the device's status enum."""
        iid = self.incident_id
        if iid is None:
            return None
        inc = self.client.sql(f"SELECT status FROM incident WHERE incident_id = {int(iid)}")
        if not inc:
            return None
        status = inc[0]["status"]
        recs = self.client.sql(f"SELECT status FROM recovery_action WHERE incident_id = {int(iid)}")
        finds = self.client.sql(f"SELECT kind, approval_status FROM ai_finding WHERE incident_id = {int(iid)}")
        invs = self.client.sql(f"SELECT status FROM ai_investigation WHERE incident_id = {int(iid)}")

        if status in ("resolved", "recovering") or any(r["status"] == "approved" for r in recs):
            return "RECOVERED"
        if any(r["status"] == "pending" for r in recs) or any(
            f["kind"] == "recommendation" and f["approval_status"] == "pending" for f in finds
        ):
            return "AWAITING_APPROVAL"
        if any(i["status"] in ("requested", "running") for i in invs) or status == "investigating":
            return "INVESTIGATING"
        return "ALERT"
