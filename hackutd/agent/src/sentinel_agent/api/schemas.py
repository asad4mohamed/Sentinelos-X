"""HTTP request/response models. The investigation result schema itself lives in `sentinel_agent.models`."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from ..models import INCIDENT_ID_PATTERN, InvestigationEvent, InvestigationResult, InvestigationState

__all__ = [
    "CreateInvestigationRequest", "InvestigationCreated", "EventsResponse", "DecisionRequest",
    "DecisionResponse", "ErrorBody", "ErrorResponse", "InvestigationResult",
]


class CreateInvestigationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    incident_id: str = Field(pattern=INCIDENT_ID_PATTERN, examples=["INC-003"])


class InvestigationCreated(BaseModel):
    investigation_id: str
    incident_id: str
    status: InvestigationState
    links: dict[str, str]


class EventsResponse(BaseModel):
    investigation_id: str
    status: InvestigationState
    events: list[InvestigationEvent]
    next_after: int = Field(description="Pass as ?after= to receive only newer events")


class DecisionRequest(BaseModel):
    """Only the decision and a reason. Identity and role are NEVER read from the body."""

    model_config = ConfigDict(extra="forbid")
    decision: Literal["approve", "reject"]
    reason: str | None = Field(default=None, max_length=500)


class DecisionResponse(BaseModel):
    proposal_id: str
    status: str
    decided_by: str | None
    decided_role: str | None
    authorization_mode: str | None
    execution: str
    investigation_status: InvestigationState | None


class ErrorBody(BaseModel):
    code: str
    message: str
    details: Any | None = None


class ErrorResponse(BaseModel):
    error: ErrorBody
