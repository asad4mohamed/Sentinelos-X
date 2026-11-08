"""FastAPI routes."""

from __future__ import annotations

import hmac

from fastapi import APIRouter, Depends, Query, Request, status

from ..llm.nvidia_client import LLMNotConfigured
from ..models import INCIDENT_ID_PATTERN, InvestigationState, StrategyName
from ..orchestration.control_tools import CONTROL_TOOL_NAMES, control_tool_schemas
from ..orchestration.investigation_state import TERMINAL
from ..orchestration.investigator import IncidentNotFound
from ..orchestration.manager import QueueFull
from ..reporting.report_builder import build_result
from ..security.approvals import APPROVER_ROLES, ApprovalError, resolve_identity
from .schemas import (
    CreateInvestigationRequest, DecisionRequest, DecisionResponse, ErrorResponse, EventsResponse,
    InvestigationCreated, InvestigationResult,
)

VERSION = "0.1.0"
SERVICE_TOKEN_HEADER = "x-sentinel-service-token"


class ApiError(Exception):
    def __init__(self, status_code: int, code: str, message: str, headers: dict[str, str] | None = None):
        super().__init__(message)
        self.status_code, self.code, self.message, self.headers = status_code, code, message, headers


async def require_service_token(request: Request) -> None:
    """When AGENT_SERVICE_TOKEN is configured, every /api call (except proposal decisions, which authenticate the
    human themselves) must come from the main backend holding the token. Unset = open (local development only)."""
    expected = request.app.state.settings.service_token
    if not expected:
        return
    presented = request.headers.get(SERVICE_TOKEN_HEADER, "")
    if not hmac.compare_digest(presented.encode(), expected.encode()):
        raise ApiError(401, "SERVICE_AUTH_REQUIRED", "valid X-Sentinel-Service-Token required")


router = APIRouter()
guarded = APIRouter(dependencies=[Depends(require_service_token)])


def _run_or_404(request: Request, investigation_id: str):
    run = request.app.state.manager.get(investigation_id)
    if run is None:
        raise ApiError(404, "INVESTIGATION_NOT_FOUND", "no such investigation (runs are in-memory and lost on restart)")
    return run


@router.get("/health")
async def health(request: Request):
    s = request.app.state.settings
    return {
        "status": "ok",
        "service": "sentinel-agent",
        "version": VERSION,
        "data_provider": request.app.state.provider.name,
        "data_source": request.app.state.provider.data_source,
        "model_provider": "nvidia",
        "model_id": s.model_id,
        "nvidia_configured": request.app.state.llm is not None,
        "demo_mode": s.demo_mode,
    }


@guarded.get("/api/agent/capabilities")
async def capabilities(request: Request):
    s = request.app.state.settings
    registry = request.app.state.registry
    return {
        "version": VERSION,
        "model_provider": "nvidia",
        "model_id": s.model_id,
        "data_source": request.app.state.provider.data_source,
        "investigation_tools": registry.describe(),
        "control_functions": [t["function"]["name"] for t in control_tool_schemas()],
        "recovery_strategies": [x.value for x in StrategyName],
        "states": [x.value for x in InvestigationState],
        "limits": {
            "max_tool_calls": s.max_tool_calls,
            "max_model_turns": s.max_model_turns,
            "max_investigation_seconds": s.max_investigation_seconds,
            "max_log_results": s.max_log_results,
            "tool_timeout_s": s.tool_timeout_s,
        },
        "security": {
            "investigation_tools_read_only": True,
            "operational_actions_require_human_approval": True,
            "approver_roles": sorted(APPROVER_ROLES),
            "demo_mode": s.demo_mode,
            "service_token_configured": bool(s.service_token),
        },
        "limitations": [
            "Investigations are in-memory and not durable across restarts.",
            "Fixture data provider only; the live provider is a documented contract.",
        ],
    }


@guarded.post(
    "/api/investigations",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=InvestigationCreated,
    responses={404: {"model": ErrorResponse}, 429: {"model": ErrorResponse}, 503: {"model": ErrorResponse}},
)
async def create_investigation(body: CreateInvestigationRequest, request: Request):
    try:
        run = await request.app.state.manager.submit(body.incident_id)
    except IncidentNotFound:
        raise ApiError(404, "INCIDENT_NOT_FOUND", f"incident {body.incident_id} does not exist or is not investigable")
    except LLMNotConfigured:
        raise ApiError(503, "LLM_NOT_CONFIGURED", "the NVIDIA model client is not configured on this server")
    except QueueFull:
        raise ApiError(429, "QUEUE_FULL", "too many queued investigations; retry later", {"Retry-After": "30"})
    base = f"/api/investigations/{run.investigation_id}"
    return InvestigationCreated(
        investigation_id=run.investigation_id,
        incident_id=run.incident_id,
        status=run.state,
        links={"self": base, "events": f"{base}/events", "report": f"{base}/report"},
    )


@guarded.get("/api/investigations/{investigation_id}", response_model=InvestigationResult, responses={404: {"model": ErrorResponse}})
async def get_investigation(investigation_id: str, request: Request):
    return build_result(_run_or_404(request, investigation_id))


@guarded.get("/api/investigations/{investigation_id}/events", response_model=EventsResponse, responses={404: {"model": ErrorResponse}})
async def get_events(investigation_id: str, request: Request, after: int = Query(0, ge=0), limit: int = Query(200, ge=1, le=1000)):
    run = _run_or_404(request, investigation_id)
    events = [e for e in run.events if e.seq > after][:limit]
    return EventsResponse(
        investigation_id=run.investigation_id, status=run.state, events=events,
        next_after=events[-1].seq if events else after,
    )


@guarded.get(
    "/api/investigations/{investigation_id}/report",
    response_model=InvestigationResult,
    responses={404: {"model": ErrorResponse}, 409: {"model": ErrorResponse}},
)
async def get_report(investigation_id: str, request: Request):
    run = _run_or_404(request, investigation_id)
    if run.state not in TERMINAL and run.state != InvestigationState.AWAITING_APPROVAL:
        raise ApiError(409, "REPORT_NOT_READY", f"investigation is {run.state.value}; poll /events or the investigation resource", {"Retry-After": "2"})
    return build_result(run)


@router.post(
    "/api/proposals/{proposal_id}/decision",
    response_model=DecisionResponse,
    responses={401: {"model": ErrorResponse}, 403: {"model": ErrorResponse}, 404: {"model": ErrorResponse}, 409: {"model": ErrorResponse}},
)
async def decide_proposal(proposal_id: str, body: DecisionRequest, request: Request):
    s = request.app.state.settings
    try:
        identity = resolve_identity(dict(request.headers), service_token=s.service_token, demo_mode=s.demo_mode)
    except ApprovalError as exc:
        request.app.state.audit.record("approval_denied", reason=exc.code, proposal_id=proposal_id)
        raise ApiError(exc.status, exc.code, exc.message)
    try:
        proposal, run = request.app.state.manager.decide(proposal_id, identity, body.decision == "approve", body.reason)
    except ApprovalError as exc:
        raise ApiError(exc.status, exc.code, exc.message)
    return DecisionResponse(
        proposal_id=proposal.proposal_id, status=proposal.status.value, decided_by=proposal.decided_by,
        decided_role=proposal.decided_role, authorization_mode=proposal.authorization_mode,
        execution=proposal.execution, investigation_status=run.state if run else None,
    )


router.include_router(guarded)
