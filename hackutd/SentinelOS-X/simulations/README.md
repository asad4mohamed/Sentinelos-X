# simulations/

All scenarios are **defensive training simulations on synthetic state only**. They change database rows and nothing else: no commands, no network traffic, no file access, no real encryption.

Scenario definitions live in `spacetime/src/seed.ts` (`SCENARIOS`). The `launch_simulated_incident` reducer runs them. Each launch:

1. Creates an `incident` with `is_simulation = true`.
2. Attaches one `incident_effect` to the initial asset.
3. Writes synthetic `incident_evidence`.
4. Runs the deterministic blast-radius engine (`computeBlastRadius`) inside the same transaction.

The server refuses to launch a scenario of a type that is already active.

## Phase 2 scenarios (16-service topology)

The outputs below come from `computeBlastRadius` on `DEMO_ASSETS` / `DEMO_EDGES` and are asserted in `spacetime/src/scenarios.test.ts`. `@n` is the dependency depth.

| | Scenario (`scenario_type`) | Effect | Active state | After containment | Recovery |
|---|---|---|---|---|---|
| A | Authentication compromise (`auth_compromise`) | `compromise` on `auth-svc` | `auth-svc` **critical**. **Potentially exposed** (health stays *healthy*, shown as *at risk*): app-api, payment-svc, admin-portal @1, customer-portal @2. Severity **critical**. | *Revoke sessions & rotate signing keys*. The exposure is cleared; `auth-svc` stays critical until recovered. | Two-person approval → `recovering` → healthy after 2 engine ticks |
| B | Database outage (`database_outage`) | `outage` (offline) on `primary-db` | `primary-db` **critical**. **Offline**: auth-svc, app-api, payment-svc @1; customer-portal, admin-portal @2. **Degraded**: analytics-svc @1 (noncritical edge). Severity **critical**. | No containment step; recover directly. | Same two-person flow |
| C | Traffic surge (`traffic_surge`) | `overload` on `ext-gateway` | Starts at intensity 0.4: `ext-gateway` degraded, customer-portal degraded @1, severity medium. Intensity rises 0.2 per tick; at 1.0 the gateway is **saturated** (`critical`, `surge_escalated` event) and severity becomes **high**. | *Enable rate limiting & WAF challenge*. Intensity decays and the gateway drops back to degraded. | Same |
| D | Ransomware-like file service incident (`file_ransomware`) | `integrity` on `file-storage` | `file-storage` **critical**. **Degraded and exposed**: app-api @1; customer-portal, admin-portal @2. Severity **high**. | *Isolate service from the network*. File storage goes **offline** (isolated) and exposure stops; dependents stay degraded. | Same |

The Phase 1 scenario `simulated_ransomware` (`outage` on `primary-db`) is still accepted by the reducer, so existing scripts and data keep working.

### Overlapping incidents

Health is derived from **all** live effects, not from the last write:

- Two incidents that hit the same service both keep their impact.
- Recovering one incident never clears the other's impact.
- A root that is recovering but still held down by another incident's outage reports `offline` (or `degraded`), never `recovering`.

These cases are tested in `blast.test.ts` and `scenarios.test.ts`.

## Simulation engine

The scheduled reducer `simulation_tick` runs every 3 s; only the scheduler may call it. Each tick:

- Moves effects in `recovering` to `cleared` after 2 ticks.
- Escalates or decays `overload` intensity.
- Adds periodic synthetic evidence.
- Writes bounded synthetic metrics for each service. Each service keeps 40 rows in `telemetry_metric` and 30 in `telemetry_sample`.

An Incident Commander can pause telemetry generation in **Settings**. Recovery still completes while it is paused.

## Test fixture

`spacetime/scripts/export-scenario.test.ts` drives a full multi-incident response through the real reducers and the scheduled tick:

- A: contained, with a recovery pending.
- B: investigating, with a task, a decision and messages.
- C: saturated.
- A scripted AI investigation.

It exports the resulting rows to `frontend/src/tests/fixtures/scenario.json` for the frontend render tests.

```bash
cd spacetime && EXPORT_SCENARIO=$PWD/../frontend/src/tests/fixtures/scenario.json npx vitest run scripts
```
