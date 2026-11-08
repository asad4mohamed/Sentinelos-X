"""End-to-end investigator tests using a SCRIPTED model double (not a real LLM). They verify the application:
real tool execution, evidence validation, state machine, simulator integration, approvals, limits."""

from __future__ import annotations

import json

import pytest

from sentinel_agent.llm.nvidia_client import LLMRateLimited, LLMUnavailable
from sentinel_agent.models import InvestigationResult, InvestigationState as S
from sentinel_agent.orchestration.investigation_state import InvalidTransition, can_transition
from sentinel_agent.reporting.report_builder import build_result
from scripted_llm import RaisingLLM, ScriptedLLM, SlowLLM, SCENARIOS, call, f, turn, script_inc_003, _submit


# ----------------------------------------------------------------------------- happy paths vs ground truth
@pytest.mark.parametrize("incident_id", ["INC-001", "INC-002", "INC-003"])
async def test_scripted_investigation_matches_ground_truth(incident_id, run_scripted, ground_truth):
    gt = ground_truth[incident_id]
    llm = ScriptedLLM(SCENARIOS[incident_id]())
    _, run = await run_scripted(incident_id, llm)
    assert run.error is None, run.error
    assert run.analysis_complete
    assert run.affected_assets == gt["affected_assets"]
    assert run.unaffected_assets == gt["unaffected_assets"]
    assert run.root_cause_candidates == gt["root_cause_candidates"]

    rec = run.recommended_action
    assert [rec.action_type.value, rec.target_asset_id] in gt["acceptable_recommendations"]
    assert [rec.action_type.value, rec.target_asset_id] not in gt["unacceptable_recommendations"]
    assert len(run.recovery_options) >= 2

    # nothing observed/confirmed uses a term the ground truth marks as unconfirmed
    for finding in run.findings:
        if finding.classification.value == "observed" or finding.certainty.value == "confirmed_by_available_evidence":
            for term in gt["forbidden_confirmed_terms"]:
                assert term not in finding.claim.lower()
    # every cited id was really retrieved
    for finding in run.findings:
        assert all(run.ledger.has_seen(e) for e in finding.evidence_ids)
    # injection evidence was retrieved, flagged, and never obeyed
    for eid in gt["injection_evidence"]:
        rec_ev = run.ledger.get(eid)
        assert rec_ev is not None and "possible_prompt_injection" in rec_ev.content_flags


async def test_inc003_identifies_root_dependency_not_independent_incidents(run_scripted):
    _, run = await run_scripted("INC-003", ScriptedLLM(script_inc_003()))
    assert run.root_cause_candidates == ["primary-database"]
    h = {x.hypothesis_id: x for x in run.hypotheses.all()}
    assert h["H-2"].status.value == "supported" and h["H-3"].status.value == "refuted"
    assert run.recommended_action.requires_approval is True
    assert run.state == S.AWAITING_APPROVAL


async def test_inc001_ransomware_stays_unconfirmed(run_scripted):
    _, run = await run_scripted("INC-001", ScriptedLLM(SCENARIOS["INC-001"]()))
    ransomware = next(h for h in run.hypotheses.all() if h.hypothesis_id == "H-1")
    assert ransomware.status.value == "unresolved" and ransomware.certainty.value == "possible"
    assert ransomware.missing_evidence
    classes = {f.classification.value for f in run.findings}
    assert {"observed", "hypothesis"} <= classes


async def test_inc002_does_not_claim_compromise_and_does_not_isolate(run_scripted):
    _, run = await run_scripted("INC-002", ScriptedLLM(SCENARIOS["INC-002"]()))
    assert run.recommended_action.action_type.value == "maintain_current_state"
    assert run.recommended_action.escalate_to_human_analyst is True
    assert run.proposal is None and run.state == S.COMPLETED
    assert not any("compromise" in f.claim.lower() and f.classification.value == "observed" for f in run.findings)


# ----------------------------------------------------------------------------- trace honesty / state machine
async def test_tool_call_records_match_what_the_llm_requested_and_state_progressed(run_scripted):
    llm = ScriptedLLM(script_inc_003())
    _, run = await run_scripted("INC-003", llm)
    requested = [c["name"] for step in llm.steps for c in [{"name": tc.name} for tc in step.tool_calls]
                 if c["name"] not in ("update_hypothesis", "submit_investigation_report")]
    assert [t.tool_name for t in run.tool_calls] == requested
    assert all(t.status == "ok" for t in run.tool_calls)
    assert [t.seq for t in run.tool_calls] == list(range(1, len(run.tool_calls) + 1))
    states = [e.data["to_state"] for e in run.events if e.type == "state_changed"]
    assert states == ["collecting_evidence", "analyzing", "simulating_recovery", "awaiting_approval"]
    seqs = [e.seq for e in run.events]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
    assert run.trace()[0].startswith("[00:00] Investigation started for INC-003")


async def test_result_is_json_serialisable_and_schema_valid(run_scripted):
    _, run = await run_scripted("INC-003", ScriptedLLM(script_inc_003()))
    result = build_result(run)
    text = result.model_dump_json()
    again = InvestigationResult.model_validate_json(text)
    assert again.status == S.AWAITING_APPROVAL and again.data_source == "synthetic_fixture"
    assert json.loads(text)["created_at"].endswith("Z")
    assert again.model_provider == "scripted_test_double"


def test_state_machine_rules():
    assert can_transition(S.QUEUED, S.COLLECTING_EVIDENCE)
    assert can_transition(S.COLLECTING_EVIDENCE, S.SIMULATING_RECOVERY)  # skipping is fine
    assert not can_transition(S.SIMULATING_RECOVERY, S.ANALYZING)  # never backwards
    assert not can_transition(S.COMPLETED, S.FAILED) and not can_transition(S.FAILED, S.COMPLETED)
    assert can_transition(S.ANALYZING, S.FAILED)


async def test_invalid_transition_raises(run_scripted):
    _, run = await run_scripted("INC-003", ScriptedLLM(script_inc_003()))
    with pytest.raises(InvalidTransition):
        run.transition(S.ANALYZING)


# ----------------------------------------------------------------------------- evidence validation
def _script_with_submission(findings, rec=None):
    base = script_inc_003()[:-1]
    rec = rec or {"strategy": "restore_virtual_dependency", "target_asset_id": "primary-database", "rationale": "restores the chain", "evidence_ids": ["EVT-202"], "escalate_to_human_analyst": False}
    return base, _submit("Root cause is the database failure and it cascaded.", findings, ["primary-database"], "primary-database", rec)


async def test_fabricated_evidence_is_rejected_then_repaired(run_scripted, audit):
    bad = [f("The database crashed", "observed", "confirmed_by_available_evidence", "EVT-999")]
    good = [f("The database crashed", "observed", "confirmed_by_available_evidence", "EVT-202")]
    base, bad_submit = _script_with_submission(bad)
    _, good_submit = _script_with_submission(good)
    llm = ScriptedLLM(base + [turn(bad_submit), turn(good_submit)])
    _, run = await run_scripted("INC-003", llm)
    assert run.error is None and run.analysis_complete
    rejected = [e for e in run.events if e.type == "submission_rejected"]
    assert len(rejected) == 1 and "EVT-999" in json.dumps(rejected[0].data)
    assert audit.find("evidence_rejected", run.investigation_id)
    # the model saw the rejection reason
    last_tool_msgs = [m for m in llm.calls[-1]["messages"] if m["role"] == "tool"]
    assert "do not exist" in last_tool_msgs[-1]["content"]


async def test_unseen_but_real_evidence_is_rejected(run_scripted):
    # EVT-209 exists but this script never retrieves backup-service logs
    bad = [f("Backups were skipped", "observed", "confirmed_by_available_evidence", "EVT-209")]
    base, submit = _script_with_submission(bad)
    llm = ScriptedLLM(base + [turn(submit)], repeat_last=True)
    _, run = await run_scripted("INC-003", llm, max_submission_repairs=1)
    assert run.state == S.FAILED and run.error.code == "SUBMISSION_INVALID"
    assert "never retrieved" in run.error.message


async def test_persistent_fabrication_fails_and_is_never_marked_completed(run_scripted):
    bad = [f("x claim here", "observed", "confirmed_by_available_evidence", "EVT-424")]
    base, submit = _script_with_submission(bad)
    _, run = await run_scripted("INC-003", ScriptedLLM(base + [turn(submit)], repeat_last=True))
    assert run.state == S.FAILED and run.analysis_complete is False
    assert run.recommended_action is None and run.proposal is None
    assert build_result(run).status == S.FAILED


async def test_observed_claim_with_unsupported_loaded_term_is_rejected(run_scripted):
    bad = [f("Ransomware encrypted the database", "observed", "confirmed_by_available_evidence", "EVT-202")]
    base, submit = _script_with_submission(bad)
    _, run = await run_scripted("INC-003", ScriptedLLM(base + [turn(submit)], repeat_last=True), max_submission_repairs=0)
    assert run.state == S.FAILED and "ransomware" in run.error.message


async def test_only_observed_findings_may_be_confirmed(run_scripted):
    bad = [f("The database failure caused the outage", "inference", "confirmed_by_available_evidence", "EVT-202")]
    base, submit = _script_with_submission(bad)
    _, run = await run_scripted("INC-003", ScriptedLLM(base + [turn(submit)], repeat_last=True), max_submission_repairs=0)
    assert run.state == S.FAILED and "only 'observed'" in run.error.message


async def test_recommendation_must_have_been_simulated(run_scripted):
    good = [f("The database crashed", "observed", "confirmed_by_available_evidence", "EVT-202")]
    rec = {"strategy": "isolate_virtual_asset", "target_asset_id": "primary-database", "rationale": "isolate it", "evidence_ids": ["EVT-202"]}
    base, submit = _script_with_submission(good, rec)
    _, run = await run_scripted("INC-003", ScriptedLLM(base + [turn(submit)], repeat_last=True), max_submission_repairs=0)
    assert run.state == S.FAILED and "was not simulated" in run.error.message


async def test_invalid_asset_in_report_is_rejected(run_scripted):
    base = script_inc_003()[:-1]
    submit = _submit("Summary long enough here.", [f("The database crashed", "observed", "confirmed_by_available_evidence", "EVT-202")],
                     ["made-up-asset"], None,
                     {"strategy": "restore_virtual_dependency", "target_asset_id": "primary-database", "rationale": "restore it", "evidence_ids": ["EVT-202"]})
    _, run = await run_scripted("INC-003", ScriptedLLM(base + [turn(submit)], repeat_last=True), max_submission_repairs=0)
    assert run.state == S.FAILED and "unknown asset" in run.error.message


async def test_report_requires_real_investigation_and_two_simulations(run_scripted):
    # model tries to answer immediately without investigating
    submit = _submit("Everything is fine and nothing was checked.", [f("Nothing wrong", "hypothesis", "possible")], [], None,
                     {"strategy": "maintain_current_state", "rationale": "do nothing now", "evidence_ids": []})
    _, run = await run_scripted("INC-003", ScriptedLLM([turn(submit)], repeat_last=True), max_submission_repairs=1)
    assert run.state == S.FAILED
    assert "get_incident_details" in run.error.message and "simulate at least 2" in run.error.message
    assert run.tool_calls == []


async def test_model_affected_asset_claims_do_not_override_computed_state(run_scripted):
    base = script_inc_003()[:-1]
    submit = _submit("Summary is long enough.", [f("The database crashed", "observed", "confirmed_by_available_evidence", "EVT-202")],
                     ["primary-database", "file-storage"], "file-storage",
                     {"strategy": "restore_virtual_dependency", "target_asset_id": "primary-database", "rationale": "restore it", "evidence_ids": ["EVT-202"]})
    _, run = await run_scripted("INC-003", ScriptedLLM(base + [turn(submit)]))
    assert "file-storage" not in run.affected_assets
    assert any("file-storage" in c for c in run.rejected_claims)


# ----------------------------------------------------------------------------- limits and failures
async def test_max_tool_calls_limit_is_enforced(run_scripted, audit):
    llm = ScriptedLLM([turn(call("get_asset_status", asset_id="auth-service"))], repeat_last=True)
    _, run = await run_scripted("INC-003", llm, max_tool_calls=5, max_model_turns=12, min_investigation_tool_calls=3)
    counted = [t for t in run.tool_calls if t.counted_toward_budget]
    assert len(counted) == 5
    denied = [t for t in run.tool_calls if t.error_code == "TOOL_BUDGET_EXHAUSTED"]
    assert denied == [] or all(not d.counted_toward_budget for d in denied)
    assert run.state == S.FAILED
    assert any(e.type == "budget_exhausted" for e in run.events)
    # once exhausted the model is offered only the control functions
    assert llm.calls[-1]["tool_names"] == ["update_hypothesis", "submit_investigation_report"]


async def test_endless_tool_loop_stops_at_model_turn_limit(run_scripted):
    llm = ScriptedLLM([turn(call("update_hypothesis", hypothesis_id="H-1", status="open", certainty="insufficient_evidence"))], repeat_last=True)
    _, run = await run_scripted("INC-003", llm, max_model_turns=6)
    assert run.state == S.FAILED and run.error.code == "MAX_MODEL_TURNS"
    assert len(llm.calls) == 6


async def test_model_that_never_calls_tools_fails_cleanly(run_scripted):
    _, run = await run_scripted("INC-003", ScriptedLLM([], repeat_last=False))
    assert run.state == S.FAILED and run.error.code == "MODEL_NO_SUBMISSION"


async def test_duplicate_calls_are_flagged_and_counted(run_scripted):
    llm = ScriptedLLM([turn(call("get_asset_status", asset_id="auth-service")), turn(call("get_asset_status", asset_id="auth-service"))])
    _, run = await run_scripted("INC-003", llm)
    tool_msgs = [json.loads(m["content"]) for m in llm.calls[-1]["messages"] if m["role"] == "tool"]
    assert "duplicate_call" in tool_msgs[-1]["data"]
    assert len([t for t in run.tool_calls if t.status == "ok"]) == 2


async def test_model_api_failure_marks_investigation_failed(run_scripted):
    _, run = await run_scripted("INC-003", RaisingLLM(LLMUnavailable("NVIDIA service error 503", status=503)))
    assert run.state == S.FAILED and run.error.code == "LLM_UNAVAILABLE"
    assert run.analysis_complete is False and run.recommended_action is None


async def test_rate_limit_failure_is_reported(run_scripted):
    _, run = await run_scripted("INC-003", RaisingLLM(LLMRateLimited("NVIDIA rate limit reached", status=429)))
    assert run.state == S.FAILED and run.error.code == "LLM_RATE_LIMITED"


async def test_investigation_timeout(run_scripted):
    _, run = await run_scripted("INC-003", SlowLLM(5), max_investigation_seconds=0.2)
    assert run.state == S.FAILED and run.error.code == "INVESTIGATION_TIMEOUT"


async def test_missing_incident(make_investigator):
    from sentinel_agent.orchestration.investigator import IncidentNotFound
    inv = make_investigator(ScriptedLLM([]))
    with pytest.raises(IncidentNotFound):
        await inv.create_run("INC-404")
    with pytest.raises(IncidentNotFound):  # historical incidents are not investigable
        await inv.create_run("INC-090")


async def test_malformed_tool_calls_do_not_crash_the_loop(run_scripted):
    from sentinel_agent.llm.nvidia_client import LLMResponse, LLMToolCall
    bad = LLMResponse(content=None, tool_calls=[
        LLMToolCall("c1", "get_asset_status", "{not json"),
        LLMToolCall("c2", "", ""),
        LLMToolCall("c3", "get_asset_status", json.dumps({"asset_id": "auth-service", "evil": 1})),
    ])
    _, run = await run_scripted("INC-003", ScriptedLLM([bad]), max_model_turns=3)
    statuses = [(t.status, t.error_code) for t in run.tool_calls]
    assert statuses[0] == ("error", "MALFORMED_ARGUMENTS")
    assert statuses[1][0] == "denied"
    assert statuses[2] == ("error", "INVALID_ARGUMENTS")
