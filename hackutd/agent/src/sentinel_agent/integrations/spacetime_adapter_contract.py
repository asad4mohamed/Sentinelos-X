"""LiveProvider: adapter CONTRACT for the main SentinelOS X backend (not implemented).

IMPORTANT
---------
* SpacetimeDB is the authoritative incident store. This service must never become a competing store.
* This repo does not contain Developer A's SpacetimeDB module, so NO SpacetimeDB schema or SDK usage is assumed here.
* The contract below is a PROPOSAL for what this agent needs. The main backend (which already holds the real
  SpacetimeDB connection and authentication) exposes validated, read-only HTTP endpoints; the agent calls them
  server-to-server with a service token. Field names must be agreed with Developer A before implementing.

Proposed read-only endpoints (all return JSON; timestamps ISO 8601 UTC with 'Z'; IDs are strings):

    GET  {base}/agent-api/v1/incidents                        -> [Incident]
    GET  {base}/agent-api/v1/incidents/{incident_id}          -> Incident            (404 if unknown)
    GET  {base}/agent-api/v1/assets                           -> [Asset]
    GET  {base}/agent-api/v1/dependencies                     -> [Dependency]
    GET  {base}/agent-api/v1/assets/{asset_id}/logs?start&end&limit     -> [EvidenceRecord]
    GET  {base}/agent-api/v1/events/search?q&asset_id&start&end&limit   -> [EvidenceRecord]
    GET  {base}/agent-api/v1/evidence/{evidence_id}           -> EvidenceRecord      (404 if unknown)
    GET  {base}/agent-api/v1/incidents/{incident_id}/assets/{asset_id}/state -> EvidenceRecord

The JSON shapes are exactly the pydantic models in `sentinel_agent.models` (Incident, Asset, Dependency,
EvidenceRecord). Auth: header `X-Sentinel-Service-Token`. Anything the backend returns is treated as untrusted data.
"""

from __future__ import annotations

from .data_provider import DataProvider, ProviderError

_MSG = (
    "LiveProvider is a documented contract only. Implement it against the main backend's agreed endpoints "
    "(see docs/INTEGRATION_GUIDE.md) or run with AGENT_DATA_PROVIDER=fixture."
)


class LiveProvider(DataProvider):
    name = "live"
    data_source = "live_backend"

    def __init__(self, base_url: str, service_token: str):
        self.base_url = base_url.rstrip("/")
        self._service_token = service_token

    async def _unavailable(self, *_, **__):
        raise ProviderError(_MSG)

    get_incident = list_incidents = list_assets = list_dependencies = _unavailable
    get_logs = search_events = get_evidence = get_asset_state_evidence = _unavailable
