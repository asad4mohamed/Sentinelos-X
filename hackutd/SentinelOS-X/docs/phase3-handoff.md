# Phase 3 handoff: AI investigation integration

Phase 2 did **not** modify the teammate's agent (`services/src/agent/**`). The only change under `services/` is the regenerated bindings in `services/src/module_bindings`, which are generated code. The agent typechecks and its 14 tests pass against the Phase 2 module.

## Tables to read (subscribe; all public, read-only for the agent)

| Table | Why the agent needs it | Key |
|---|---|---|
| `incident` | Title, scenario, status, severity | `incident_id: u64` (shown as `INC-<id>`) |
| `incident_effect` | **Ground truth of what each incident did**: root asset, kind, phase | `effect_id: u64`; btree `incident_id`, `asset_id` |
| `incident_asset` | The per-incident blast radius already computed by the server: impact status, depth, `caused_by_asset_id` | `incident_asset_id: u64`; btree `incident_id` |
| `incident_evidence` | Synthetic evidence to reason over | `evidence_id: u64`; btree `incident_id` |
| `incident_event` | Timeline (cause → effect order) with structured `metadata` | `event_id: u64`; btree `incident_id` |
| `asset`, `dependency` | Global twin state and topology | `asset_id: string` (`^[a-z0-9][a-z0-9-]{1,47}$`), `dependency_id: u64` |
| `telemetry_metric` | Six synthetic metrics per tick (`source` = `simulation_engine` / `external`) | `metric_id: u64`; btree `asset_id` |
| `telemetry_sample` | Phase 1 telemetry shape. The engine keeps filling it, so existing agent tools still work | `sample_id: u64` |
| `recovery_action` | Pending / approved / rejected recoveries | `recovery_id: u64` |
| `simulation_state` | Engine tick count / whether telemetry is live | singleton `state_id = 0` |

Today the agent subscribes to `asset, dependency, incident, incident_asset, incident_event, recovery_action, telemetry_sample, ai_investigation, ai_finding`. All of these still exist and keep their Phase 1 shape. Adding `incident_effect`, `incident_evidence` and `telemetry_metric` to its subscription list is the main integration step.

## Evidence format

```ts
incident_evidence {
  evidenceId: u64; incidentId: u64; assetId: string;
  kind: 'auth_log' | 'db_health' | 'traffic' | 'file_integrity' | 'containment';
  title: string; detail: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  indicators: { key: string; value: string }[];   // e.g. src_ip=203.0.113.24, failed_logins=412
  observedAt: Timestamp; synthetic: true;
}
```

Indicator IPs are RFC 5737 documentation addresses. All evidence is synthetic and must be presented that way.

## Status model

- **Incident**: `open` (UI: *Detected*) → `investigating` → `contained` → `recovering` → `resolved`.
  - Server-enforced transitions are in `spacetime/src/validation.ts`.
  - Containment and recovery approval move the status forward automatically.
- **Effect phase**: `active` → `contained` → `recovering` → `cleared` (terminal; rows are kept).
- **Asset health**: `healthy | degraded | critical | offline | recovering`, plus `impact_type = exposed` (potentially exposed).
  - Derived from all live effects (see `docs/data-model.md` for precedence).
- **Per-incident impact** (`incident_asset.impact_status`): `offline | degraded | exposed | recovering | recovered`.

## Read-only analysis

- `spacetime/src/propagation.ts` exports pure functions the agent can import for what-if analysis on its local cache, exactly as `tools.ts` already imports `computeImpacts`:
  - `computeBlastRadius(assetIds, edges, effects)`
  - `resolveEffect(effect)`
  - `severityFromBlast(blast, criticalityOf)`
  - `CONTAINMENT`
- These match the server bit-for-bit. Feed them `incident_effect` rows (`{assetId, kind, level, phase, intensity}`), optionally with one effect's phase changed, to answer "what if we contain / recover X?".
- Suggested new **read-only** tools (not implemented, agent owner's call):
  - `get_effects(incident_id)`
  - `get_evidence(incident_id)`
  - `get_blast_radius(incident_id)` (group `incident_asset` rows)
  - `simulate_containment(incident_id, asset_id)`
- The existing `simulate_recovery` uses the Phase 1 `computeImpacts` over `asset.direct_failure`. That still works, but it does not model exposure or containment. Switching it to `computeBlastRadius` over `incident_effect` would make it exact.

## Write boundary (unchanged; server-enforced)

The agent identity (`service_principal.kind = ai_agent`, authorized by an IC) may only call:

| Reducer | Constraint |
|---|---|
| `agent_claim_investigation` | `requested` → `running` |
| `agent_record_step` | Investigation it claimed, while running; max 60 steps |
| `agent_record_finding` | Findings are free-form. A **recommendation** must target an asset with an `active`/`contained` effect **of that incident**, one per asset per investigation, action `restore_asset` |
| `agent_complete_investigation` | Ends the run |

The agent **cannot** apply containment, request or approve recovery, change incident status, inject faults or touch telemetry. Those reducers require a human responder role, and service identities are not responders.

## Recovery approval boundary

```
agent recommendation (restore_asset, approval_status=pending)
  └─ human IC/Analyst accepts (decide_ai_recommendation) ─► recovery_action(pending, requested_by = that human)
       └─ server: refused with "Contain … first" while a containable effect is still active
       └─ a DIFFERENT Incident Commander approves (decide_recovery) ─► effects → recovering
            └─ simulation_tick ×2 ─► cleared ─► asset_restored events
```

If Phase 3 wants the agent to recommend containment, add an `action: 'apply_containment'` recommendation type in `agent_record_finding`. Validate it with `CONTAINMENT[kind]`. Acceptance should call `apply_containment` under the **human's** identity, never the agent's.

## Integration points checklist

1. Add `tables.incidentEffect`, `tables.incidentEvidence` and `tables.telemetryMetric` to the agent's `subscribe` list (`services/src/agent/main.ts`).
2. Expose the read-only tools above in `tools.ts` and use `computeBlastRadius` for what-if analysis.
3. Optionally reference evidence by `evidence_id` in `ai_finding.evidence`. It is a free-text field today; no schema change is needed.
4. Run `npm run check` (agent tests included) and `npm run publish:local` (non-destructive).
