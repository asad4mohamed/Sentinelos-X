"""Human-in-the-loop approvals.

The agent never executes an operational change. It only creates a proposal. A decision is accepted only from a
`TrustedIdentity`, and a TrustedIdentity can only be produced by `resolve_identity`, which needs either:
  * the shared service token (backend-to-backend; the main app authenticated the human and forwards identity), or
  * explicit local DEMO mode (headers are trusted; NOT production-grade security).
Nothing about identity is read from the request body.
"""

from __future__ import annotations

import hmac
import uuid
from dataclasses import dataclass
from typing import Mapping

from ..models import ApprovalProposal, ApprovalStatus, RecommendedAction, RecoveryOption
from ..timeutil import now_utc
from .audit import AuditLog

APPROVER_ROLES = frozenset({"incident_commander", "security_admin"})
SERVICE_TOKEN_HEADER = "x-sentinel-service-token"
USER_HEADER = "x-authenticated-user-id"
ROLE_HEADER = "x-authenticated-user-role"
DEMO_USER_HEADER = "x-demo-user"
DEMO_ROLE_HEADER = "x-demo-role"

MODE_SERVICE = "service_token_backend_asserted"
MODE_DEMO = "demo_local_NOT_PRODUCTION"


class ApprovalError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


@dataclass(frozen=True)
class TrustedIdentity:
    user_id: str
    role: str
    mode: str


def resolve_identity(headers: Mapping[str, str], *, service_token: str, demo_mode: bool) -> TrustedIdentity:
    h = {k.lower(): v for k, v in headers.items()}
    presented = h.get(SERVICE_TOKEN_HEADER)
    if presented is not None:
        if not service_token or not hmac.compare_digest(presented.encode(), service_token.encode()):
            raise ApprovalError(401, "INVALID_SERVICE_TOKEN", "service token missing or incorrect")
        user, role = h.get(USER_HEADER), h.get(ROLE_HEADER)
        if not user or not role:
            raise ApprovalError(401, "IDENTITY_MISSING", "backend must forward authenticated user id and role")
        return TrustedIdentity(user[:128], role[:64], MODE_SERVICE)
    if demo_mode:
        user, role = h.get(DEMO_USER_HEADER), h.get(DEMO_ROLE_HEADER)
        if not user or not role:
            raise ApprovalError(401, "IDENTITY_MISSING", "demo mode requires X-Demo-User and X-Demo-Role")
        return TrustedIdentity(user[:128], role[:64], MODE_DEMO)
    raise ApprovalError(401, "AUTHENTICATION_REQUIRED", "approval decisions require a trusted backend identity")


class ApprovalService:
    def __init__(self, audit: AuditLog):
        self._audit = audit
        self._proposals: dict[str, ApprovalProposal] = {}

    def create_proposal(
        self,
        *,
        investigation_id: str,
        incident_id: str,
        action: RecommendedAction,
        simulation: RecoveryOption,
        risk_or_uncertainty: list[str],
    ) -> ApprovalProposal:
        proposal = ApprovalProposal(
            proposal_id=f"PRP-{uuid.uuid4().hex[:10]}",
            investigation_id=investigation_id,
            incident_id=incident_id,
            action_type=action.action_type,
            target_asset_id=action.target_asset_id,
            reason=action.rationale,
            supporting_evidence_ids=list(action.evidence_ids),
            simulation_result=simulation,
            risk_or_uncertainty=risk_or_uncertainty,
            approval_required=True,
            created_at=now_utc(),
        )
        self._proposals[proposal.proposal_id] = proposal
        return proposal

    def get(self, proposal_id: str) -> ApprovalProposal | None:
        return self._proposals.get(proposal_id)

    def decide(self, proposal_id: str, identity: TrustedIdentity, approve: bool, reason: str | None) -> ApprovalProposal:
        proposal = self._proposals.get(proposal_id)
        if proposal is None:
            raise ApprovalError(404, "PROPOSAL_NOT_FOUND", "no such proposal")
        if identity.role not in APPROVER_ROLES:
            self._audit.record(
                "approval_denied", investigation_id=proposal.investigation_id, actor=identity.user_id,
                reason="role_not_authorized", role=identity.role, proposal_id=proposal_id,
            )
            raise ApprovalError(403, "ROLE_NOT_AUTHORIZED", f"role {identity.role!r} may not decide proposals")
        if proposal.status != ApprovalStatus.PENDING:
            raise ApprovalError(409, "ALREADY_DECIDED", f"proposal already {proposal.status.value}")
        proposal.status = ApprovalStatus.APPROVED if approve else ApprovalStatus.REJECTED
        proposal.decided_by, proposal.decided_role = identity.user_id, identity.role
        proposal.decided_at = now_utc()
        proposal.decision_reason = (reason or "")[:500] or None
        proposal.authorization_mode = identity.mode
        self._audit.record(
            "approval_granted" if approve else "approval_rejected",
            investigation_id=proposal.investigation_id, actor=identity.user_id, role=identity.role,
            proposal_id=proposal_id, authorization_mode=identity.mode,
        )
        return proposal
