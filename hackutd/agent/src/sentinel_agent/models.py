"""Domain models shared by every layer. String IDs everywhere at the integration boundary."""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .timeutil import UTCDatetime

ASSET_ID_PATTERN = r"^[a-z0-9][a-z0-9-]{1,63}$"
INCIDENT_ID_PATTERN = r"^INC-[A-Za-z0-9-]{1,32}$"
EVIDENCE_ID_PATTERN = r"^(EVT|DEP|AST)-[A-Za-z0-9][A-Za-z0-9-]{0,80}$"

DATA_SOURCE_FIXTURE = "synthetic_fixture"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ----------------------------------------------------------------------------- infrastructure
class AssetStatus(StrEnum):
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNAVAILABLE = "unavailable"


STATUS_RANK = {AssetStatus.HEALTHY: 0, AssetStatus.DEGRADED: 1, AssetStatus.UNAVAILABLE: 2}


class Criticality(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class DependencyKind(StrEnum):
    CRITICAL = "critical"
    OPTIONAL = "optional"


class Asset(StrictModel):
    asset_id: str = Field(pattern=ASSET_ID_PATTERN)
    display_name: str
    asset_type: str
    status: AssetStatus
    criticality: Criticality
    last_status_update: UTCDatetime
    source_label: str = "simulated: virtual infrastructure, no real systems"


class Dependency(StrictModel):
    """Edge `from_asset_id -> to_asset_id` means: from_asset_id DEPENDS ON to_asset_id."""

    dependency_id: str
    from_asset_id: str = Field(pattern=ASSET_ID_PATTERN)
    to_asset_id: str = Field(pattern=ASSET_ID_PATTERN)
    kind: DependencyKind
    description: str


# ----------------------------------------------------------------------------- incidents
class ObservedState(StrictModel):
    status: AssetStatus
    observed_at: UTCDatetime
    note: str | None = None


class TimelineEntry(StrictModel):
    time: UTCDatetime
    description: str
    evidence_ids: list[str] = Field(default_factory=list)


class StrategyName(StrEnum):
    RESTART = "restart_virtual_service"
    ISOLATE = "isolate_virtual_asset"
    RESTORE = "restore_virtual_dependency"
    SWITCH_BACKUP = "switch_to_simulated_backup"
    MAINTAIN = "maintain_current_state"


class CandidateStrategy(StrictModel):
    """A recovery option offered by the scenario. Assumptions are scenario assumptions, not measurements."""

    strategy: StrategyName
    target_asset_id: str | None = Field(default=None, pattern=ASSET_ID_PATTERN)
    assumed_restart_resolves: bool = False
    requires_operational: list[str] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    tradeoffs: list[str] = Field(default_factory=list)


class TriageHypothesis(StrictModel):
    hypothesis_id: str
    statement: str
    source: str = "triage-rule"


class Incident(StrictModel):
    incident_id: str = Field(pattern=INCIDENT_ID_PATTERN)
    title: str
    description: str  # reporter-written => untrusted
    status: str
    severity: str
    detected_at: UTCDatetime
    window_start: UTCDatetime
    window_end: UTCDatetime
    reported_by: str
    primary_asset_ids: list[str] = Field(default_factory=list)
    observed_asset_states: dict[str, ObservedState] = Field(default_factory=dict)
    timeline: list[TimelineEntry] = Field(default_factory=list)
    candidate_strategies: list[CandidateStrategy] = Field(default_factory=list)
    triage_hypotheses: list[TriageHypothesis] = Field(default_factory=list)
    historical: bool = False
    data_source: str = DATA_SOURCE_FIXTURE


# ----------------------------------------------------------------------------- evidence
class Provenance(StrictModel):
    origin: str = DATA_SOURCE_FIXTURE
    provider: str = "fixture"
    record_ref: str  # e.g. "logs.json#EVT-001"


class EvidenceRecord(StrictModel):
    evidence_id: str = Field(pattern=EVIDENCE_ID_PATTERN)
    kind: Literal["log_event", "dependency", "asset_state"]
    source: str
    timestamp: UTCDatetime | None = None
    asset_id: str | None = None
    event_type: str
    summary: str
    severity: str | None = None
    reliability: Literal["high", "medium", "low", "unknown"] = "unknown"
    reliability_basis: str | None = None
    provenance: Provenance
    content_flags: list[str] = Field(default_factory=list)  # e.g. "possible_prompt_injection"


# ----------------------------------------------------------------------------- tools
class ToolError(StrictModel):
    code: str
    message: str


class ToolCallRecord(StrictModel):
    seq: int
    model_tool_call_id: str | None = None
    tool_name: str
    arguments: dict[str, Any]
    status: Literal["ok", "error", "denied"]
    error_code: str | None = None
    started_at: UTCDatetime
    duration_ms: int
    evidence_ids: list[str] = Field(default_factory=list)
    result_summary: str = ""
    counted_toward_budget: bool = True


# ----------------------------------------------------------------------------- simulation
class AssetOutcome(StrictModel):
    asset_id: str
    display_name: str
    criticality: Criticality
    before: AssetStatus
    after: AssetStatus
    changed: Literal["improved", "worsened", "unchanged"]


class PropagationStep(StrictModel):
    asset_id: str
    status: AssetStatus
    caused_by: list[dict[str, str]]  # [{dependency, kind, dependency_status}]


class RecoveryOption(StrictModel):
    """Deterministic result of simulating one strategy. Never produced by the LLM."""

    strategy: StrategyName
    target_asset_id: str | None
    executable: bool  # False when scenario preconditions are not met
    precondition_notes: list[str] = Field(default_factory=list)
    assets_operational: list[str]
    assets_degraded: list[str]
    assets_unavailable: list[str]
    status_counts: dict[str, int]
    restored_services: int
    regressed_services: int
    critical_services_affected: list[str]
    isolated_assets: list[str] = Field(default_factory=list)
    open_lateral_paths: list[str] = Field(default_factory=list)
    severed_lateral_paths: list[str] = Field(default_factory=list)
    asset_outcomes: list[AssetOutcome]
    propagation: list[PropagationStep]
    assumptions: list[str]
    tradeoffs: list[str]
    assumption_label: str = (
        "Assumptions and any effort/time values are scenario assumptions, not measured facts."
    )
    chart: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)


# ----------------------------------------------------------------------------- hypotheses / findings
class HypothesisStatus(StrEnum):
    OPEN = "open"
    SUPPORTED = "supported"
    REFUTED = "refuted"
    UNRESOLVED = "unresolved"


class Certainty(StrEnum):
    """Qualitative labels. NOT calibrated probabilities."""

    CONFIRMED = "confirmed_by_available_evidence"
    STRONG = "strongly_supported"
    POSSIBLE = "possible"
    INSUFFICIENT = "insufficient_evidence"


class Hypothesis(StrictModel):
    hypothesis_id: str
    statement: str
    origin: Literal["triage", "model"]
    status: HypothesisStatus = HypothesisStatus.OPEN
    certainty: Certainty = Certainty.INSUFFICIENT
    supporting_evidence_ids: list[str] = Field(default_factory=list)
    contradicting_evidence_ids: list[str] = Field(default_factory=list)
    missing_evidence: list[str] = Field(default_factory=list)
    revision: int = 0


class FindingClassification(StrEnum):
    OBSERVED = "observed"
    INFERENCE = "inference"
    HYPOTHESIS = "hypothesis"
    RECOMMENDATION = "recommendation"


class Finding(StrictModel):
    finding_id: str
    claim: str = Field(min_length=3, max_length=500)
    classification: FindingClassification
    certainty: Certainty
    evidence_ids: list[str] = Field(default_factory=list)


# ----------------------------------------------------------------------------- approvals
class ApprovalStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


class ApprovalProposal(StrictModel):
    proposal_id: str
    investigation_id: str
    incident_id: str
    action_type: StrategyName
    target_asset_id: str | None
    reason: str
    supporting_evidence_ids: list[str]
    simulation_result: RecoveryOption
    risk_or_uncertainty: list[str]
    approval_required: bool = True
    status: ApprovalStatus = ApprovalStatus.PENDING
    created_at: UTCDatetime
    decided_by: str | None = None
    decided_role: str | None = None
    decided_at: UTCDatetime | None = None
    decision_reason: str | None = None
    authorization_mode: str | None = None
    execution: str = "not_performed_by_agent"  # this service never executes operational changes


class RecommendedAction(StrictModel):
    action_type: StrategyName
    target_asset_id: str | None
    requires_approval: bool
    rationale: str
    evidence_ids: list[str] = Field(default_factory=list)
    escalate_to_human_analyst: bool = False
    proposal_id: str | None = None


# ----------------------------------------------------------------------------- investigation
class InvestigationState(StrEnum):
    QUEUED = "queued"
    COLLECTING_EVIDENCE = "collecting_evidence"
    ANALYZING = "analyzing"
    SIMULATING_RECOVERY = "simulating_recovery"
    AWAITING_APPROVAL = "awaiting_approval"
    COMPLETED = "completed"
    FAILED = "failed"


class InvestigationEvent(StrictModel):
    seq: int
    timestamp: UTCDatetime
    type: str
    message: str
    data: dict[str, Any] = Field(default_factory=dict)


class InvestigationError(StrictModel):
    code: str
    message: str


class EvidenceSummary(StrictModel):
    evidence: EvidenceRecord
    retrieved_by_tool_calls: list[int]


class InvestigationResult(StrictModel):
    investigation_id: str
    incident_id: str
    status: InvestigationState
    analysis_complete: bool
    data_source: str
    model_provider: str
    model_id: str
    summary: str | None = None
    findings: list[Finding] = Field(default_factory=list)
    hypotheses: list[Hypothesis] = Field(default_factory=list)
    affected_assets: list[str] = Field(default_factory=list)
    unaffected_assets: list[str] = Field(default_factory=list)
    root_cause_candidates: list[str] = Field(default_factory=list)
    tool_calls: list[ToolCallRecord] = Field(default_factory=list)
    evidence: list[EvidenceSummary] = Field(default_factory=list)
    recovery_options: list[RecoveryOption] = Field(default_factory=list)
    simulator_ranking: list[dict[str, Any]] = Field(default_factory=list)
    recommended_action: RecommendedAction | None = None
    proposal: ApprovalProposal | None = None
    limitations: list[str] = Field(default_factory=list)
    rejected_model_claims: list[str] = Field(default_factory=list)
    trace: list[str] = Field(default_factory=list)
    error: InvestigationError | None = None
    created_at: UTCDatetime
    started_at: UTCDatetime | None = None
    completed_at: UTCDatetime | None = None
