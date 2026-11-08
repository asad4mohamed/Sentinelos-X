# Integration Guide (for the SentinelOS X dashboard / SpacetimeDB owner)

**What was and was not inspected:** only this `agent/` directory exists in the workspace. Developer A's React app and SpacetimeDB module were
**not available**, so nothing here assumes their schema or SDK. Items below marked *PROPOSAL* must be agreed with the app owner.

## Architecture

```
React dashboard ──► main backend (authenticates users, holds SpacetimeDB connection)
                        │  server-to-server, X-Sentinel-Service-Token
                        ▼
                 sentinel-agent (this service) ──► NVIDIA API (key lives only here)
                        │
                        └─ DataProvider (fixture today; LiveProvider = read-only calls back to the main backend)
```
The agent never writes incident state. SpacetimeDB remains authoritative; the backend persists whatever it wants from the agent's results.

## Step 1 — run it beside the backend
Set `NVIDIA_API_KEY`, `AGENT_SERVICE_TOKEN` (long random value, also configured in the backend), leave `AGENT_DEMO_MODE=false`,
and keep CORS off (`AGENT_CORS_ORIGINS` empty). The browser must not call the agent directly.

## Step 2 — start an investigation from the backend
```bash
curl -s -X POST http://agent:8100/api/investigations -H "X-Sentinel-Service-Token: $TOKEN" \
     -H "Content-Type: application/json" -d '{"incident_id":"INC-003"}'
# 202 {"investigation_id":"INV-…","status":"queued","links":{…}}
```
Incident IDs are plain strings (`^INC-[A-Za-z0-9-]{1,32}$` today). If your IDs differ, tell the agent owner: the pattern lives in
`models.INCIDENT_ID_PATTERN`. Asset IDs are lowercase slugs (`primary-database`). Map your SpacetimeDB identities to these strings at the
boundary (e.g. a text column), not raw numeric IDs.

## Step 3 — show progress step by step
Poll `GET /api/investigations/{id}/events?after=<next_after>` (e.g. every 1 s) and render events by `type` (see API_CONTRACT). `tool_call_*`
events carry `seq` and `evidence_ids`; `state_changed` carries `from_state/to_state`. The final `awaiting_approval` event carries `proposal_id`.
Relay these to the browser through your own backend (or write them into a SpacetimeDB table you own).

## Step 4 — render the result
`GET /api/investigations/{id}/report` → `InvestigationResult`. Chart data: `recovery_options[].chart` (`labels`, `before`, `after` as 0/1/2 =
healthy/degraded/unavailable) and `status_counts`. Show `findings` grouped by `classification` (observed fact / inference / hypothesis /
recommendation) with their `certainty` label and clickable `evidence_ids` resolved from `evidence[]`. Show `limitations` and
`rejected_model_claims` prominently. Treat every string as untrusted text (escape it; never render as HTML).

## Step 5 — approvals
The user clicks Approve/Reject in the dashboard → your backend authenticates them and calls:
```bash
curl -s -X POST http://agent:8100/api/proposals/PRP-…/decision \
  -H "X-Sentinel-Service-Token: $TOKEN" -H "X-Authenticated-User-Id: <backend-verified id>" \
  -H "X-Authenticated-User-Role: incident_commander" -H "Content-Type: application/json" \
  -d '{"decision":"approve","reason":"…"}'
```
Roles accepted: `incident_commander`, `security_admin` (edit `security/approvals.APPROVER_ROLES` to map your roles). **The agent does not
perform the action**; on approval your backend applies the change in SpacetimeDB (and should itself re-check authorization).

## Step 6 (optional) — LiveProvider
`integrations/spacetime_adapter_contract.py` documents a *PROPOSED* read-only HTTP contract the backend would expose
(`/agent-api/v1/incidents`, `/assets`, `/dependencies`, `/assets/{id}/logs`, `/events/search`, `/evidence/{id}`, per-incident asset state),
returning JSON shaped like `models.Incident / Asset / Dependency / EvidenceRecord`. To implement: subclass `DataProvider`, call those
endpoints with the service token, validate responses through the pydantic models, and set `AGENT_DATA_PROVIDER=live`
(wire it in `main.create_app`). Requirements the agent relies on:
* `Incident.observed_asset_states` — per-asset status at incident time; `candidate_strategies` — recovery options with scenario assumptions; `triage_hypotheses`.
* Evidence IDs stable across calls (`EVT-*` logs, `DEP-*` edges, `AST-<incident>-<asset>` snapshots); logs with UTC timestamps.
* Dependency edges with `critical`/`optional` kinds (`A->B` = A depends on B) and an acyclic-or-handled graph.
Until this exists the agent only analyzes the bundled synthetic fixtures.

## Caveats
Investigations live in memory (lost on restart; restart = 404 for old ids). Persist what you need from `/report`. One process only; do not run multiple replicas behind a load balancer without sticky routing.
