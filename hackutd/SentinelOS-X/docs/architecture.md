# SentinelOS X — Architecture (Phase 2)

## Component boundaries

| Component | Responsibility | Owns state? |
|---|---|---|
| `spacetime/src/index.ts` | Schema (22 tables), 30 reducers + 3 lifecycle hooks, scheduled simulation engine, permission checks, audit | **Yes — sole authority** |
| `spacetime/src/propagation.ts` | Pure, deterministic engines: `computeImpacts` (Phase 1) and `computeBlastRadius` / `resolveEffect` / `severityFromBlast` (Phase 2) | No (pure functions) |
| `spacetime/src/telemetry.ts` | Pure synthetic six-metric generator used by the engine tick | No |
| `spacetime/src/validation.ts` | Input validation and state-transition rules | No |
| `spacetime/src/seed.ts` | Synthetic infrastructure (16 services, 21 edges), four scenarios, synthetic evidence templates | No (inserted into DB by reducers) |
| `frontend/src/hooks/useSentinelData.tsx` | One `useTable` subscription per table, shared via context | Cache of subscribed rows only |
| `frontend/src/hooks/useAction.ts` | Reducer invocation; success shown only after server commit | No |
| `frontend/src/lib/blast.ts`, `twinFilters.ts`, `derive.ts` | View models: group recorded `incident_asset` rows into root/direct/indirect/exposed, search/filter/sort | No — they never recompute authoritative impact |
| `frontend/src/features/*` | Pages | UI state only (filters, selection, overlay, dragged node positions, modals) |
| `services/src/telemetry` | Synthetic telemetry generator (separate SpacetimeDB identity) | No |
| `services/src/agent` | Nemotron investigator: NVIDIA API client, tools, investigation loop | No (writes via agent reducers) |

The frontend never computes authoritative state. Health, impact type, blast radius, severity and timeline are computed server-side inside reducer transactions and arrive via subscriptions. The scenario launcher's "preview" runs the same pure engine locally and is labeled *Preview only*.

## Data flow

```
user click ──► conn.reducers.launchSimulatedIncident(...)        (WebSocket call)
                      │
                      ▼  one ACID transaction inside SpacetimeDB
      requireRole ─► validate ─► insert incident ─► insert incident_effect (+ synthetic evidence)
                      ─► applyPropagation(): computeBlastRadius() over ALL live effects → asset rows
                                             computeBlastRadius() per incident → incident_asset rows
                      ─► update changed asset rows · upsert incident_asset rows
                      ─► insert incident_event rows (cause → effect order)
                      ─► recompute severity ─► audit_event
                      │
                      ▼  commit
      every subscribed client receives row inserts/updates ─► React re-renders
      calling client's promise resolves ─► success toast
```

If any step throws (`SenderError` for validation/authorization), the whole transaction rolls back, no client sees partial state, and the caller's promise rejects with the message.

## Dependency graph semantics

A directed edge **A → B** means: *"Component A requires Component B to provide its intended service."* A is the dependent, B the required asset. Failures propagate **against** edge direction.

| Edge type | B offline | B degraded |
|---|---|---|
| `required` | A **offline** | A **degraded** |
| `noncritical` | A **degraded** | A **degraded** |
| `optional` | no effect | no effect |

Algorithm (`computeImpacts`): worklist from directly failed assets; each asset's level only increases (healthy → degraded → offline) so each asset is requeued at most twice → guaranteed termination on cyclic graphs. Ties are broken by sorted asset IDs, so output is identical regardless of input order (tested).

Stored classification per asset:

| Situation | `operational_status` | `health_status` | `impact_type` |
|---|---|---|---|
| Healthy | online | healthy | none |
| Degraded (direct or cascade) | degraded | degraded | direct / cascade |
| Directly failed (fault injected) | offline | **critical** | direct |
| Taken down by a dependency | offline | **offline** | cascade |

Severity (`severityFromImpacts`): mission-critical asset offline → critical; high offline or mission-critical degraded → high; other offline or high degraded → medium; else low. Once all impacts recover, the incident keeps its last severity for the record.

The demo topology has 16 services and 21 edges: the 11 Phase 1 assets (`SEED_*`) plus 5 Phase 2 services (`PHASE2_SEED_*`). The backup path is deliberately independent of production data stores.

```
dependent          requires (required)               noncritical                               optional
customer-portal    ext-gateway, app-api
admin-portal       auth-svc, app-api
app-api            auth-svc, primary-db              file-storage, payment-svc, message-queue  monitoring-svc
auth-svc           primary-db
payment-svc        auth-svc, primary-db              message-queue
notification-svc   message-queue
analytics-svc      message-queue                     primary-db
monitoring-svc     telemetry-gw
log-shipper                                          telemetry-gw
backup-svc         backup-vault                                                                monitoring-svc
```

The full edge list, with a rationale for each edge, is in `spacetime/src/seed.ts`.

## Phase 2: effects and blast radius

An incident never writes asset health directly. It attaches **effects** (`incident_effect`) to root assets: `outage`, `fault`, `overload`, `compromise` or `integrity`. Each effect has a phase: `active → contained → recovering → cleared`.

`resolveEffect` maps (kind, phase) to three things:
- an operational level;
- whether that level propagates;
- whether it creates *exposure*.

`computeBlastRadius` then works out the blast radius:
1. Runs `computeImpacts` over the propagating levels, the same worklist algorithm as above, so it is cycle-safe and deterministic.
2. Runs it again over active effects only, to tell *recovering* from *degraded*.
3. Runs a separate BFS from exposure roots over `required`/`noncritical` edges.

The result classifies every asset:

| Class | Meaning |
|---|---|
| root (`confirmed`) | Has its own effect |
| `unavailable` | Taken offline through dependencies |
| `degraded` | Degraded through dependencies |
| `exposed` | **Potentially** exposed (security), still operational |
| `none` | Unaffected |

It also gives the depth and the upstream cause.

Because asset health is recomputed from **all** live effects, overlapping incidents are correct by construction:
- Recovering one incident cannot clear another's impact.
- A recovering root that is still held down by another outage shows the worse state.

Per-incident rows (`incident_asset`) are computed from that incident's effects alone, so each incident keeps an accurate, auditable blast radius, including `recovering` and `recovered` rows.

| Situation | `operational_status` | `health_status` | `impact_type` |
|---|---|---|---|
| Root with critical effect | per effect | **critical** | direct |
| Root, contained overload | degraded | degraded | direct |
| Taken down by a dependency | offline | **offline** | cascade |
| Degraded by a dependency | degraded | degraded | cascade |
| Potentially exposed | online / per cascade | healthy (or worse) | exposed |
| Only recovering effects remain | degraded | **recovering** (blue) | direct / cascade |

Severity (`severityFromBlast`):
- Keeps the Phase 1 operational rules.
- Adds: a critical root is rated by its criticality, and an exposed mission-critical asset makes the incident at least *high*.

## Simulation engine

`simulation_schedule` holds one interval row (3 s), created idempotently by `ensureEnvironment`. The scheduler calls `simulation_tick`, which rejects any non-internal caller. Each tick:

- `recovering` effects clear after 2 ticks → `asset_restored` events.
- `overload` intensity: +0.2 per tick while active (→ `surge_escalated` at 1.0), −0.2 while contained.
- Periodic synthetic evidence every 5 ticks for live incidents.
- If telemetry is enabled: one six-metric sample per asset, shaped by the asset's live state.
  - Pruned to 40 per asset in `telemetry_metric`.
  - Mirrored to the Phase 1 `telemetry_sample` table, pruned to 30.

All work in a tick is bounded by the number of assets and effects. Telemetry is descriptive only; it never feeds back into health.

## Incident state transitions

```
open ──► investigating ◄──► contained ◄──► recovering
  └────────────► contained        recovering ──► investigating
any non-resolved ──(resolve_incident, IC only, all root causes recovered, no pending recoveries)──► resolved (terminal)
```

Enforced server-side in `validation.ts`; the UI only offers valid next states. The UI labels `open` as **Detected**. Phase 2 also moves status automatically, always forwards and only from earlier states:
- `apply_containment`: open/investigating → contained.
- Recovery approval: investigating/contained → recovering.

Response tasks: `todo ⇄ in_progress`, `→ blocked`, `→ done`, `done → in_progress` (reopen).

Containment: required before recovery for `compromise`, `overload` and `integrity` effects (`apply_containment`, IC or Analyst).

Recovery: `pending → approved | rejected`. Approval requires an Incident Commander who is **not** the requester (two-person rule). It moves the incident's effects on that asset to `recovering`, and the engine clears them after 2 ticks. Nothing real is executed.

## Real-time subscription behavior

- `SpacetimeDBProvider` (in `main.tsx`) owns a single connection built once with `useMemo`. It enables automatic reconnect; the SDK replays subscriptions after reconnect.
- `SentinelDataProvider` calls `useTable(tables.X)` once per table for the whole app. Pages read from context → no duplicate subscriptions per render or per page; `useTable` unsubscribes on unmount.
- "Ready" = every subscription has applied its initial snapshot. Pages show skeletons until then.
- Disconnection: the top bar shows *Disconnected* and a banner reads *"Connection to SpacetimeDB lost. Live actions are unavailable until reconnection."* with a retry button. Pages render the same message instead of stale data (`PageGate`), and `useAction` refuses to send while disconnected. There is no polling fallback and no localStorage substitute.
- Identity token is stored in `sessionStorage` → each tab is a distinct identity (deliberate for multi-responder demos); a refresh keeps the identity.

## Database ownership

SpacetimeDB is the single source of truth. Static seed data exists only in `seed.ts` and is inserted by the `init` and `seed_demo_infrastructure` reducers; the frontend never reads seed files.

## Trust boundaries

```
┌───────────── Boundary A: monitored infrastructure (synthetic, Phase 1–2) ────────────┐
│  modeled as rows in `asset` / `dependency`; synthetic software telemetry only          │
└────────────────────────────────────────────────────────────────────────────────────────┘
              ▲ only via authenticated, role-checked reducers (future: telemetry reducer)
┌───────────── Boundary B: incident command (SpacetimeDB + this frontend) ──────────────┐
│  does NOT depend on any monitored service for its own availability                    │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

On a single laptop this is a **functional demonstration of logical separation**, not proof of physical independence. Proving independence requires hosting Boundary B separately (e.g. SpacetimeDB Maincloud or a separate host) and testing failure of Boundary A's network.

## Services

```
simulation_tick (built-in, every 3 s) ──► telemetry_metric + telemetry_sample ──► UI sparklines / agent tools
external telemetry service (optional) ──ingest_telemetry──► same tables   (only while the built-in engine is disabled)

human ──request_ai_investigation──► ai_investigation(requested)
agent ──agent_claim_investigation──► running
      loop (≤ AGENT_MAX_TURNS):  NVIDIA chat/completions (tools) ──► execute tool locally on twin cache
                                 ──agent_record_step──► ai_step
                                 report_finding / recommend_recovery ──agent_record_finding──► ai_finding
      final answer ──agent_complete_investigation──► completed + timeline event
human ──decide_ai_recommendation(accept)──► recovery_action(pending, requested_by = human)
second IC ──decide_recovery──► restore + propagation
```

Agent tools: `get_incident`, `get_asset`, `get_dependencies`, `get_timeline`, `get_telemetry`, `simulate_recovery`, `simulate_failure` (both use the same `computeImpacts` as the server), `report_finding`, `recommend_recovery`.

Model access: OpenAI-compatible Chat Completions at `NVIDIA_BASE_URL` (default `https://integrate.api.nvidia.com/v1`), `tools` + `tool_choice: auto`, `chat_template_kwargs.enable_thinking` per the Nemotron model card.

## Integration boundaries

| Component | Status |
|---|---|
| NVIDIA Nemotron agent | **Implemented** (`services/src/agent`). Not run against the live API in the build environment (no egress); verified against an OpenAI-compatible stub. |
| NVIDIA OpenShell | **Config implemented** (`services/openshell`): policy + provider profile validated with OpenShell's own validator code; launcher script. Not executed in the build environment. |
| Telemetry | **Implemented** as synthetic software telemetry: built-in engine (Phase 2) or the external generator service. No hardware. |
| FastAPI (`backend/`) | Not needed so far; the agent calls NVIDIA directly. |
