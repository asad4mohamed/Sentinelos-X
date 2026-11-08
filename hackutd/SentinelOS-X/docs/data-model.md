# Data model (SpacetimeDB 2.14.1 TypeScript module)

Source of truth: `spacetime/src/index.ts`. Database table names are snake_case; TypeScript/client fields are camelCase (generated bindings map them). All timestamps are server-generated (`ctx.timestamp`). All tables except `simulation_schedule` are `public: true` (no secrets are stored). Phase 2 only **added** tables; no existing table or column changed, so upgrading is a non-destructive auto-migration.

| Table | Key | Purpose |
|---|---|---|
| `asset` | `asset_id: string` (PK) | Digital-twin component and its current state |
| `dependency` | `dependency_id: u64` auto-inc; btree on `dependent_asset_id`, `required_asset_id` | Directed edge "dependent requires required" |
| `incident` | `incident_id: u64` auto-inc | Incident record |
| `incident_asset` | `incident_asset_id: u64` auto-inc; btree `incident_id` | Asset impact attributed to an incident |
| `incident_event` | `event_id: u64` auto-inc; btree `incident_id` | Timeline (structured metadata) |
| `response_task` | `task_id: u64` auto-inc; btree `incident_id` | Response tasks |
| `incident_decision` | `decision_id: u64` auto-inc; btree `incident_id` | Decision log |
| `incident_message` | `message_id: u64` auto-inc; btree `incident_id` | Real-time incident channel |
| `recovery_action` | `recovery_id: u64` auto-inc; btree `incident_id` | Human-approved recovery requests |
| `audit_event` | `audit_id: u64` auto-inc | Committed privileged actions |
| `responder` | `identity: Identity` (PK) | Responder profile + role |
| `system_config` | `config_id: u32` (singleton 0) | Environment mode, dev role self-service |
| `service_principal` | `identity: Identity` (PK) | Non-human service identities (telemetry, ai_agent) and their authorization |
| `telemetry_sample` | `sample_id: u64` auto-inc; btree `asset_id` | Rolling window (30/asset) of **synthetic** telemetry |
| `ai_investigation` | `investigation_id: u64`; btree `incident_id` | Human-requested Nemotron investigations |
| `ai_step` | `step_id: u64`; btree `investigation_id` | Agent execution trace (each tool call / final answer) |
| `ai_finding` | `finding_id: u64`; btree `investigation_id`, `incident_id` | Findings and recommendations with human approval state |
| `incident_effect` *(Phase 2)* | `effect_id: u64` auto-inc; btree `incident_id`, `asset_id` | What an incident does to a root asset — the **input** to the blast-radius engine |
| `incident_evidence` *(Phase 2)* | `evidence_id: u64` auto-inc; btree `incident_id` | Synthetic evidence records (bounded at 24 per incident) |
| `telemetry_metric` *(Phase 2)* | `metric_id: u64` auto-inc; btree `asset_id` | Six-metric synthetic telemetry, 40 rows per asset |
| `simulation_state` *(Phase 2)* | `state_id: u32` (singleton 0) | Simulation-engine switch and tick counter |
| `simulation_schedule` *(Phase 2, private)* | `scheduled_id: u64` | Schedule row for `simulation_tick` (interval 3 s) |

## Key columns

**asset** — `name, asset_type, environment, criticality (low|medium|high|mission_critical), description, operational_status (online|degraded|offline), health_status (healthy|degraded|critical|offline|recovering), impact_type (none|direct|cascade|exposed), impact_caused_by?, direct_failure (none|offline|degraded), direct_incident_id?, telemetry_source ('synthetic'), last_seen_at, updated_at`

Every status column is a **derived output** written by `applyPropagation` from all live `incident_effect` rows. `direct_failure`/`direct_incident_id` are kept for Phase 1 clients and summarise the worst active/contained effect. `impact_type = exposed` with `health_status = healthy` means *potentially exposed* (shown as "at risk"), not down. `impact_caused_by` holds the upstream asset for cascades, or the exposure source for exposed assets.

Health precedence for one asset:
- A root with an active critical effect → `critical`.
- A root that is only degraded or recovering, but is taken down by another live effect through its dependencies → that worse state (`offline` / `degraded`).
- `recovering` appears only when recovering effects are the sole remaining cause.

**dependency** — `dependent_asset_id, required_asset_id, dependency_type (required|noncritical|optional), is_critical, rationale`

**incident** — `title, description, severity (low|medium|high|critical), status (open|investigating|contained|recovering|resolved), scenario_type, initial_asset_id, is_simulation, created_by: Identity, created_at, updated_at, resolved_at?, resolution_summary?`

**incident_asset** — `incident_id, asset_id, impact_type (direct|cascade), impact_status (offline|degraded|exposed|recovering|recovered), peak_status, depth (hops from root), caused_by_asset_id?, first_affected_at, updated_at`

This is the per-incident blast radius, computed from **that incident's** effects only. So when two incidents overlap, each keeps its own record.

**incident_event** — `incident_id, event_type, actor?: Identity (absent = engine), actor_name, description, asset_id?, timestamp, metadata: MetaEntry[] ({key, value})`

Event types:
- Phase 1: `incident_created, asset_failure_detected, asset_marked_offline, asset_marked_degraded, dependency_impact_calculated, severity_updated, status_changed, fault_injected, task_created, task_updated, decision_recorded, recovery_requested, recovery_approved, recovery_rejected, asset_restored, note_added, incident_resolved, environment_reset` (and the `ai_*` events).
- Phase 2: `asset_status_changed, asset_exposed, asset_recovering, containment_applied, evidence_collected, surge_escalated`.

**recovery_action** — `incident_id, asset_id, plan, status (pending|approved|rejected), requested_by, requested_at, decided_by?, decided_at?, decision_note?`

**audit_event** — `actor?, actor_name, action, target_type, target_id, timestamp, result`

**service_principal** — `name, kind (telemetry|ai_agent), status (pending|authorized|revoked), online, registered_at, decided_by?, last_seen_at`

**telemetry_sample** — `asset_id, latency_ms, error_rate (0..1), cpu_pct (0..100), throughput_rpm, timestamp`. Telemetry never changes asset health — the twin stays driven by the deterministic propagation engine.

**incident_effect** — `incident_id, asset_id, kind (outage|fault|overload|compromise|integrity), level (offline|degraded), phase (active|contained|recovering|cleared), intensity (0..1, overload only), ticks_in_phase, created_at, updated_at, cleared_at?`. Rows are never deleted; `cleared` is terminal.

How each kind resolves:

| Kind | Active | Contained | Containment action |
|---|---|---|---|
| outage | level; propagates; root critical | — | none (recover directly) |
| fault | level; propagates; critical if offline | — | none |
| overload | degraded; propagates; critical at intensity ≥ 1 | degraded, intensity decays | `enable_rate_limiting` |
| compromise | degraded locally, **no** operational propagation; **exposes** dependents; critical | exposure stops | `revoke_sessions` |
| integrity | degraded; propagates **and** exposes; critical | isolated → offline, exposure stops | `isolate_service` |

In every kind, `recovering` means degraded with propagation but no exposure, root health `recovering`. Exposure follows `required` and `noncritical` edges (BFS, cycle-safe) and never `optional` ones.

**incident_evidence** — `incident_id, asset_id, kind (auth_log|db_health|traffic|file_integrity|containment), title, detail, severity (info|low|medium|high|critical), indicators: MetaEntry[], observed_at, synthetic (always true)`. Indicator IPs are RFC 5737 documentation addresses.

**telemetry_metric** — `asset_id, tick, cpu_pct, memory_pct, request_rpm, error_rate (0..1), latency_ms, connections, source (simulation_engine|external), timestamp`. External rows from `ingest_telemetry` set `memory_pct` and `connections` to −1 (not reported).

**simulation_state** — `telemetry_enabled, tick_count, interval_ms (3000), last_tick_at?, started_at`.

**ai_investigation** — `incident_id, status (requested|running|completed|failed), requested_by, requested_at, agent?, model, started_at?, completed_at?, summary?, error?`

**ai_step** — `investigation_id, seq, kind (tool_call|model_message), tool?, input_summary, output_summary, ok, timestamp` (max 60 per investigation)

**ai_finding** — `investigation_id, incident_id, kind (finding|recommendation), summary, evidence, asset_id?, action? ('restore_asset'), confidence (low|medium|high), approval_status (not_required|pending|approved|rejected), decided_by?, decided_at?, recovery_id?, created_at`

## Reducers

| Reducer | Allowed roles | Notes |
|---|---|---|
| `init` (lifecycle) | system | `ensureEnvironment`: config, 16 services / 21 edges, simulation state, schedule |
| `onConnect` / `onDisconnect` (lifecycle) | system | Responder online flag. `onConnect` also runs the idempotent `ensureEnvironment`, which upgrades an existing database: adds missing services, starts the engine, and migrates Phase 1 asset faults into effects |
| `simulation_tick` (scheduled) | scheduler only (`ctx.senderAuth.isInternal`) | Recovery completion, surge escalation, periodic evidence, bounded telemetry |
| `set_simulation_engine(telemetryEnabled)` | IC | Pause/resume built-in telemetry (recovery keeps progressing) |
| `apply_containment(incidentId, assetId)` | IC, Analyst | active → contained for that incident's effects on the asset; open/investigating → contained |
| `register_responder(displayName)` | any identity | First registrant → IC, others → observer |
| `assign_role(target, role)` | IC | Cannot demote last IC |
| `dev_claim_role(role)` | registered, only if dev self-service on | **Development only** |
| `set_dev_role_self_service(enabled)` | IC | |
| `seed_demo_infrastructure()` | IC | Idempotent: inserts missing seed rows |
| `launch_simulated_incident(scenarioType, title)` | IC, Analyst | `auth_compromise`, `database_outage`, `traffic_surge`, `file_ransomware` (+ legacy `simulated_ransomware`); rejects a duplicate active scenario of the same type |
| `update_asset_status(assetId, failure, incidentId, reason)` | IC, Analyst | Fault injection: adds a `fault` effect to a simulated incident; overlapping incidents allowed |
| `update_incident_status(incidentId, status)` | IC, Analyst | Transition rules enforced |
| `record_incident_event(incidentId, description, metadata)` | IC, Analyst, Legal | Max 16 metadata entries |
| `create_response_task(incidentId, title, assignee?)` | IC, Analyst | Observers not assignable |
| `update_response_task(taskId, status)` | IC, Analyst, or assignee | |
| `record_incident_decision(incidentId, summary, rationale)` | IC, Legal | |
| `send_incident_message(incidentId, body)` | IC, Analyst, Legal | 10 msgs / 10 s per sender per incident |
| `request_recovery(incidentId, assetId, plan)` | IC, Analyst | Root-cause assets of that incident only; rejected with "Contain … first" while a containable effect is still active |
| `decide_recovery(recoveryId, approve, note)` | IC, not requester | Two-person rule. Approval moves that incident's effects on the asset to `recovering`; the engine clears them after 2 ticks |
| `resolve_incident(incidentId, summary)` | IC | Requires every effect of the incident to be cleared or recovering, and no pending recoveries |
| `reset_demo_environment()` | IC, development mode | Clears effects and closes simulations with a timeline entry; never deletes incident records; cancels in-flight AI investigations |
| `announce_service(name, kind)` | any non-responder identity | Creates a **pending** service principal |
| `authorize_service(target, authorize)` | IC | Authorize or revoke a service |
| `ingest_telemetry(samples[])` | authorized `telemetry` service | 1–64 samples, range-checked, one per asset; prunes to 30/asset. Rejected while the built-in engine is enabled (disable it in Settings to use the external generator) |
| `request_ai_investigation(incidentId)` | IC, Analyst | One active investigation per incident |
| `cancel_ai_investigation(investigationId)` | IC, Analyst | |
| `agent_claim_investigation(investigationId, model)` | authorized `ai_agent` | requested → running |
| `agent_record_step(...)` | the claiming agent | Running investigations only |
| `agent_record_finding(...)` | the claiming agent | Recommendations only for root-cause assets of that incident; no duplicates |
| `agent_complete_investigation(investigationId, summary, failed)` | the claiming agent | Adds a timeline event |
| `decide_ai_recommendation(findingId, approve)` | IC, Analyst | Approval files a normal recovery request under the human's identity (still needs a second IC) |
