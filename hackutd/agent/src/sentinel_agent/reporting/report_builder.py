"""Builds the public, validated result object from an investigation run."""

from __future__ import annotations

from ..models import InvestigationResult
from ..orchestration.investigation_state import InvestigationRun


def build_result(run: InvestigationRun) -> InvestigationResult:
    return InvestigationResult(
        investigation_id=run.investigation_id,
        incident_id=run.incident_id,
        status=run.state,
        analysis_complete=run.analysis_complete,
        data_source=run.data_source,
        model_provider=run.model_provider,
        model_id=run.model_id,
        summary=run.summary,
        findings=run.findings,
        hypotheses=run.hypotheses.all(),
        affected_assets=run.affected_assets,
        unaffected_assets=run.unaffected_assets,
        root_cause_candidates=run.root_cause_candidates,
        tool_calls=run.tool_calls,
        evidence=run.ledger.summaries(),
        recovery_options=run.recovery_options,
        simulator_ranking=run.simulator_ranking,
        recommended_action=run.recommended_action,
        proposal=run.proposal,
        limitations=run.limitations,
        rejected_model_claims=run.rejected_claims,
        trace=run.trace(),
        error=run.error,
        created_at=run.created_at,
        started_at=run.started_at,
        completed_at=run.completed_at,
    )
