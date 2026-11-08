"""LIVE NVIDIA smoke tests. SKIPPED unless NVIDIA_API_KEY is set AND RUN_LIVE_NVIDIA_TESTS=1.

A green run of these (and only these) is evidence that a real Nemotron model performed tool calling.
Everything else in this suite uses mocks or scripted doubles.

    NVIDIA_API_KEY=nvapi-... RUN_LIVE_NVIDIA_TESTS=1 pytest -m live_nvidia -s
"""

from __future__ import annotations

import os

import pytest

from sentinel_agent.config import Settings
from sentinel_agent.llm.nvidia_client import NvidiaClient
from sentinel_agent.models import InvestigationState as S

pytestmark = [
    pytest.mark.live_nvidia,
    pytest.mark.skipif(
        not (os.environ.get("NVIDIA_API_KEY") and os.environ.get("RUN_LIVE_NVIDIA_TESTS") == "1"),
        reason="live NVIDIA test: set NVIDIA_API_KEY and RUN_LIVE_NVIDIA_TESTS=1",
    ),
]


async def test_live_model_issues_a_tool_call():
    client = NvidiaClient(Settings.from_env())
    tools = [{"type": "function", "function": {
        "name": "get_asset_status", "description": "Get status of a virtual asset by id.",
        "parameters": {"type": "object", "properties": {"asset_id": {"type": "string"}}, "required": ["asset_id"]}}}]
    try:
        resp = await client.chat([{"role": "user", "content": "What is the status of asset primary-database? Use the tool."}], tools)
    finally:
        await client.aclose()
    assert resp.tool_calls, f"model returned no tool call: {resp.content!r}"
    assert resp.tool_calls[0].name == "get_asset_status"


@pytest.mark.parametrize("incident_id", ["INC-003"])
async def test_live_full_investigation(incident_id, provider, registry, audit, approvals):
    from sentinel_agent.orchestration.investigator import Investigator

    settings = Settings.from_env()
    client = NvidiaClient(settings)
    try:
        inv = Investigator(provider, client, registry, settings, audit, approvals)
        run = await inv.create_run(incident_id)
        await inv.execute(run)
    finally:
        await client.aclose()
    print("\n".join(run.trace()))
    assert run.state in {S.AWAITING_APPROVAL, S.COMPLETED}, run.error
    assert len({t.tool_name for t in run.tool_calls if t.status == "ok"}) >= 3
    assert run.root_cause_candidates == ["primary-database"]
