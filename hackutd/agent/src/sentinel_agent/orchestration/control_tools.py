"""Control-plane functions exposed to the model: update_hypothesis and submit_investigation_report.

They have no effect on infrastructure. They only record the model's analysis, and every claim is validated
by application code (evidence ids, strategies, assets) before it is accepted.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from ..models import (
    ASSET_ID_PATTERN,
    Certainty,
    FindingClassification,
    HypothesisStatus,
    StrategyName,
)
from ..tools.registry import model_schema

UPDATE_HYPOTHESIS = "update_hypothesis"
SUBMIT_REPORT = "submit_investigation_report"
CONTROL_TOOL_NAMES = {UPDATE_HYPOTHESIS, SUBMIT_REPORT}


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class HypothesisUpdateArgs(_Strict):
    hypothesis_id: str | None = Field(default=None, pattern=r"^H-[A-Za-z0-9-]{1,12}$", description="Existing id (e.g. H-1) to revise, or a new id for a hypothesis you add")
    statement: str | None = Field(default=None, min_length=5, max_length=300, description="Required when adding a new hypothesis")
    status: HypothesisStatus
    certainty: Certainty
    supporting_evidence_ids: list[str] = Field(default_factory=list, max_length=20)
    contradicting_evidence_ids: list[str] = Field(default_factory=list, max_length=20)
    missing_evidence: list[str] = Field(default_factory=list, max_length=8, description="Short descriptions of evidence that would settle the question")


class FindingIn(_Strict):
    claim: str = Field(min_length=3, max_length=400)
    classification: FindingClassification
    certainty: Certainty
    evidence_ids: list[str] = Field(default_factory=list, max_length=20)


class RecommendedActionIn(_Strict):
    strategy: StrategyName
    target_asset_id: str | None = Field(default=None, pattern=ASSET_ID_PATTERN)
    rationale: str = Field(min_length=5, max_length=600)
    evidence_ids: list[str] = Field(default_factory=list, max_length=20)
    escalate_to_human_analyst: bool = False


class SubmitReportArgs(_Strict):
    summary: str = Field(min_length=10, max_length=1200, description="Evidence-supported summary; separate what is observed from what is unconfirmed")
    findings: list[FindingIn] = Field(min_length=1, max_length=12)
    affected_assets: list[str] = Field(default_factory=list, max_length=16)
    root_cause_asset_id: str | None = Field(default=None, pattern=ASSET_ID_PATTERN)
    recommended_action: RecommendedActionIn
    limitations: list[str] = Field(default_factory=list, max_length=10, description="Missing evidence, uncertainty, assumptions")


def control_tool_schemas() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": UPDATE_HYPOTHESIS,
                "description": "Record or revise an investigation hypothesis with the evidence ids that support or contradict it. Does not count toward the tool budget.",
                "parameters": model_schema(HypothesisUpdateArgs),
            },
        },
        {
            "type": "function",
            "function": {
                "name": SUBMIT_REPORT,
                "description": "Finish the investigation. Call exactly once after you have gathered evidence and simulated at least two recovery strategies. Rejected with explanations if any citation or claim is invalid.",
                "parameters": model_schema(SubmitReportArgs),
            },
        },
    ]
