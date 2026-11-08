# Demo Guide

All incidents are synthetic and the infrastructure is simulated. Three repeatable scenarios:

| Incident | Story | What a good investigation shows |
|---|---|---|
| `INC-001` | Mass file access/renames by `svc-batch`, file-storage down | Observed facts vs an **unconfirmed** ransomware hypothesis; benign-batch hypothesis weakened by "no change window"; injection text in a file sample ignored; containment (isolate) preferred over a blind restart |
| `INC-002` | 12 failed logins then an unusual successful login | **No** claim of compromise; MFA from enrolled device + no privilege changes; recommend human review (`maintain_current_state` + escalate), not isolating auth |
| `INC-003` | Database down, API 503 | Root cause = `primary-database`; API/gateway/auth/admin/backup are cascades; traffic-flood hypothesis refuted; restore ≫ restart |

## A. Offline smoke (no key) — scripted stand-in for the model

```bash
cd agent && source .venv/bin/activate        # Windows: .\.venv\Scripts\Activate.ps1
python examples/run_investigation.py INC-003 --scripted
```
The banner says the "model" is a fixed script. Everything else (tool validation/execution, evidence ledger, simulator, state machine,
approval proposal) is real. Do **not** present this as Nemotron.

## B. Live run (real NVIDIA Nemotron tool calling)

```bash
export NVIDIA_API_KEY=nvapi-...              # PowerShell: $env:NVIDIA_API_KEY="nvapi-..."
python examples/run_investigation.py INC-003 --out result.json
```
Success criteria: status `awaiting_approval`, ≥3 distinct tool names in `tool_calls` with `status:"ok"`, `root_cause_candidates == ["primary-database"]`,
every finding's `evidence_ids` present in `evidence[]`. If the model fails (rate limit, no tool calls, invalid report) the run ends `failed` with an
error code — that is the intended behaviour, not a bug to hide. Try `INC-001` and `INC-002` afterwards, or another `NVIDIA_MODEL_ID`.

Automated check: `RUN_LIVE_NVIDIA_TESTS=1 pytest -m live_nvidia -s`.

## C. Over HTTP, with the approval step (local demo mode)

Terminal 1:
```bash
export NVIDIA_API_KEY=nvapi-...; export AGENT_DEMO_MODE=true
python -m sentinel_agent
```
Terminal 2:
```bash
curl -s http://127.0.0.1:8100/health
INV=$(curl -s -X POST http://127.0.0.1:8100/api/investigations -H 'Content-Type: application/json' -d '{"incident_id":"INC-001"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["investigation_id"])')
curl -s "http://127.0.0.1:8100/api/investigations/$INV/events?after=0"        # repeat with after=<next_after> to watch steps arrive
curl -s "http://127.0.0.1:8100/api/investigations/$INV/report"                # 409 until ready
PID=$(curl -s "http://127.0.0.1:8100/api/investigations/$INV" | python3 -c 'import sys,json;print(json.load(sys.stdin)["proposal"]["proposal_id"])')
curl -s -X POST "http://127.0.0.1:8100/api/proposals/$PID/decision" -H 'Content-Type: application/json' \
     -H 'X-Demo-User: demo-ic' -H 'X-Demo-Role: incident_commander' -d '{"decision":"approve","reason":"demo"}'
```
Windows PowerShell: use `Invoke-RestMethod -Method Post -Uri … -ContentType application/json -Body '{"incident_id":"INC-001"}'` and pass headers with `-Headers @{ 'X-Demo-User'='demo-ic'; 'X-Demo-Role'='incident_commander' }`.

Talking points: the trace is generated from real events; try the same decision call with `X-Demo-Role: viewer` (403) or with no headers (401);
the response always says `execution: not_performed_by_agent`.

## D. Show the safety controls

```bash
pytest tests/test_security.py -q -k "hijack or untrusted or fabricated"
```
`test_hijack_attempts_after_injected_log_are_denied_audited_and_ignored` replays a "hijacked" model calling `execute_shell`, `approve_proposal`,
`isolate_asset` and a cross-incident read after reading the injected log; all are denied and audited while the real analysis completes.
(This uses the scripted double: it demonstrates the application's controls, not Nemotron's resistance.)
