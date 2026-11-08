from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

from sentinel_agent.config import Settings
from sentinel_agent.integrations.fixture_provider import FixtureProvider
from sentinel_agent.orchestration.investigator import Investigator
from sentinel_agent.security.approvals import ApprovalService
from sentinel_agent.security.audit import AuditLog
from sentinel_agent.simulation.graph import InfraGraph
from sentinel_agent.tools.base import ToolContext
from sentinel_agent.tools.registry import build_default_registry

GROUND_TRUTH = json.loads((Path(__file__).parent / "ground_truth.json").read_text(encoding="utf-8"))


def fast_settings(**overrides) -> Settings:
    base = Settings(nvidia_api_key="test-key-not-real", retry_backoff_s=0.0, max_investigation_seconds=20.0)
    return replace(base, **overrides)


@pytest.fixture
def ground_truth():
    return GROUND_TRUTH


@pytest.fixture
def provider():
    return FixtureProvider()


@pytest.fixture
async def graph(provider):
    return InfraGraph.build(await provider.list_assets(), await provider.list_dependencies())


@pytest.fixture
def registry():
    return build_default_registry()


@pytest.fixture
async def make_ctx(provider, graph):
    async def _make(incident_id="INC-003", **settings_overrides):
        return ToolContext(await provider.get_incident(incident_id), provider, graph, fast_settings(**settings_overrides))

    return _make


@pytest.fixture
def audit():
    return AuditLog()


@pytest.fixture
def approvals(audit):
    return ApprovalService(audit)


@pytest.fixture
def make_investigator(provider, registry, audit, approvals):
    def _make(llm, **settings_overrides):
        return Investigator(provider, llm, registry, fast_settings(**settings_overrides), audit, approvals)

    return _make


@pytest.fixture
def run_scripted(make_investigator):
    async def _run(incident_id, llm, **settings_overrides):
        inv = make_investigator(llm, **settings_overrides)
        run = await inv.create_run(incident_id)
        await inv.execute(run)
        return inv, run

    return _run
