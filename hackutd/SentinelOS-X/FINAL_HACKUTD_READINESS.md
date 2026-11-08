# SentinelOS X — Final HackUTD Readiness

Prepared 2026-11-08 (submission deadline 12:00 PM CT). Everything below states what was **actually run**. Nothing here claims a live NVIDIA call or a physical-hardware run that did not happen during this pass.

## 1. Repository audit (before changes)

| Area | Location | State found |
|---|---|---|
| Frontend entry | `SentinelOS-X/frontend/src/main.tsx` → `app/App.tsx` | React 19 / Vite 7, 7 routes, one shared subscription provider |
| Backend | `SentinelOS-X/spacetime/src/index.ts` | 24 tables, 33 reducers, server-side role checks, scheduled simulation tick |
| Blast radius / simulation | `spacetime/src/propagation.ts`, `telemetry.ts`, `seed.ts` | Deterministic, cycle-safe, 4 scenarios, 16 services |
| Nemotron (integrated) | `SentinelOS-X/services/src/agent/` (Node) | Tool-calling loop wired to SpacetimeDB; **this is the agent used in the demo** |
| Nemotron (standalone) | `agent/` (Python FastAPI) | Separate fixture-based service with its own safeguards; **not wired to SpacetimeDB** |
| Hardware | `hardware/bridge.py`, `stdb_adapter.py`, `SentinelArduino/` | Real DHT11 path verified live by the team on 2026-11-07 (see `hardware/HARDWARE_DEMO.md`) |
| Git state | `SentinelOS-X` on `hardware-sensor` with ~30 uncommitted files; `agent` with 4 uncommitted files; `hardware/` not a repo | Uncommitted work preserved as a baseline commit on new branch `hackutd-final` |
| Baseline tests | — | All green: module 71 (+1 skip), services 24, frontend 31, Python agent 148 (+2 skip), bridge 41 |

**Risks found:** live credentials in the shared archive (git-ignored, not in git history); Node agent had no tool-call cap, no retry, no duplicate suppression, no evidence-grounding check, and could write raw error text (possibly containing request details) to public tables; `tool_choice` sent with an empty tool list; bridge read the whole body before the size check and had no flood limit; no `hardware/.env.example`; docs said "no hardware".

## 2. Implemented in this pass

1. **Response Decision Lab** (new page `/lab`, see `docs/decision-lab.md`)
   - Pure engine `spacetime/src/decisionLab.ts`: isolate / restore / fail over / staged; before, staged and after snapshots; restored / made worse / still affected; preconditions; approvals; residual risks; assumptions; unsupported operations; warnings. No invented quantities.
   - Reducers: `propose_response`, `decide_response_proposal`, `withdraw_response_proposal`, `request_decision_explanation`, `cancel_decision_explanation`, `agent_claim_explanation`, `agent_complete_explanation`. Tables `response_proposal`, `decision_explanation` (additive migration — verified with `spacetime publish` on a populated database).
   - Server-side revalidation with a state fingerprint (stale → rejected), two-person adoption, adoption executes nothing, reset withdraws pending plans.
   - UI: incident picker, evidence list, 4 comparison cards, before/after graph with stage tabs, Explain with Nemotron (degraded state when no agent), Propose This Response, review list, inline existing controls for adopted plans. Links from Incidents and Incident Command.
2. **Nemotron hardening** (Node agent): retries with backoff for 429/5xx/network, clear 401/404/429 messages, malformed-response handling, secret redaction, tools/tool_choice only when tools exist, per-turn (6) and total (24) tool-call caps, wall-clock budget, duplicate read-call cache, duplicate-finding suppression, evidence-grounding check for findings, sanitized untrusted title + explicit untrusted-data rules, explanation worker with citation and invented-quantity checks.
3. **Security**: secret scan (none tracked), `hardware/.env.example`, updated `services/.env.example`, bridge `Content-Length` pre-check and flood guard, rotation list, documented dev-only limits.
4. **Demo reliability**: `npm run preflight` (read-only PASS/FAIL/SKIPPED: server, module + Decision Lab tables, seeding, scheduler ticks, IC + second responder, role self-service, agent authorized/online, scenario launchable, real incidents open, engine on live graph, stuck AI requests, NVIDIA key presence without value, model, frontend, bridge, sensor freshness, gateway authorization, secrets in git). `docs/DEMO_RECOVERY.md`.
5. **Docs**: README (features, tests, sponsor table), `docs/demo-guide.md` (six scenes), `docs/decision-lab.md`, `docs/security-model.md` addendum, `hardware/HARDWARE_DEMO.md` final notes.

## 3. Test results (commands actually run, this session, Linux, Node 22.23, Python 3.13)

| Command | Exit | Result |
|---|---|---|
| `npm run check` (from `SentinelOS-X/`) — typecheck + tests + builds for module, services, frontend | 0 | module **97 passed, 1 skipped** (fixture exporter) · services **43 passed** · frontend **37 passed** · services and frontend builds OK |
| `python -m pytest -q` in `agent/` (no `NVIDIA_API_KEY` in env) | 0 | **148 passed, 2 skipped** (live NVIDIA tests, opt-in) |
| `python -m pytest -q` in `hardware/` | 0 | **44 passed** |
| `spacetime publish -s local -p spacetime -y sentinelos-x` (SpacetimeDB 2.14.1 standalone) | 0 | Upgrade of a populated DB: only `CREATE TABLE` steps for the 2 new tables |
| `npm run generate` | 0 | Bindings regenerated; frontend + services compile |
| Live end-to-end (Playwright, real server, real Vite UI, 2 browser identities, real agent process, **mock** LLM endpoint) | 0 | **15/15**: registration, agent authorization, outage launch, 4 cards, failover labeled hypothetical, proposal visible in 2nd client, two-person notice, adoption sync, no auto-execution, explanation rendered with citations in both clients, two-person recovery → nothing left to respond to, refresh keeps identity, no horizontal scroll at 390 px, zero page errors |
| `npm run preflight` against that stack | 1 (expected) | 15 PASS · 1 FAIL (test incident deliberately left open) · 1 SKIPPED (no bridge in the cloud test environment) |

New tests added: 17 engine + 9 reducer (module), 14 agent safeguards/resilience + 5 explanation (services), 6 Decision Lab page (frontend), 3 bridge.

**The live end-to-end run proved the explanation guard works:** on the first attempt the mock model cited `[E12]` (copied from the system prompt's example); the agent rejected it as non-existent evidence and marked the request failed instead of showing it.

## 4. Not verified in this pass (be explicit with judges)

- **No live NVIDIA call was made in this pass.** The real key was never used; all model behaviour above is mocked. The team's previously recorded live runs are in `hardware/HARDWARE_DEMO.md` and `agent/README.md`. **Run `npm --prefix services run agent:check` and one real explanation before judging.**
- **No physical hardware was exercised in this pass** (cloud environment). Firmware was not changed, so no re-flash is needed; the bridge changes are covered by unit tests.
- Real Nemotron output quality for Decision Lab explanations (only the guards are tested).
- Concurrent proposals from many clients beyond two.

## 5. Known limitations

- Failover and isolation of outages are **hypothetical** (no backend operation, no standby in the twin) — labeled in UI and stored with `support = hypothetical`.
- The lab models one incident at a time; other open incidents are reported as warnings, not combined.
- Identities are anonymous; role self-service is on; one person with two tabs can satisfy the two-person rule.
- All tables are public (proposals and explanations included).
- The Python `agent/` is not wired to SpacetimeDB; it is a separate, tested component.

## 6. Security cleanup status

| Item | Status |
|---|---|
| Secrets tracked by git (`SentinelOS-X`, `agent`) | None (checked tree + history for `nvapi-` keys; repeated by preflight) |
| `.env` / token / `arduino_secrets.h` ignored | Yes, all three `.gitignore` files cover them |
| `.env.example` / templates | `services`, `frontend`, `agent`, `hardware` (new), Arduino template |
| Reducer authorization | Reviewed all 40 reducers: every state change checks role or service authorization server-side; new reducers enforce proposer ≠ decider and authorized `ai_agent` only |
| **Rotate (manual)** | NVIDIA API key (in `services/.env` and `agent/.env`, and previously reported exposed), `SENTINEL_DEVICE_TOKEN`, `SENTINEL_ADMIN_TOKEN`, SpacetimeDB identity tokens in `hardware/.env` and `services/.tokens/`, Wi-Fi password in `arduino_secrets.h`. Removing a file does not revoke a credential. |

## 7. Manual actions still required

1. **Rotate the NVIDIA key** at build.nvidia.com, put the new one in `services/.env` (and `agent/.env` if used).
2. On the demo laptop: `npm run publish:local` (non-destructive) so the database gets the Decision Lab tables, then `npm run dev`, `npm run agent`.
3. `npm --prefix services run agent:check`, then click **Explain with Nemotron** once on a test incident to confirm the live model.
4. `npm run preflight` (add `-- --hardware` if showing the sensor) until **Demo-ready**.
5. Decide whether to merge `hackutd-final` into your main branch; push it if you want it in the submission.

## 8. Launch commands

```bash
spacetime start                                  # terminal 1
cd SentinelOS-X && npm run install:all           # once
npm run publish:local                            # never publish:fresh
npm run dev                                      # http://localhost:5173
npm run agent                                    # terminal 3, needs services/.env
cd ../hardware && python -m uvicorn bridge:app --host 0.0.0.0 --port 8765   # optional (load hardware/.env first)
cd ../SentinelOS-X && npm run preflight
```

Judge script: `docs/demo-guide.md`. Recovery: `docs/DEMO_RECOVERY.md`.

---

# Sprint 2 (2026-11-08, early morning) — attack path, fallback, report, hardware prep

Rollback point: git tag `checkpoint-before-sprint2` (both `SentinelOS-X` and `hardware`). **No schema change** in this sprint: bindings regenerated identical; older UI code runs against the same database.

## A. Implemented

| Feature | Files |
|---|---|
| Attack-path explanation in the twin detail panel: confirmed root vs modeled impact/exposure, dependency path built only from `incident_asset.causedByAssetId` + `dependency` rows, real-event vs simulation tag, evidence references | `frontend/src/lib/derive.ts` (`explainImpact`), `features/digital-twin/AssetDetailPanel.tsx` |
| Rules-based fallback, labeled **"Rules-based analysis — NVIDIA AI unavailable"**; auto-shown when the agent is missing, unauthorized, offline, or the last investigation failed; otherwise a collapsed "deterministic, not AI" cross-check. Observed evidence, confirmed roots, modeled impact/exposure, the module's actual severity rules, Decision Lab options, missing evidence, limitations. No confidence scores, no root-cause guessing, writes nothing | `frontend/src/lib/rulesAnalysis.ts`, `features/ai-investigator/RulesAnalysisPanel.tsx`, `AiInvestigatorPage.tsx` |
| Incident report export (Markdown + printable HTML → Save as PDF) from live rows: summary, provenance, affected services with basis, evidence (measured/synthetic), sensor readings, AI investigations with model, rules analysis, Decision Lab comparison + pick + proposals + AI explanations, recoveries with requester/approver, decisions, timeline | `frontend/src/lib/report.ts`, `components/ExportReport.tsx`, `IncidentsPage.tsx` |
| Decision Lab deterministic **engine pick** (executable only, preconditions first, then most restored / fewest disrupted / fewest affected) + "all results are hypothetical projections" banner | `spacetime/src/decisionLab.ts` (`recommend`), `DecisionLabPage.tsx` |
| Authorization regression tests (self-approval, duplicate decisions, unregistered callers, role forging, self-service off, AI agent cannot act as human/approve/contain, unauthorized gateway and humans cannot ingest readings, agent cannot write to unclaimed investigations) | `spacetime/src/security.test.ts` |
| Sensor-gateway status chip fixed: the HTTP gateway's `online` flag is only true during a call, so the chip now uses `lastSeenAt` (< 20 s) | `frontend/src/components/AppShell.tsx` |
| macOS bridge launcher (loads `.env` without printing it, creates venv, prints the laptop IP) | `hardware/start_bridge.sh` |
| macOS runbook: startup, credentials table, Arduino upload, hardware checklist, rollback | `docs/MACOS_RUNBOOK.md`; judge script updated in `docs/demo-guide.md` |

Firmware: **unchanged**. It already implements ✓ / X / hourglass / dashed-frame on the LED matrix and NORMAL, WARNING, ALERT, INVESTIGATING, APPROVAL NEEDED, RESOLVED, SENSOR ERROR, NO WIFI, NO BRIDGE on the OLED.

## B. Verification matrix

| Feature | Result | How |
|---|---|---|
| Module type-check + tests | **PASS** | `npm run check`: 108 passed, 1 skipped |
| Services type-check + tests + agent build | **PASS** | 43 passed, esbuild OK |
| Frontend type-check + tests + production build | **PASS** | 49 passed, `vite build` OK |
| Python agent tests | **PASS** | 148 passed, 2 skipped (live NVIDIA, opt-in) |
| Hardware bridge tests | **PASS** | 44 passed |
| Two-person / role / service authorization | **PASS** | 8 reducer tests on the real WASM datastore |
| Twin attack-path explanation (live UI) | **PASS** | E2E #2: dependent shows modeled path from Primary Database; sensor root shows "Confirmed root" + "real event" |
| Decision Lab pick + previews don't mutate state | **PASS** | E2E #2: asset health + effect phases identical before/after previewing 4 strategies; unit test for repeated previews |
| Nemotron investigation path | **PASS (mock model)** | Real agent process + real SpacetimeDB, OpenAI-compatible **mock** endpoint. Live NVIDIA: **NOT TESTED** this session |
| Fallback on agent offline | **PASS** | E2E #2: agent killed → labeled fallback appears, states it is not a language model |
| Fallback on failed investigation (invalid key / 429 / timeout) | **PASS (unit)** | UI test with a failed investigation row; client error handling covered by services tests |
| Report export (.md and printable .html) | **PASS** | E2E #2 downloads and checks content; unit tests on content and HTML escaping |
| Sensor data path: bridge → SpacetimeDB → UI, breach → **real** incident, bridge reports ALERT, two-person recovery → RECOVERED | **PASS (scripted device input)** | E2E #2 posted readings to the bridge from a script. **No physical board was involved.** |
| Gateway status chip online/offline | **PASS** | Live: online while bridge runs, offline 27 s after stopping it |
| Firmware compile | **BLOCKED** | Arduino board package server not reachable from this environment |
| Physical DHT11 / LED matrix / OLED behaviour | **NOT TESTED** (this session) | Needs you; checklist in `docs/MACOS_RUNBOOK.md` §4. Previously reported working by the team on 2026-11-07 |
| Live NVIDIA Nemotron call | **NOT TESTED** (this session) | Run `npm --prefix services run agent:check` |
| Your Mac's copy / database | **NOT TESTED** | This session cannot reach your Mac; all runs used a throwaway local SpacetimeDB 2.14.1 |

## C–G
Startup commands, credential names, Arduino instructions and rollback: `docs/MACOS_RUNBOOK.md`. Demo script: `docs/demo-guide.md`. Recovery: `docs/DEMO_RECOVERY.md`.

## H. Remaining limitations
- The rules-based fallback is computed in the browser and is not stored in SpacetimeDB (no schema change); it appears in the exported report.
- The report export uses the client's subscribed rows; the sensor-reading table in the client holds recent readings only.
- Exposure explanations only exist while exposure is live (containment removes it, by design).
- Everything in sections 4 and 5 of the first report still applies (identities, public tables, hypothetical strategies).

---

# Final audit (2026-11-08 morning) — macOS readiness

Input: `sentinelos-x-sprint2-nemotron-ready.zip`. It was identical to the verified sprint-2 code except one new file, `setup-nemotron-mac.sh`. Audit focused on running on macOS.

## A. Confirmed defects and fixes

| # | Severity | Defect (evidence) | Files | Fix |
|---|---|---|---|---|
| 1 | **Critical (macOS)** | Bridge crashed on import under Python 3.9, the `python3` that ships with macOS: `TypeError: Unable to evaluate type annotation 'str \| None'` (FastAPI/Pydantic evaluate annotations at runtime; PEP 604 needs 3.10). Reproduced with CPython 3.9.25: 38 errors / 1 failure | `hardware/bridge.py`, `hardware/stdb_adapter.py` | `Optional[...]`; new AST regression test `tests/test_py39_compat.py` (fails on old code, passes now); suite 45/45 on 3.9 **and** 3.13 |
| 2 | High (macOS) | Launcher used whatever `python3` was first and reused any existing `.venv`; a `.venv` copied from Windows (`Scripts/`, no `bin/`) or missing packages would break startup | `hardware/start_bridge.sh` | Picks newest Python ≥ 3.9 (`PYTHON=` override), rebuilds the venv when absent/broken, clearer IP + health-check output; tested with Python 3.9, Windows-style `.venv` and a CRLF `.env` |
| 3 | Medium | `setup-nemotron-mac.sh` saved a pasted key verbatim (trailing spaces/CR become part of the key → 401) and ran `agent:check` before dependencies existed | `setup-nemotron-mac.sh` | Strips whitespace/CR, warns on non-`nvapi-` keys, installs deps if missing; tested: key cleaned, other `.env` lines kept, CRLF normalized, mode 600, value never printed |
| 4 | Low (dev-only) | `npm audit`: 2 critical + 1 moderate in **Vitest** (test runner; exploitable only with Vitest UI server / attacker-controlled worker options). Full fix requires Vitest 4 (major) | `*/package.json` | **Not changed** (major test-framework upgrade hours before deadline is riskier than the dev-only exposure). Not shipped in the app |

Checked and **not** defects: CRLF `.env` files (Node `loadEnvFile` and the services' `env()` trim `\r`; `start_bridge.sh` strips it); firmware ↔ bridge contract (paths, `X-Device-Token`, JSON fields, status strings match); no IP or credentials in shared source (template uses a placeholder).

New: `mac-doctor.sh` (read-only prerequisite check: Node ≥ 22.12, npm, SpacetimeDB CLI 2.x, Python ≥ 3.9, Mac-native `node_modules`, `.env` key presence without values, ports 3000/5173/8765, current Mac IP). Runbook: hotspot fallback for campus Wi-Fi (2.4 GHz "Maximize Compatibility"), firewall prompt, IP-change procedure.

## C. Verification (commands actually run)

| Command | Result |
|---|---|
| Clean copy of the uploaded zip → `npm run install:all` → `npm run check` | exit 0 (fresh install works) |
| `npm run check` (final code) | exit 0 — module 108 passed / 1 skipped · services 43 · frontend 49 · builds OK |
| `pytest -q` in `agent/` (Python 3.13) | 148 passed, 2 skipped (live NVIDIA, opt-in) |
| `pytest -q` in `hardware/` on **Python 3.9.25** and 3.13 | 45 passed on each |
| `py_compile` bridge on 3.9; `compileall` agent + hardware on 3.13 | OK |
| `start_bridge.sh` with Python 3.9, Windows-style `.venv`, CRLF `.env` | venv rebuilt, `/health` ok, bad token → 401, valid reading → 202 |
| Live E2E #1 (proposals, two-person adoption, Nemotron explanation with citations via real agent + **mock** model, two-person recovery, refresh, 390 px) | **15/15** |
| Live E2E #2 (bridge **on Python 3.9** → SpacetimeDB → real incident, device ALERT, attack path, preview isolation, investigation via agent + **mock** model, offline fallback, report export, recovery → device RECOVERED) | **16/16** |

## E. Final readiness checklist

| Feature | Status |
|---|---|
| SpacetimeDB module, reducers, roles, two-person rule, service authorization | **Verified working** |
| Simulation scenarios, blast radius, digital twin + attack-path explanation | **Verified working** |
| Decision Lab (4 strategies, before/after, engine pick, proposals, preview isolation) | **Verified working** |
| Rules-based fallback, report export | **Verified working** |
| Nemotron agent pipeline (claim → tools → validated findings → UI; explanations with citation checks) | **Working with limitations** — verified with a mock model; live NVIDIA **requires configuration** (`./setup-nemotron-mac.sh`) and is **not yet verified** here |
| Nemotron explanation scope | **Working with limitations** — explains the trade-offs across all four strategies for the chosen root service, not one strategy at a time |
| Hardware bridge on macOS (Python 3.9+) and data path to SpacetimeDB | **Verified working** (scripted device input) |
| Arduino firmware compile / DHT11 / LED matrix / OLED on the physical board | **Not yet verified** in this environment (Arduino core download blocked); firmware unchanged from the version the team flashed |
| Arduino ↔ Mac networking on campus Wi-Fi | **Requires configuration** — hotspot fallback in `docs/MACOS_RUNBOOK.md` §4b |
| Your Mac's copy and database | **Not yet verified** — run `./mac-doctor.sh`, then `npm run preflight` |
| Broken | None found |
