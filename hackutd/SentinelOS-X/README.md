# SentinelOS X

Real-time cyber incident command center built on a live **digital twin** of an organization's infrastructure. HackUTD 2026 — targeting NVIDIA *Nemotron Beyond a Chatbot*, Winstead PC *Cyber Incident Response Dashboard*, and SpacetimeDB *Real-Time Application*.

What's built (hardware is optional — everything below works without it):

- **SpacetimeDB backend** — authoritative state, role-enforced reducers, audit log, and a deterministic **blast-radius engine** (root / direct / indirect / potentially exposed, cycle-safe, overlap-safe).
- **Phase 2 simulation engine** — a scheduled reducer drives four synthetic scenarios. Containment and two-person recovery are real state transitions (Recovering → Healthy), and the engine generates bounded six-metric synthetic telemetry.
- **Command center UI**:
  - an interactive digital twin with 16 services: search, health/type filters, a blast-radius overlay, zoom/fit/reset, labels, drag and stable layout;
  - an incident list with search/filter/sort;
  - incident detail with blast radius, evidence, containment and recovery controls;
  - multi-user incident command and a risk overview.
- **Synthetic telemetry service** (optional) — external software generator. The built-in engine now covers this by default.
- **NVIDIA Nemotron investigation agent** — tool-calling agent with read-only twin tools and deterministic what-if analysis; recommendations require human approval. Hardened with tool-call budgets, duplicate suppression, evidence-citation checks, prompt-injection guards, retries and secret redaction.
- **Response Decision Lab** (`/lab`) — compares *isolate*, *restore*, *fail over* and *staged* responses on a copy of the authoritative state with the same deterministic engine; before/after graph, preconditions, approvals, risks and assumptions; hypothetical strategies are labeled; proposals are revalidated server-side and need a second responder to adopt; **Explain with Nemotron** explains the engine's results with checked evidence citations. See [docs/decision-lab.md](docs/decision-lab.md).
- **Real sensor extension (optional)** — DHT11 on an Arduino UNO R4 WiFi via a Python bridge (`../hardware`). Real readings open real incidents; dependent-service impact stays *modeled*.
- **Pre-demo validation** — `npm run preflight` prints PASS / FAIL / SKIPPED for every dependency, read-only.
- **NVIDIA OpenShell sandbox config** — least-privilege policy and provider profile for running the agent sandboxed (validated with OpenShell's own validators).

> All infrastructure data and telemetry are **synthetic**, except readings from the optional physical sensor. Nothing touches real systems, files or networks.

---

## 1. Architecture

```
 Browser tabs ──┐                        ┌──────────── SpacetimeDB (authoritative) ────────────┐
 (responders)   ├─ WebSocket, SDK 2.14 ──┤ 26 tables · 40 reducers + 3 lifecycle hooks        │
 Telemetry svc ─┤  subscriptions +       │ propagation engine · roles · service authorization │
 Nemotron agent ┘  reducer calls         └─────────────────────────────────────────────────────┘
        │
        └── HTTPS ──► NVIDIA API (integrate.api.nvidia.com, OpenAI-compatible)  [optionally inside OpenShell]
```

| Directory | What |
|---|---|
| `spacetime/` | SpacetimeDB TypeScript module + tests |
| `frontend/` | React 19 / Vite / Tailwind 4 / React Flow / Recharts app |
| `services/` | Node services: `telemetry` (synthetic metrics) and `agent` (Nemotron investigator), plus `openshell/` sandbox config |
| `docs/` | architecture, data model, security model, demo guide, Phase 3 handoff |
| `simulations/` | scenario catalogue with expected blast radii |

Every service is its own SpacetimeDB identity: it announces itself, stays **pending** until an Incident Commander authorizes it in *System Settings → Services*, and every write is checked server-side.

## 2. Prerequisites (macOS)

- Node.js **22.23+** and npm
- SpacetimeDB CLI: `curl -sSf https://install.spacetimedb.com | sh` (project pinned to 2.14.1; if needed `spacetime version install 2.14.1 && spacetime version use 2.14.1`)
- For the AI agent: an NVIDIA API key from https://build.nvidia.com
- Optional, for sandboxing the agent: NVIDIA OpenShell (Apple Silicon or Linux, with Docker)

## 3. Install & run

```bash
cd SentinelOS-X
npm run install:all                          # spacetime/, frontend/, services/

# Terminal 1 — database server
spacetime start

# Terminal 2 — publish module and start the UI
npm run publish:local                        # non-destructive: keeps existing data (see "Upgrading" below)
npm run dev                                  # http://localhost:5173

# Optional — Nemotron investigator
cp services/.env.example services/.env       # then set NVIDIA_API_KEY
npm --prefix services run agent:check        # verifies key, endpoint and model
npm --prefix services run agent
```

The first browser that connects triggers an idempotent environment check. It seeds any missing services (16 total) and starts the simulation engine, which ticks every 3 s. The first registered user becomes Incident Commander. If you run the agent, authorize it in **Settings → Services**.

The external telemetry generator (`npm run telemetry`) is optional. While the built-in engine is on, `ingest_telemetry` is rejected so the two never mix. To use the external generator, pause *Built-in telemetry* in Settings first.

### Upgrading an existing Phase 1 database (no data loss)

Phase 2 only **adds** tables (`incident_effect`, `incident_evidence`, `telemetry_metric`, `simulation_state`, private `simulation_schedule`). SpacetimeDB's own migration planner, run against the Phase 1 schema, reports:

```
▸ Created user table: incident_effect (public)
▸ Created user table: incident_evidence (public)
▸ Created user table: simulation_schedule (private)
▸ Created user table: simulation_state (public)
▸ Created user table: telemetry_metric (public)
AUTO-MIGRATION: OK
BREAKS_CLIENTS (disconnects all users): false
```

So `npm run publish:local` upgrades in place. On the next connection the module:
- adds the 5 new services;
- starts the engine;
- converts any Phase 1 asset faults into effects.

**Do not use `publish:fresh` or `--delete-data`** unless you deliberately want to erase the database.

### Service configuration (`services/.env`)

| Variable | Default | |
|---|---|---|
| `SPACETIMEDB_HOST` / `SPACETIMEDB_DB_NAME` | `ws://localhost:3000` / `sentinelos-x` | |
| `TELEMETRY_INTERVAL_MS` | `2000` | min 1000 |
| `NVIDIA_API_KEY` | — | required for the agent; it never claims work without one |
| `NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com/v1` | any OpenAI-compatible NIM endpoint |
| `NEMOTRON_MODEL` | `nvidia/nemotron-3-super-120b-a12b` | `agent:check` lists the Nemotron models your key can see |
| `NEMOTRON_THINKING` | `false` | sets `chat_template_kwargs.enable_thinking` |
| `AGENT_MAX_TURNS` | `12` | 3–20 |

Frontend: `frontend/.env` (`VITE_SPACETIMEDB_HOST`, `VITE_SPACETIMEDB_DB_NAME`). Never put secrets in `VITE_*`.

### Running the agent inside NVIDIA OpenShell (optional)

```bash
export NVIDIA_API_KEY=...
./services/openshell/run-agent.sh
```

The policy (`services/openshell/policy.yaml`) allows egress **only** to `integrate.api.nvidia.com` (POST `/v1/chat/completions`, GET `/v1/models`) and SpacetimeDB on the host (`host.openshell.internal:3000`), only for `node`. The provider profile injects the API key solely for the NVIDIA endpoint, so the agent never sees the real key.

## 4. Testing

```bash
npm run check     # every typecheck, test suite and build below (exit 0 = all green)
npm run preflight # live, read-only readiness report against the running stack

# Python services (outside SentinelOS-X/)
cd ../agent    && python -m pytest -q    # standalone Python agent (live NVIDIA tests skipped unless RUN_LIVE_NVIDIA_TESTS=1)
cd ../hardware && python -m pytest -q    # hardware bridge
```

**Current results (final pass):** module 97 passed / 1 skipped · services 43 · frontend 37 · Python agent 148 passed / 2 skipped (live) · hardware bridge 44. A live end-to-end run (real SpacetimeDB 2.14.1 server, real UI, two browser identities, real agent process against a **mock** OpenAI-compatible endpoint) passed 15/15 checks. Details in [FINAL_HACKUTD_READINESS.md](FINAL_HACKUTD_READINESS.md).

Earlier per-suite description (counts below are from Phase 2):

| Suite | Count | What |
|---|---|---|
| `spacetime` | 50 (+1 fixture exporter, skipped unless `EXPORT_SCENARIO` is set) | `propagation` (11), `blast` (13): engine edge cases (empty graph, unknown or disconnected assets, duplicate edges, cycles, determinism), all four scenario rules, recovering, overlaps, containment. On SpacetimeDB's WASM module harness: `scenarios` (10) covers idempotent seeding, upgrade/migration via `onConnect`, scenarios A–D end-to-end, overlapping incidents, permissions and transitions, the scheduler-only tick and 60-tick bounds. `index` (9) and `services` (7) cover the Phase 1 reducers |
| `services` | 14 | Telemetry generator; NVIDIA client against a local stub; agent tools on the real seed topology; investigation loop with a scripted model |
| `frontend` | 27 | Every page rendered with rows produced by the real reducers and scheduler; twin search, filters and selection; blast-radius view model; incident search and sort; disconnected and empty states |

`spacetime build -p spacetime` validates the module bundle.

**Browser verification** (headless Chrome, run during development and not part of `npm run check`):
- The production build boots on every route with **zero page errors**. With no server it shows the exact disconnected message.
- A temporary fixture harness (since removed) passed **51/51 interaction checks** with zero console errors:
  - twin node click, search, filters, overlay, zoom, labels, drag stability;
  - scenario modal;
  - incident search/filter/sort;
  - the containment, recovery-approval and launch reducer calls (the arguments the UI sends);
  - Recovering (blue) state, exact empty and disconnected texts;
  - no horizontal scroll at 390 px. Regenerate client bindings after schema changes with `npm run generate`; regenerate the frontend fixture with `cd spacetime && EXPORT_SCENARIO=$PWD/../frontend/src/tests/fixtures/scenario.json npx vitest run scripts`.

## 5. Sponsor integrations (what is actually used)

| Sponsor | How it is used | Where |
|---|---|---|
| **NVIDIA Nemotron** | OpenAI-compatible tool calling against `integrate.api.nvidia.com`. The agent picks read-only twin tools, records findings that must cite retrieved evidence, recommends recovery for human approval, and explains Decision Lab comparisons from the deterministic engine's output. It cannot change state. | `services/src/agent/` |
| **SpacetimeDB** | The only source of truth: 26 tables, role-checked reducers, scheduled simulation reducer, subscriptions to every client and service, service identities that need IC authorization. The Decision Lab revalidates proposals inside a reducer. | `spacetime/src/index.ts` |
| **Winstead PC (incident response)** | Incident lifecycle, blast radius, evidence, containment, two-person recovery, decisions, audit log, and the Decision Lab for comparing responses before acting. | `frontend/` |

## 6. Demo

See [docs/demo-guide.md](docs/demo-guide.md) for the six-scene judge script and [docs/DEMO_RECOVERY.md](docs/DEMO_RECOVERY.md) for fixes. In short:
1. Open two browser windows (each tab is its own identity).
2. Launch *Authentication compromise* and watch the blast radius appear in both.
3. Inspect evidence, then apply containment.
4. Ben requests recovery and Ada approves it: Recovering (blue) → Healthy in both windows.
5. Open **Decision Lab** on a database outage: compare responses, *Explain with Nemotron*, propose in one window and adopt in the other.

Scenario details are in [simulations/README.md](simulations/README.md). The AI integration plan is in [docs/phase3-handoff.md](docs/phase3-handoff.md).

## 6. Known limitations

- **No verified identity**: SpacetimeDB identities are anonymous tokens; roles are enforced server-side, but dev-mode role self-service is on by default (an IC can disable it). No SSO.
- **Not end-to-end encrypted**; all tables are public to subscribed clients.
- **Denied actions are not audited** (the failed reducer's transaction rolls back).
- **Single machine** = logical separation only.
- **Agent quality depends on the model**; outputs are labeled AI-generated, recommendations are limited to restoring root-cause assets, and nothing executes without two humans.
- **Not run live in the build environment**: the SpacetimeDB server, NVIDIA API and OpenShell were not reachable there.
  - The module ran on SpacetimeDB's WASM test harness (real datastore and reducers, including the scheduled tick).
  - `spacetime build` and the official migration planner ran.
  - The UI ran in headless Chrome against reducer-produced data.
  - **Live two-browser sync over a real server has not been run here** — check it with the checklist in the demo guide.
- **Simulation fidelity**: scenarios, evidence and telemetry are synthetic and illustrative, not a model of real attacker behavior.
- **Graph on phones**: the twin is usable at 390 px (list, filters and details), but the graph itself is small. Use the Services list on mobile.
