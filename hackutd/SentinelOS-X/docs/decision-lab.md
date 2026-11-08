# Response Decision Lab

Compare possible responses to an incident **before** anyone acts. Route: `/lab` and `/lab/:incidentId`; also linked from the incident page and Incident Command.

## What it answers

For the selected incident and root service, four strategies are evaluated side by side:

| Strategy | Backend support | How it is modeled |
|---|---|---|
| Isolate the affected service | **Executable** for `compromise`, `overload`, `integrity` (→ `apply_containment`). **Hypothetical** for `outage`/`fault` (no isolation operation exists) | Containment phase, or root forced offline |
| Restore (approved recovery) | **Executable** → `request_recovery` + `decide_recovery` (two-person) | Root effect → `recovering` → cleared |
| Fail over to a standby | **Always hypothetical** — no failover operation and no standby in the twin | Root cleared for outage/fault/overload; compromise/integrity exposure unchanged |
| Staged containment, then recovery | **Executable** | Contain (if an action exists) → recovering → cleared, each stage shown |

Each card shows proposed steps, services restored / made worse / still affected, modeled severity before → after, preconditions (met / not met), approval requirements, residual risks, unsupported operations, warnings, and model assumptions. A before/after graph highlights the root (white ring) and every service the response changes (dashed ring).

**No invented numbers.** The only quantities shown are counts and the engine's own severity rule. There are no probabilities, recovery times, costs or confidence percentages — a unit test asserts this.

## Architecture

```
spacetime/src/decisionLab.ts   pure engine (no clock, no randomness, no I/O; never mutates input)
        │  re-uses computeBlastRadius / severityFromBlast from propagation.ts
        ├── browser preview     frontend/src/lib/decisionLab.ts builds input from SUBSCRIBED rows
        ├── module reducers     propose_response / decide_response_proposal re-run it server-side
        └── Nemotron agent      services/src/agent/explain.ts sends its STRUCTURED output to the model
```

- **Preview is separate from execution.** The page changes nothing. "Propose This Response" calls `propose_response`; the server rebuilds the input from authoritative tables, recomputes the engine, and stores the server-computed summary.
- **Stale proposals are rejected.** Every preview carries a state fingerprint (incident status + this incident's live effects + graph). If it no longer matches the server, the proposal (and later adoption) is refused with *"Stale proposal…"*. Overload intensity ticks are excluded so a live surge does not make every preview stale.
- **Two-person review.** The proposer cannot adopt or reject their own plan (`decide_response_proposal`). Adoption records an `incident_decision` and a timeline event — and **executes nothing**. The adopted plan's steps run through the existing containment and two-person recovery controls (shown inline).
- **Shared state only in SpacetimeDB.** New tables `response_proposal` and `decision_explanation` (public, additive migration). No local source of truth.

## Explain with Nemotron

`request_decision_explanation` creates a request. The authorized `ai_agent` service claims it, runs the **same engine** on its subscription cache, and sends the model the structured results plus this incident's evidence (titles/details sanitized as untrusted data). The model has **no tools**. The agent rejects and asks for one repair if the text cites evidence ids that were not supplied or states a quantity the engine did not compute (percentages, probabilities, costs, durations, confidence); a second failure marks the request *failed*. The module then verifies every cited evidence id belongs to the incident (`agent_complete_explanation`). The UI labels the text "AI-generated explanation · not an authoritative result".

When no authorized agent is online, the panel says so plainly; the deterministic comparison is unaffected and the request can be cancelled.

## Tests

- `spacetime/src/decisionLab.test.ts` (17) — every strategy on outage / compromise / integrity, already-contained, cyclic graph, disconnected service, missing service, non-root target, invalid strategy, resolved incident, unknown-asset effects, determinism, non-mutation, fingerprint behaviour, multi-root and multi-incident warnings, no-invented-quantities.
- `spacetime/src/decisionLab.reducers.test.ts` (9, real WASM datastore) — server-side proposal, hypothetical label, stale/invalid/unauthorized/duplicate rejection, two-person adoption, adoption executes nothing, staleness after real recovery, withdraw rules, reset, explanation citation validation, cancellation, overload ticks.
- `frontend/src/tests/decisionLab.test.tsx` (6) — page renders from reducer-produced rows, degraded agent state, empty state, unknown incident, citation parsing.
- `services/src/agent/explain.test.ts` (5) — mocked model: prompt contents, accepted output, repair on hallucinated citation/percentage, truthful failure.
