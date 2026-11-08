# API Contract

Base URL (default): `http://127.0.0.1:8100`. JSON everywhere. All timestamps are ISO 8601 UTC with `Z`. All IDs are strings.
If `AGENT_SERVICE_TOKEN` is set, every `/api/*` request except `POST /api/proposals/{id}/decision` needs header
`X-Sentinel-Service-Token: <token>` (401 `SERVICE_AUTH_REQUIRED` otherwise). `/health` is always open.

## Errors

Every error uses one shape:
```json
{"error": {"code": "INCIDENT_NOT_FOUND", "message": "...", "details": null}}
```

| HTTP | code | when |
|---|---|---|
| 401 | `SERVICE_AUTH_REQUIRED` | missing/wrong service token |
| 401 | `AUTHENTICATION_REQUIRED`, `IDENTITY_MISSING`, `INVALID_SERVICE_TOKEN` | approval without trusted identity |
| 403 | `ROLE_NOT_AUTHORIZED` | role not in `incident_commander`, `security_admin` |
| 404 | `INCIDENT_NOT_FOUND` | unknown or historical (non-investigable) incident |
| 404 | `INVESTIGATION_NOT_FOUND` | unknown id, or lost after a restart (in-memory) |
| 404 | `PROPOSAL_NOT_FOUND` | unknown proposal |
| 409 | `REPORT_NOT_READY` | report requested while still running (`Retry-After`) |
| 409 | `ALREADY_DECIDED` | proposal already approved/rejected |
| 422 | `VALIDATION_ERROR` | bad body/params (`details` = `[{loc,msg}]`); unknown body fields are rejected |
| 429 | `QUEUE_FULL` | too many queued investigations (`Retry-After`) |
| 503 | `LLM_NOT_CONFIGURED` | no `NVIDIA_API_KEY` on the server |

## GET /health
```json
{"status":"ok","service":"sentinel-agent","version":"0.1.0","data_provider":"fixture","data_source":"synthetic_fixture",
 "model_provider":"nvidia","model_id":"nvidia/nemotron-3-ultra-550b-a55b","nvidia_configured":true,"demo_mode":false}
```
Never includes secrets.

## GET /api/agent/capabilities
Returns `investigation_tools` (name, description, `read_only`, JSON-schema `parameters`), `control_functions`
(`update_hypothesis`, `submit_investigation_report`), `recovery_strategies`, `states`, `limits`, `security`, `limitations`.

## POST /api/investigations → 202
Request: `{"incident_id": "INC-003"}` (pattern `^INC-[A-Za-z0-9-]{1,32}$`; extra fields rejected).
```json
{"investigation_id":"INV-3F2A9C1B","incident_id":"INC-003","status":"queued",
 "links":{"self":"/api/investigations/INV-3F2A9C1B","events":"/api/investigations/INV-3F2A9C1B/events","report":"/api/investigations/INV-3F2A9C1B/report"}}
```
The investigation runs asynchronously in-process. **Not durable**: lost on restart.

## GET /api/investigations/{id}  and  GET /api/investigations/{id}/report
Both return `InvestigationResult`. The first is a live snapshot at any time; the report returns **409 while queued/running**
and 200 once the investigation is `awaiting_approval`, `completed` or `failed`.

### InvestigationResult
| field | type | notes |
|---|---|---|
| `investigation_id`, `incident_id` | string | |
| `status` | `queued`\|`collecting_evidence`\|`analyzing`\|`simulating_recovery`\|`awaiting_approval`\|`completed`\|`failed` | `failed` is never reported as completed |
| `analysis_complete` | bool | true once a validated report exists (including while `awaiting_approval`) |
| `data_source` | string | `synthetic_fixture` |
| `model_provider`, `model_id` | string | what actually ran |
| `summary` | string\|null | |
| `findings[]` | `{finding_id, claim, classification: observed\|inference\|hypothesis\|recommendation, certainty: confirmed_by_available_evidence\|strongly_supported\|possible\|insufficient_evidence, evidence_ids[]}` | every id validated; certainty is qualitative, not a probability |
| `hypotheses[]` | `{hypothesis_id, statement, origin: triage\|model, status: open\|supported\|refuted\|unresolved, certainty, supporting_evidence_ids, contradicting_evidence_ids, missing_evidence, revision}` | |
| `affected_assets[]`, `unaffected_assets[]`, `root_cause_candidates[]` | asset ids | **computed from observed state + dependency graph, not by the model** |
| `tool_calls[]` | `{seq, model_tool_call_id, tool_name, arguments, status: ok\|error\|denied, error_code, started_at, duration_ms, evidence_ids, result_summary, counted_toward_budget}` | written by the executor at execution time |
| `evidence[]` | `{evidence: EvidenceRecord, retrieved_by_tool_calls[]}` | only records actually retrieved |
| `recovery_options[]` | `RecoveryOption` (below) | deterministic simulator output, chart-ready |
| `simulator_ranking[]` | `{rank, strategy, target_asset_id, executable, status_counts, critical_services_affected, basis}` | service-impact ordering only |
| `recommended_action` | `{action_type, target_asset_id, requires_approval, rationale, evidence_ids, escalate_to_human_analyst, proposal_id}` | |
| `proposal` | `ApprovalProposal` or null | present iff `requires_approval` |
| `limitations[]`, `rejected_model_claims[]` | string | uncertainty/missing evidence; claims the code refused to adopt |
| `trace[]` | string | `"[mm:ss] message"` derived from real events |
| `error` | `{code, message}`\|null | e.g. `LLM_RATE_LIMITED`, `INVESTIGATION_TIMEOUT`, `SUBMISSION_INVALID`, `MAX_MODEL_TURNS` |
| `created_at`, `started_at`, `completed_at` | UTC ISO | |

### EvidenceRecord
`{evidence_id, kind: log_event|dependency|asset_state, source, timestamp, asset_id, event_type, summary, severity, reliability: high|medium|low|unknown, reliability_basis, provenance:{origin, provider, record_ref}, content_flags[]}`.
IDs: `EVT-*` (log events), `DEP-*` (dependency edges; `A->B` = A depends on B), `AST-<incident>-<asset>` (asset state snapshots).
`content_flags` may contain `possible_prompt_injection`.

### RecoveryOption
`{strategy, target_asset_id, executable, precondition_notes, assets_operational, assets_degraded, assets_unavailable, status_counts{operational,degraded,unavailable}, restored_services, regressed_services, critical_services_affected, isolated_assets, open_lateral_paths, severed_lateral_paths, asset_outcomes[{asset_id, display_name, criticality, before, after, changed}], propagation[{asset_id,status,caused_by[]}], assumptions, tradeoffs, assumption_label, chart{assets,labels,before,after,counts_before,counts_after,status_levels}, warnings}`.
Strategies: `restart_virtual_service`, `isolate_virtual_asset`, `restore_virtual_dependency`, `switch_to_simulated_backup`, `maintain_current_state`.
No durations or costs are produced; assumptions are scenario assumptions.

## GET /api/investigations/{id}/events?after=0&limit=200
```json
{"investigation_id":"...","status":"analyzing","events":[{"seq":1,"timestamp":"...","type":"investigation_queued","message":"...","data":{}}],"next_after":1}
```
Poll with `after=<next_after>`. Event types: `investigation_queued`, `investigation_started`, `state_changed`
(`data.from_state/to_state`), `model_turn`, `tool_call_started`, `tool_call_completed`, `tool_call_failed`,
`tool_call_denied`, `injection_flagged`, `hypothesis_updated`, `submission_rejected`, `budget_exhausted`,
`report_ready`, `awaiting_approval`, `approval_decided`, `investigation_failed`. Events never contain model reasoning.

## POST /api/proposals/{proposal_id}/decision
Headers establish identity (never the body):
* Production: `X-Sentinel-Service-Token` + `X-Authenticated-User-Id` + `X-Authenticated-User-Role`, sent **only by the main backend** after it authenticated the human.
* Local demo (`AGENT_DEMO_MODE=true`): `X-Demo-User` + `X-Demo-Role`; response labels `authorization_mode: "demo_local_NOT_PRODUCTION"`.

Body: `{"decision":"approve"|"reject","reason":"optional ≤500 chars"}` (extra fields such as `role` → 422).
Response: `{"proposal_id","status","decided_by","decided_role","authorization_mode","execution":"not_performed_by_agent","investigation_status":"completed"}`.
**The agent never executes the action.** It records the decision; the main application performs (or declines) the change.

## State machine
`queued → collecting_evidence → analyzing → simulating_recovery → awaiting_approval → completed`, `failed` from any
non-terminal state. Moves are forward-only; stages may be skipped. `awaiting_approval → completed` happens on a recorded human decision.
Recommendations of `maintain_current_state` need no approval and go straight to `completed`.
