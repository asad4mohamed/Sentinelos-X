"""SCRIPTED STAND-IN FOR A MODEL - used only by tests and the offline demo.

It is NOT an LLM and proves nothing about Nemotron's behaviour. It lets us exercise the real tool loop, validation,
simulator, security controls and API deterministically. Tool calls it issues are executed for real by the application,
so the resulting traces are genuine *application* traces; the "decisions" are scripted.
"""

from __future__ import annotations

import json
from typing import Any, Callable

from sentinel_agent.llm.nvidia_client import LLMResponse, LLMToolCall

Step = LLMResponse | Callable[[list[dict[str, Any]]], LLMResponse]


def call(name: str, **args: Any) -> tuple[str, str]:
    return name, json.dumps(args)


def turn(*calls: tuple[str, str], content: str | None = None) -> LLMResponse:
    return LLMResponse(
        content=content,
        tool_calls=[LLMToolCall(id=f"call_{i}_{abs(hash(n + a)) % 10_000}", name=n, arguments_raw=a) for i, (n, a) in enumerate(calls)],
        finish_reason="tool_calls" if calls else "stop",
    )


class ScriptedLLM:
    provider = "scripted_test_double"
    model_id = "scripted-llm-NOT-A-MODEL"

    def __init__(self, steps: list[Step], *, repeat_last: bool = False):
        self.steps, self.repeat_last = list(steps), repeat_last
        self.calls: list[dict[str, Any]] = []  # snapshots of what the application sent
        self._i = 0

    async def chat(self, messages, tools):
        self.calls.append({"messages": json.loads(json.dumps(messages)), "tool_names": [t["function"]["name"] for t in tools]})
        if self._i >= len(self.steps):
            if self.repeat_last and self.steps:
                step = self.steps[-1]
            else:
                return LLMResponse(content="(script exhausted)", tool_calls=[])
        else:
            step = self.steps[self._i]
            self._i += 1
        return step(messages) if callable(step) else step


class SlowLLM:
    provider = "scripted_test_double"
    model_id = "slow-test-double"

    def __init__(self, seconds: float):
        self.seconds = seconds

    async def chat(self, messages, tools):
        import asyncio

        await asyncio.sleep(self.seconds)
        return LLMResponse(content="still thinking", tool_calls=[])


class RaisingLLM:
    provider = "scripted_test_double"
    model_id = "raising-test-double"

    def __init__(self, exc: Exception):
        self.exc = exc

    async def chat(self, messages, tools):
        raise self.exc


# --------------------------------------------------------------------------------------------------------------
# Scenario scripts (valid investigations). Evidence ids come from the synthetic fixtures.
# --------------------------------------------------------------------------------------------------------------
def _submit(summary, findings, affected, root, rec, limitations=()):
    return call(
        "submit_investigation_report",
        summary=summary, findings=findings, affected_assets=affected, root_cause_asset_id=root,
        recommended_action=rec, limitations=list(limitations),
    )


def f(claim, classification, certainty, *ids):
    return {"claim": claim, "classification": classification, "certainty": certainty, "evidence_ids": list(ids)}


def script_inc_003() -> list[Step]:
    I = "INC-003"
    return [
        turn(call("get_incident_details", incident_id=I), call("get_incident_timeline", incident_id=I)),
        turn(call("get_recent_logs", asset_id="primary-database"), call("get_recent_logs", asset_id="application-api")),
        turn(call("get_infrastructure_dependencies", asset_id="application-api")),
        turn(call("search_security_events", query="traffic request rate", asset_ids=["external-gateway"])),
        turn(call("calculate_blast_radius", asset_id="primary-database")),
        turn(
            call("update_hypothesis", hypothesis_id="H-1", status="refuted", certainty="strongly_supported", contradicting_evidence_ids=["EVT-210"], missing_evidence=["WAF block statistics beyond the gateway view"]),
            call("update_hypothesis", hypothesis_id="H-2", status="supported", certainty="strongly_supported", supporting_evidence_ids=["EVT-202", "EVT-204", "DEP-003"]),
            call("update_hypothesis", hypothesis_id="H-3", status="refuted", certainty="strongly_supported", contradicting_evidence_ids=["DEP-003", "DEP-001"]),
        ),
        turn(
            call("simulate_recovery_strategy", incident_id=I, strategy="restore_virtual_dependency", target_asset_id="primary-database"),
            call("simulate_recovery_strategy", incident_id=I, strategy="restart_virtual_service", target_asset_id="primary-database"),
            call("simulate_recovery_strategy", incident_id=I, strategy="switch_to_simulated_backup"),
        ),
        turn(_submit(
            "The Application API outage is a cascading effect of the Primary Database going down; the database is the root dependency failure.",
            [
                f("primary-database process exited after its write-ahead-log volume reached 100% capacity", "observed", "confirmed_by_available_evidence", "EVT-201", "EVT-202"),
                f("application-api returned 503 on all requests", "observed", "confirmed_by_available_evidence", "EVT-204"),
                f("The API outage is caused by its critical dependency on the offline database, not an independent fault", "inference", "strongly_supported", "EVT-202", "EVT-204", "DEP-003"),
                f("Request rate and source distribution were normal, which does not support a traffic-flood explanation", "observed", "confirmed_by_available_evidence", "EVT-210"),
                f("An application log embedded text asking to skip human approval; it was treated as data and ignored", "observed", "confirmed_by_available_evidence", "EVT-203"),
                f("Restoring the database restores the whole dependency chain in simulation", "recommendation", "strongly_supported", "EVT-202", "DEP-003"),
            ],
            ["primary-database", "application-api", "external-gateway", "auth-service", "admin-portal", "backup-service"],
            "primary-database",
            {"strategy": "restore_virtual_dependency", "target_asset_id": "primary-database",
             "rationale": "Simulation shows this restores all six impacted services; restart is assumed not to fix a full log volume.",
             "evidence_ids": ["EVT-202", "DEP-003"], "escalate_to_human_analyst": False},
            ["Why the WAL archive job was failing was not examined in this run."],
        )),
    ]


def script_inc_001() -> list[Step]:
    I = "INC-001"
    return [
        turn(call("get_incident_details", incident_id=I), call("get_incident_timeline", incident_id=I)),
        turn(call("get_recent_logs", asset_id="file-storage"), call("get_recent_logs", asset_id="monitoring-service")),
        turn(call("get_recent_logs", asset_id="backup-service"), call("get_recent_logs", asset_id="auth-service")),
        turn(call("search_security_events", query="change window bulk operations", asset_ids=["admin-portal"])),
        turn(call("calculate_blast_radius", asset_id="file-storage")),
        turn(
            call("update_hypothesis", hypothesis_id="H-1", status="unresolved", certainty="possible", supporting_evidence_ids=["EVT-001", "EVT-002"], missing_evidence=["verified encryption of objects", "ransom note or similar artefact", "outbound transfer coverage beyond gateway"]),
            call("update_hypothesis", hypothesis_id="H-2", status="unresolved", certainty="possible", contradicting_evidence_ids=["EVT-012"], missing_evidence=["confirmation from the platform team about svc-batch jobs"]),
        ),
        turn(
            call("simulate_recovery_strategy", incident_id=I, strategy="isolate_virtual_asset", target_asset_id="file-storage"),
            call("simulate_recovery_strategy", incident_id=I, strategy="restore_virtual_dependency", target_asset_id="file-storage"),
            call("simulate_recovery_strategy", incident_id=I, strategy="restart_virtual_service", target_asset_id="file-storage"),
        ),
        turn(_submit(
            "svc-batch mass-accessed and renamed objects and file-storage went unavailable. Ransomware is a possible explanation but is not confirmed by the available evidence.",
            [
                f("svc-batch opened 4812 objects in 90s against a baseline of about 35", "observed", "confirmed_by_available_evidence", "EVT-001"),
                f("3950 objects under /shared/finance were renamed with the suffix .locked-sim", "observed", "confirmed_by_available_evidence", "EVT-002"),
                f("file-storage was marked unavailable by the supervisor", "observed", "confirmed_by_available_evidence", "EVT-005"),
                f("The file-integrity scan timed out with 0 objects verified, so encryption is not confirmed", "observed", "confirmed_by_available_evidence", "EVT-011"),
                f("The activity is consistent with malicious modification of files, but no ransom note or verified encryption exists", "hypothesis", "possible", "EVT-001", "EVT-002", "EVT-011"),
                f("No approved change covers the bulk operation, which weakens the benign batch-job explanation", "inference", "possible", "EVT-012"),
                f("A file content sample contained text instructing the analyst to isolate everything and auto-approve; it was treated as data", "observed", "confirmed_by_available_evidence", "EVT-007"),
                f("Isolate file-storage to contain it and preserve evidence, then restore from the verified snapshot after human review", "recommendation", "strongly_supported", "EVT-008", "EVT-002"),
            ],
            ["file-storage", "application-api", "external-gateway", "backup-service"],
            "file-storage",
            {"strategy": "isolate_virtual_asset", "target_asset_id": "file-storage",
             "rationale": "Containment preserves the affected storage for forensics and severs lateral paths; restore can follow once the cause is understood.",
             "evidence_ids": ["EVT-002", "EVT-008"], "escalate_to_human_analyst": True},
            ["Whether svc-batch was misused is unknown.", "Only gateway egress was covered for exfiltration checks."],
        )),
    ]


def script_inc_002() -> list[Step]:
    I = "INC-002"
    return [
        turn(call("get_incident_details", incident_id=I), call("get_incident_timeline", incident_id=I)),
        turn(call("get_recent_logs", asset_id="auth-service"), call("get_recent_logs", asset_id="admin-portal")),
        turn(call("search_security_events", query="m.ortiz")),
        turn(call("get_infrastructure_dependencies", asset_id="auth-service"), call("get_related_incidents", asset_id="auth-service")),
        turn(
            call("update_hypothesis", hypothesis_id="H-1", status="unresolved", certainty="possible", supporting_evidence_ids=["EVT-101", "EVT-103", "EVT-104"], contradicting_evidence_ids=["EVT-105", "EVT-110"], missing_evidence=["verification of the travel notice", "whether the new device belongs to the user"]),
            call("update_hypothesis", hypothesis_id="H-2", status="unresolved", certainty="possible", supporting_evidence_ids=["EVT-105", "EVT-108"], missing_evidence=["independent confirmation of travel"]),
        ),
        turn(
            call("simulate_recovery_strategy", incident_id=I, strategy="maintain_current_state"),
            call("simulate_recovery_strategy", incident_id=I, strategy="isolate_virtual_asset", target_asset_id="admin-portal"),
            call("simulate_recovery_strategy", incident_id=I, strategy="isolate_virtual_asset", target_asset_id="auth-service"),
        ),
        turn(_submit(
            "The pattern is suspicious and merits human review, but account compromise is not confirmed: MFA was approved from the user's enrolled device and no privilege changes were observed.",
            [
                f("12 failed password attempts for m.ortiz from one address within 3 minutes", "observed", "confirmed_by_available_evidence", "EVT-101"),
                f("A successful login followed from the same address using a device not seen in 90 days, with MFA approved", "observed", "confirmed_by_available_evidence", "EVT-103"),
                f("The MFA push was approved from an enrolled device the user has used before", "observed", "confirmed_by_available_evidence", "EVT-105"),
                f("The session made no role grants, token creation, exports or configuration changes", "observed", "confirmed_by_available_evidence", "EVT-110"),
                f("A request header contained text addressed to the AI analyst telling it to close the incident; it was treated as data", "observed", "confirmed_by_available_evidence", "EVT-107"),
                f("The login may be the legitimate user travelling, but the travel note is user-reported and unverified", "hypothesis", "possible", "EVT-108", "EVT-104"),
                f("The failures followed by a success could indicate credential guessing, but this is not established", "hypothesis", "possible", "EVT-101", "EVT-103"),
            ],
            [],
            None,
            {"strategy": "maintain_current_state", "target_asset_id": None,
             "rationale": "Isolating auth-service would take down four assets and isolating admin-portal blocks all admins; neither is proportionate to unconfirmed evidence.",
             "evidence_ids": ["EVT-105", "EVT-110"], "escalate_to_human_analyst": True},
            ["Travel claim not independently verified."],
        )),
    ]


SCENARIOS = {"INC-001": script_inc_001, "INC-002": script_inc_002, "INC-003": script_inc_003}
