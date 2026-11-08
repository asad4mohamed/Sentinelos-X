# SentinelOS X — Nemotron Investigation Agent

Standalone Python service that autonomously investigates **simulated** cybersecurity incidents. A NVIDIA Nemotron model
chooses which read-only tools to call; the application validates and executes every call, a deterministic simulator
computes recovery consequences, every claim must cite evidence the agent really retrieved, and any operational change
requires human approval. 100% software: no hardware, no real systems, no real malware.

> **Status (2026-11-07):** automated tests use *mocked* HTTP and a *scripted* model double. Separately, the live smoke
> tests (`pytest -m live_nvidia`) were run once against the real NVIDIA API with `nvidia/nemotron-3-ultra-550b-a55b`:
> both passed, and a full INC-003 investigation completed (14 model turns, ~85 s, 2 invalid reports rejected and repaired
> by the model). That is one run, one scenario, one account; INC-001/INC-002 and other models are untested live.

## Layout

```
src/sentinel_agent/
  config.py  main.py  models.py        settings, FastAPI factory, shared pydantic models
  api/            routes.py schemas.py  HTTP layer
  llm/            nvidia_client.py tool_loop.py prompts.py   real NVIDIA client + multi-step tool loop
  orchestration/  investigator.py investigation_state.py hypothesis_manager.py control_tools.py manager.py
  tools/          registry.py + incident/log/asset/dependency/simulation tools (10 read-only tools)
  simulation/     graph.py propagation.py recovery.py        deterministic engine (no LLM)
  security/       policy.py approvals.py audit.py untrusted_content.py
  integrations/   data_provider.py fixture_provider.py spacetime_adapter_contract.py
  reporting/      evidence.py report_builder.py
  fixtures/       assets, dependencies, incidents, logs (synthetic; contain NO ground truth)
tests/            148 passing tests; ground_truth.json lives here and is never loaded by the agent
examples/         run_investigation.py, example_output.json (scripted run, labelled as such)
docs/             API_CONTRACT, INTEGRATION_GUIDE, SECURITY_MODEL, DEMO_GUIDE
```

## Install

Python **3.11+** (developed on 3.13).

macOS / Linux:
```bash
cd agent
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env   # then edit; export the variables, e.g. `set -a; source .env; set +a`
```

Windows (PowerShell):
```powershell
cd agent
py -3.13 -m venv .venv; .\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
Copy-Item .env.example .env   # set variables in the session, e.g. $env:NVIDIA_API_KEY = "nvapi-..."
```

The service reads **environment variables** (it does not auto-load `.env`; export them or use your shell/IDE).

## Configure

| Variable | Default | Purpose |
|---|---|---|
| `NVIDIA_API_KEY` | – | Required for investigations. Server-side only. Get one at build.nvidia.com |
| `NVIDIA_MODEL_ID` | `nvidia/nemotron-3-ultra-550b-a55b` | Any chat model from `GET https://integrate.api.nvidia.com/v1/models` that supports tool calling |
| `NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com/v1` | Must be https (http only for localhost) |
| `NVIDIA_EXTRA_BODY` | – | JSON merged into the request body for per-model tuning (cannot override model/messages/tools) |
| `NVIDIA_TEMPERATURE`, `NVIDIA_MAX_TOKENS` | 0.2, 2048 | Sampling |
| `NVIDIA_REQUEST_TIMEOUT_S`, `NVIDIA_MAX_RETRIES`, `NVIDIA_RETRY_BACKOFF_S` | 60, 3, 1.5 | Per-request timeout; bounded retries with backoff on 408/409/429/5xx/timeouts |
| `AGENT_MAX_TOOL_CALLS` | 12 | Budget of investigation tool calls |
| `AGENT_MAX_MODEL_TURNS` | 30 | Hard cap on LLM round trips |
| `AGENT_MAX_INVESTIGATION_SECONDS` | 300 | Whole-investigation deadline |
| `AGENT_TOOL_TIMEOUT_S`, `AGENT_MAX_LOG_RESULTS` | 10, 50 | Per-tool timeout; max records per retrieval |
| `AGENT_MAX_CONCURRENT_INVESTIGATIONS`, `AGENT_MAX_QUEUED_INVESTIGATIONS` | 2, 20 | In-process concurrency / queue (429 beyond) |
| `AGENT_DATA_PROVIDER` | `fixture` | `live` is a documented contract only (raises `ProviderError`) |
| `AGENT_SERVICE_TOKEN` | – | Shared secret with the main backend; when set, all `/api/*` calls need `X-Sentinel-Service-Token` |
| `AGENT_DEMO_MODE` | `false` | **Local demo only.** Trusts `X-Demo-User`/`X-Demo-Role` for approvals. Not production security |
| `AGENT_CORS_ORIGINS` | – | Comma-separated explicit origins. Empty = CORS off (recommended; call backend-to-backend) |

Invalid values fail fast with a `ConfigError` naming the variable.

## Run

```bash
export NVIDIA_API_KEY=nvapi-...          # PowerShell: $env:NVIDIA_API_KEY="nvapi-..."
AGENT_DEMO_MODE=true python -m sentinel_agent        # http://127.0.0.1:8100  (docs at /docs)
# or: uvicorn sentinel_agent.main:create_app --factory --port 8100
```

Without `NVIDIA_API_KEY` the service starts, `/health` reports `nvidia_configured:false`, and `POST /api/investigations`
returns **503 `LLM_NOT_CONFIGURED`** — it never fabricates a result.

## Demo

```bash
# Live (real Nemotron calls, needs a key): prints the genuine tool-call trace
python examples/run_investigation.py INC-003
# Offline, no key: scripted stand-in for the model (clearly labelled); tools/simulator/validation are real
python examples/run_investigation.py INC-001 --scripted
```
See `docs/DEMO_GUIDE.md` for the full walkthrough including the HTTP flow and the approval step.

## Test

```bash
pytest                                   # 148 pass, 2 live tests skipped
NVIDIA_API_KEY=nvapi-... RUN_LIVE_NVIDIA_TESTS=1 pytest -m live_nvidia -s    # real model; the ONLY tests that prove it
```

Mocked/scripted vs live: `test_llm_client.py` uses `httpx.MockTransport`; `test_investigator.py`, `test_security.py`
and `test_api.py` use `tests/scripted_llm.py` (a fixed script, **not** a model). Only `test_live_nvidia.py` calls NVIDIA.

## Model and endpoint facts (verified 2026-11-07)

* `GET https://integrate.api.nvidia.com/v1/models` is public and lists, among others,
  `nvidia/nemotron-3-ultra-550b-a55b`, `nvidia/nemotron-3-super-120b-a12b`, `nvidia/llama-3.1-nemotron-ultra-253b-v1`,
  `nvidia/nemotron-3.5-lightning-30b-a3b`.
* `POST /v1/chat/completions` without credentials returns `401 "Header of type authorization was missing"`,
  confirming the Bearer-token requirement.
* Tool calling uses the OpenAI-compatible `tools` / `tool_choice` / `message.tool_calls` shape (per NVIDIA NIM docs).
* **Listed is not callable:** `nvidia/nemotron-3-super-120b-a12b` appears in `/v1/models` but returned 404 "Not found for
  account" for the tested key, as did `llama-3.1-nemotron-ultra-253b-v1`, `nemotron-nano-3-30b-a3b` and the 70B/51B
  instruct models. Tool calls succeeded with `nemotron-3-ultra-550b-a55b`, `nemotron-3.5-lightning-30b-a3b` and
  `nemotron-3.5-super-vl-120b-a12b`. Availability is per account, so probe your own key.
* **Not verified:** rate limits, behaviour on INC-001/INC-002, and reliability across repeated runs.
