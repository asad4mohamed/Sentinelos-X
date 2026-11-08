# Security Model

Scope: a hackathon-grade, software-only service investigating **synthetic** data on **simulated** infrastructure.
Read the limitations section before relying on any control.

## Trust boundaries

| Zone | Trusted? | Notes |
|---|---|---|
| System prompt + user request (`llm/prompts.py`) | Yes | The only channel that carries instructions. The user message contains just a validated incident id and the budget |
| Tool results (logs, incident text, evidence, error text) | **No — data** | Wrapped in `{"trust":"untrusted_data","notice":...,"injection_flags":[...],"data":{...}}`; control characters stripped, lengths capped |
| Model output | **No** | Tool calls are authorized, validated and executed by our code; claims are validated before acceptance |
| Main backend (identity assertions) | Yes, via shared secret | Only for approvals, via `X-Sentinel-Service-Token` |
| Browser / frontend | No | Never receives the NVIDIA key or the service token |

## Enforcement in code (not prompt wording)

1. **Allowlist**: `ToolPolicy.authorize` denies any tool name not in the registry (`execute_shell`, `approve_proposal`, `read_file`, `http_request`, … do not exist). Denials are recorded in the tool trace (`status:"denied"`), emitted as events and written to the audit log.
2. **Read-only registry**: `ToolRegistry` refuses to register a tool with `read_only=False`; policy re-checks. There is no shell, filesystem, network or credential tool.
3. **Strict argument validation**: pydantic models with `extra="forbid"`, id regexes (`^[a-z0-9][a-z0-9-]{1,63}$` for assets, `^INC-…$` for incidents, `^(EVT|DEP|AST)-…$` for evidence), ISO-8601 timestamps with timezone only, bounded integers and list sizes. Malformed JSON, wrong types and unknown fields become structured errors.
4. **Incident binding**: an investigation may only read its own incident (`CROSS_INCIDENT_ACCESS` otherwise).
5. **Bounded execution**: per-tool timeout, max tool calls (denied attempts count, so a hijacked model cannot loop on refusals), max model turns, max investigation duration, bounded result sizes (`AGENT_MAX_LOG_RESULTS`, 30 KB payload cap).
6. **Evidence integrity**: a cited id must exist in the provider **and** have been returned to this investigation by a tool. Fabricated or never-retrieved ids cause the report to be rejected (and audited); after `max_submission_repairs` failed attempts the investigation is `failed`.
7. **Claim discipline**: only `observed` findings may be `confirmed_by_available_evidence`; observed/inference findings need evidence; observed claims containing loaded terms (`ransomware`, `malware`, `compromise`, `exfiltrat`, `breach`, `attacker`) must find that term in the cited evidence text.
8. **Computed facts**: affected assets and root-cause candidates come from the dependency engine; conflicting model claims are kept in `rejected_model_claims`, not adopted.
9. **Recommendation must be simulated**: the recommended strategy/target must have been run through the simulator in this investigation and be executable.
10. **Human approval**: every operational recommendation creates a `pending` proposal. The agent has no code path that executes an operational action (`execution:"not_performed_by_agent"`). Decisions need a `TrustedIdentity` from `resolve_identity` with a role in `{incident_commander, security_admin}`; identity is read only from headers validated by the shared service token (constant-time compare), never from the body.
11. **Secrets**: API key and service token are excluded from `repr`; logs/audit/errors pass through `redact()` (NVIDIA keys, bearer tokens, `api_key=…`); upstream error bodies are truncated and redacted; `/health` exposes only a boolean.
12. **Reasoning**: `reasoning_content` and `<think>…</think>` blocks from the model are discarded, never stored or returned.

Prompt-injection pattern matching (`untrusted_content.py`) only **labels** content (flags in the envelope, `content_flags`, audit
events). It never grants or withholds a capability, so missing a pattern cannot create a privilege.

## Allowed tools

Investigation (all read-only): `get_incident_details`, `get_asset_status`, `get_recent_logs`, `get_infrastructure_dependencies`,
`get_incident_timeline`, `search_security_events`, `get_related_incidents`, `calculate_blast_radius`,
`simulate_recovery_strategy`, `get_evidence_record`.
Control (no infrastructure effect): `update_hypothesis`, `submit_investigation_report`.

## Approval rules

* `restart/isolate/restore/switch` ⇒ proposal, `approval_required:true`, status `pending`.
* `maintain_current_state` ⇒ no proposal (nothing to approve); may set `escalate_to_human_analyst`.
* A decision is final (409 on repeat). Rejected decisions also conclude the investigation (`completed`, proposal `rejected`).
* **Demo mode** (`AGENT_DEMO_MODE=true`) trusts client-supplied headers and exists only so the flow can be demonstrated locally. Responses label it `demo_local_NOT_PRODUCTION`. Never enable it on a reachable network.

## Adversarial coverage (tests/test_security.py, test_investigator.py, test_api.py)

Injected instructions in logs (fixtures EVT-007, EVT-107, EVT-203) reach the model only inside untrusted envelopes and never in the
system prompt; a simulated hijacked model's calls to `execute_shell`, `approve_proposal`, `isolate_asset` and a cross-incident read are all
denied and audited while the real analysis completes; fabricated and never-retrieved evidence ids; invalid asset ids; unexpected/malformed
arguments; over-claiming `ransomware` as observed; unsimulated recommendations; tool-call and turn limits; body-smuggled roles; demo headers
ignored when demo mode is off; wrong service tokens; CORS not widened.

## Known limitations / not verified

* These tests use a **scripted** model. Real Nemotron behaviour under injection is **untested**; the code-level controls do not depend on it, but report quality/over-claiming by a real model is unmeasured.
* Injection detection is regex-based and bypassable; it is a label, not a defence. The loaded-term check is a heuristic, not semantic verification; a model can still make misleading claims that avoid those terms.
* Proposals, audit log and investigations are **in memory**: lost on restart, not shared across processes, no tamper-evidence.
* If `AGENT_SERVICE_TOKEN` is unset, `/api/*` is unauthenticated (local dev). Bind to localhost or put it behind the backend.
* No per-client rate limiting beyond the global queue cap. A single shared service token has no per-caller revocation.
* The service token is a static bearer secret; rotate via environment and use TLS between services.
* Self-approval / separation of duties between requester and approver is not enforced.
* `FixtureProvider` data is synthetic; a future `LiveProvider` must treat all backend content as untrusted too.
* OpenShell sandboxing is not integrated (optional future work); the core agent has no code-execution capability to sandbox.
