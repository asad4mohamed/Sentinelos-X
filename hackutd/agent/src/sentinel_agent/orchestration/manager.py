"""In-process investigation manager.

LIMITATION: runs live in memory and in-process asyncio tasks. They are lost on restart and are not shared between
worker processes. Persist results in the main application's authoritative store if durability is required.
"""

from __future__ import annotations

import asyncio
import logging

from ..config import Settings
from ..llm.nvidia_client import LLMNotConfigured
from ..models import ApprovalProposal, InvestigationState
from ..security.approvals import ApprovalError, ApprovalService, TrustedIdentity
from .investigation_state import InvestigationRun
from .investigator import IncidentNotFound, Investigator

logger = logging.getLogger("sentinel_agent.manager")


class QueueFull(RuntimeError):
    pass


class InvestigationManager:
    def __init__(self, investigator: Investigator | None, settings: Settings, approvals: ApprovalService, provider):
        self._investigator = investigator
        self._s = settings
        self.approvals = approvals
        self._provider = provider
        self._runs: dict[str, InvestigationRun] = {}
        self._tasks: set[asyncio.Task] = set()
        self._sem: asyncio.Semaphore | None = None

    async def submit(self, incident_id: str) -> InvestigationRun:
        if self._investigator is None:
            raise LLMNotConfigured("NVIDIA_API_KEY is not configured on the server")
        queued = sum(1 for r in self._runs.values() if r.state == InvestigationState.QUEUED)
        if queued >= self._s.max_queued_investigations:
            raise QueueFull("too many queued investigations")
        run = await self._investigator.create_run(incident_id)  # raises IncidentNotFound
        self._runs[run.investigation_id] = run
        run.emit("investigation_queued", f"Investigation {run.investigation_id} queued for {incident_id}")
        task = asyncio.create_task(self._work(run), name=run.investigation_id)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return run

    async def _work(self, run: InvestigationRun) -> None:
        if self._sem is None:
            self._sem = asyncio.Semaphore(self._s.max_concurrent_investigations)
        async with self._sem:
            await self._investigator.execute(run)  # type: ignore[union-attr]

    def get(self, investigation_id: str) -> InvestigationRun | None:
        return self._runs.get(investigation_id)

    async def wait(self, investigation_id: str) -> None:
        for task in list(self._tasks):
            if task.get_name() == investigation_id:
                await task

    def decide(self, proposal_id: str, identity: TrustedIdentity, approve: bool, reason: str | None) -> tuple[ApprovalProposal, InvestigationRun]:
        proposal = self.approvals.get(proposal_id)
        if proposal is None:
            raise ApprovalError(404, "PROPOSAL_NOT_FOUND", "no such proposal")
        run = self._runs.get(proposal.investigation_id)
        decided = self.approvals.decide(proposal_id, identity, approve, reason)
        if run is not None and self._investigator is not None:
            self._investigator.conclude_after_decision(run)
        return decided, run  # type: ignore[return-value]

    async def shutdown(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
