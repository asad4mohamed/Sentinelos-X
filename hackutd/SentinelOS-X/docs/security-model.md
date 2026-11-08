# Security model (Phase 2)

This document separates what is **implemented and tested** from what is **planned**. Do not present planned items as working.

## Role–permission matrix

| Action | Incident Commander | Security Analyst | Legal Responder | Observer |
|---|:-:|:-:|:-:|:-:|
| View all data | ✓ | ✓ | ✓ | ✓ |
| Launch simulated incident | ✓ | ✓ | | |
| Inject simulated fault | ✓ | ✓ | | |
| Apply simulated containment | ✓ | ✓ | | |
| Change incident status | ✓ | ✓ | | |
| Add timeline note | ✓ | ✓ | ✓ | |
| Create task | ✓ | ✓ | | |
| Update task | ✓ | ✓ | assignee only | |
| Record decision | ✓ | | ✓ | |
| Send incident message | ✓ | ✓ | ✓ | |
| Request recovery | ✓ | ✓ | | |
| Approve / reject recovery | ✓ (not own request) | | | |
| Resolve incident | ✓ | | | |
| Request / cancel AI investigation | ✓ | ✓ | | |
| Accept / reject AI recommendation | ✓ | ✓ | | |
| Authorize / revoke services | ✓ | | | |
| Assign roles, reset demo, toggle self-service | ✓ | | | |
| Pause / resume the simulation engine's telemetry | ✓ | | | |

Enforced in `spacetime/src/index.ts` (`PERMS`, `requireRole`) and covered by tests in `spacetime/src/index.test.ts` and `scenarios.test.ts`. The frontend mirrors the matrix only to hide/disable controls — hidden buttons are never the control.

## Implemented protections

- **Server-side authorization** on every mutating reducer against `ctx.sender` (the caller's SpacetimeDB identity, which the client cannot forge without its token).
- **Input validation**: length bounds, single-line fields, control-character rejection, asset-ID pattern, enum checks for severity/status/role/failure, max 16 structured metadata entries with key pattern, task and incident transition rules.
- **Two-person rule** for recovery approval. Recovery is the only path to restore an asset. For `compromise`, `overload` and `integrity` effects, the server also refuses recovery until containment has been applied.
- **Scheduled reducer guard**: `simulation_tick` throws unless `ctx.senderAuth.isInternal` is true, so clients cannot drive the engine (tested).
- **Bounded growth**: evidence is capped at 24 per incident and telemetry at 40 (`telemetry_metric`) / 30 (`telemetry_sample`) per asset. Effects are a few rows per incident, and the per-tick work is linear in assets plus effects (tested over 60 ticks).
- **Single telemetry writer**: `ingest_telemetry` is rejected while the built-in engine is running. External and built-in telemetry therefore never interleave silently.
- **Resolution gate**: an incident cannot be resolved while any of its effects is still active or contained, or while recoveries are pending.
- **Duplicate-simulation prevention** server-side (plus UI disable while pending).
- **Message flood control**: 10 messages / 10 s per sender per incident.
- **Audit log** of committed privileged actions with actor identity, action, target, timestamp, result.
- **Transactional integrity**: each reducer is atomic; rejected calls leave no partial state.
- **Reset safety**: demo reset never deletes records; refuses if a non-simulated incident is active; development mode only.
- **No secrets** in the client, repository, or public tables. `.env*` files are git-ignored except `.env.example`.
- **Simulation safety**: no code path executes commands, touches files, opens connections or changes firewall/OS settings. Scenarios, containment and recovery only change rows. Evidence is labeled `synthetic` and uses RFC 5737 documentation IP addresses.
- **Service principals**: telemetry and AI services are separate identities that cannot act until an IC authorizes them; responders and services cannot impersonate each other's kinds; revocation takes effect on the next call.
- **Telemetry cannot change health**: ingest only writes samples (range-validated, bounded batch, rolling window); the twin's state comes only from the deterministic engine.
- **AI containment**:
  - The agent's tools are read-only over its subscription cache; what-if analysis runs locally and changes nothing.
  - The agent may only write to `ai_step` / `ai_finding` of an investigation it claimed, and only while it is running.
  - Recommendations are restricted server-side to restoring a root-cause asset of that incident.
  - Accepting a recommendation files a normal recovery request under the accepting human's identity; a **different** IC must still approve it (two-person rule). There is no path for the agent to restore anything.
  - Without `NVIDIA_API_KEY` the agent never claims work; on API errors the investigation is marked failed. Output is never fabricated, and summaries are labeled AI-generated in the UI.
- **OpenShell sandbox (optional)**: `services/openshell/policy.yaml` limits egress to the NVIDIA endpoint (two API paths) and the host SpacetimeDB port, for `node` only; filesystem is read-only except the workdir; the provider injects the API key only for `integrate.api.nvidia.com`. Policy and provider profile pass OpenShell's own validators.

## Known risks and demonstration-only assumptions

| Risk | Status |
|---|---|
| Identities are anonymous SpacetimeDB tokens — no proof of *who* a person is | Accepted for Phase 1–2. Planned: OIDC (SpacetimeAuth or external IdP) and role binding to verified claims. |
| Dev role self-service lets any registered identity choose a role | On by default in development; an IC can disable it (`set_dev_role_self_service`). Must be off / removed outside demos. |
| First registrant becomes Incident Commander | Bootstrap convenience. Planned: IC provisioned out-of-band. |
| All tables are public; any client can read messages, decisions, audit | Accepted. Planned: private tables + per-incident membership views. |
| Messaging is not end-to-end encrypted | Transport is the SpacetimeDB WebSocket (use `wss://` when hosted). No E2E encryption is claimed. |
| Denied attempts are not in the audit log (transaction rollback) | Planned: separate logging channel (e.g. procedure or server logs shipping). |
| Command center and simulated infrastructure share a laptop | Logical separation only; see architecture trust boundaries. |
| Session token in `sessionStorage` is readable by scripts on the origin | Standard SPA risk; mitigated by no third-party scripts at runtime. |
| Service tokens stored in `services/.tokens/*.token` (mode 600, git-ignored) | Anyone with the file can act as that service; revoke in Settings if leaked. |
| Prompt injection via incident text (titles, notes) reaching the model | Mitigated by containment: the model can only record findings/recommendations, all of which need human approval. |
| `ai_*` tables are public | Findings are visible to every subscribed client. |

## Planned protections (not implemented)

- Verified identity (OIDC) and role binding; MFA for Incident Commanders.
- Per-incident membership and private tables / views.
- Signed, exportable audit trail.

## Final hardening pass (HackUTD submission)

**Credentials.** No secret is tracked by git in `SentinelOS-X` or `agent` (verified with `git ls-files` and a history search for `nvapi-` keys; `npm run preflight` repeats the check). Real values live only in git-ignored files: `services/.env`, `agent/.env`, `hardware/.env`, `hardware/SentinelArduino/arduino_secrets.h`, `services/.tokens/*.token`. `.env.example` / template files carry placeholders. **The NVIDIA key, the bridge device/admin tokens, the SpacetimeDB identity tokens and the Wi-Fi password were all present in the project archive shared for review, and the NVIDIA key was previously reported as exposed — rotate them.** Deleting a file does not invalidate a leaked credential.

**Agent safeguards (Node agent, `services/src/agent`).**
- Prompt injection: system prompt declares all incident text and tool output untrusted data; titles are sanitized (control characters, quotes, length) before reaching the prompt. The model has no write tools and cannot approve anything.
- Hallucinated evidence: `report_finding` is rejected unless its evidence names a tool the agent successfully called or an evidence id it retrieved; recommendations require prior retrieval. Explanations may only cite evidence ids that were supplied; the module re-verifies each id.
- Budgets: ≤ 6 tool calls per turn, ≤ 24 per investigation (configurable), wall-clock limit (300 s), turn limit; on exhaustion tools are withdrawn and the model must summarize. Identical read-only calls are served from cache, duplicate findings are dropped.
- Failures: retries with backoff for 429/5xx/network errors, timeouts, clear 401/404/429 messages, malformed-response detection. Error text is redacted (`nvapi-…`, `Bearer …`, the configured key) before it is logged or written to the public `ai_*` / `decision_explanation` tables.

**Decision Lab.** Preview is client-side and changes nothing. `propose_response` and `decide_response_proposal` recompute the engine on authoritative state and reject stale fingerprints; the proposer cannot decide their own plan; adoption executes nothing.

**Hardware bridge.** Device and admin tokens (≥ 16 chars, constant-time compare, fail closed), strict schemas, `Content-Length` checked before the body is read (≤ 1 KiB), reading flood guard (429), no CORS, docs disabled. The device can only report; detection and incident creation run in the module under the authorized `hardware_gateway` identity.

**Still development-grade (not production-secure).** Anonymous identities; role self-service on by default; first registrant becomes IC; one person with two tabs can satisfy the two-person rule; all tables public; plain HTTP on the LAN for the bridge; tokens in local files.
