"""Run one investigation in-process and print the real trace.

    python examples/run_investigation.py INC-003                # LIVE: needs NVIDIA_API_KEY (real Nemotron calls)
    python examples/run_investigation.py INC-003 --scripted     # OFFLINE: scripted stand-in, NOT a model
    python examples/run_investigation.py INC-001 --out result.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))  # for tests.scripted_llm in --scripted mode

from sentinel_agent.config import ConfigError, Settings  # noqa: E402
from sentinel_agent.integrations.fixture_provider import FixtureProvider  # noqa: E402
from sentinel_agent.llm.nvidia_client import NvidiaClient  # noqa: E402
from sentinel_agent.orchestration.investigator import Investigator  # noqa: E402
from sentinel_agent.reporting.report_builder import build_result  # noqa: E402
from sentinel_agent.security.approvals import ApprovalService  # noqa: E402
from sentinel_agent.security.audit import AuditLog  # noqa: E402
from sentinel_agent.tools.registry import build_default_registry  # noqa: E402


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("incident_id", choices=["INC-001", "INC-002", "INC-003"])
    ap.add_argument("--scripted", action="store_true", help="use the offline scripted double (NOT a language model)")
    ap.add_argument("--out", help="write the full JSON result here")
    args = ap.parse_args()

    try:
        settings = Settings.from_env()
    except ConfigError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2

    client = None
    if args.scripted:
        sys.path.insert(0, str(ROOT / "tests"))
        from scripted_llm import SCENARIOS, ScriptedLLM

        llm = ScriptedLLM(SCENARIOS[args.incident_id]())
        print("*** SCRIPTED OFFLINE RUN: the 'model' is a fixed script, not Nemotron. Tool execution is real. ***\n")
    else:
        if not settings.nvidia_configured:
            print("NVIDIA_API_KEY is not set. Copy .env.example, export the key, or use --scripted.", file=sys.stderr)
            return 2
        llm = client = NvidiaClient(settings)
        print(f"LIVE run with model {settings.model_id}\n")

    audit = AuditLog()
    inv = Investigator(FixtureProvider(), llm, build_default_registry(), settings, audit, ApprovalService(audit))
    try:
        run = await inv.create_run(args.incident_id)
        await inv.execute(run)
    finally:
        if client:
            await client.aclose()

    result = build_result(run)
    print("\n".join(result.trace))
    print(f"\nSTATUS: {result.status.value} (analysis_complete={result.analysis_complete})")
    if result.error:
        print(f"ERROR: {result.error.code}: {result.error.message}")
    if result.summary:
        print(f"\nSUMMARY: {result.summary}")
    for f in result.findings:
        print(f"  [{f.classification.value:<14}|{f.certainty.value}] {f.claim}  {f.evidence_ids}")
    if result.recommended_action:
        a = result.recommended_action
        print(f"\nRECOMMENDED: {a.action_type.value} -> {a.target_asset_id} (approval required: {a.requires_approval}, escalate: {a.escalate_to_human_analyst})")
    print(f"tool calls: {len(result.tool_calls)}; evidence records seen: {len(result.evidence)}")
    if args.out:
        Path(args.out).write_text(result.model_dump_json(indent=2), encoding="utf-8")
        print(f"wrote {args.out}")
    return 0 if result.status.value in {"awaiting_approval", "completed"} else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
