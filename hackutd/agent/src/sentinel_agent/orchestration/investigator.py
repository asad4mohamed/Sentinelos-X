"""Investigation orchestrator: wires provider, tools, LLM loop, validation and approvals together."""

from __future__ import annotations

import asyncio
import json
import logging
import time

from pydantic import ValidationError

from ..config import Settings
from ..integrations.data_provider import DataProvider, ProviderError
from ..llm.nvidia_client import LLMClient, LLMError
from ..llm.prompts import system_prompt, user_request
from ..llm.tool_loop import ControlOutcome, LoopLimitError, ToolExecutor, ToolLoop
from ..models import (
    AssetStatus,
    Certainty,
    Finding,
    FindingClassification,
    InvestigationState as S,
    RecommendedAction,
    StrategyName,
)
from ..reporting.evidence import EvidenceLedger
from ..security.approvals import ApprovalService
from ..security.audit import AuditLog
from ..security.policy import ToolPolicy
from ..simulation.graph import GraphError, InfraGraph
from ..simulation.propagation import root_cause_candidates
from ..simulation.recovery import rank_options
from ..timeutil import now_utc
from ..tools.base import ToolContext
from ..tools.registry import ToolRegistry
from .control_tools import SUBMIT_REPORT, UPDATE_HYPOTHESIS, HypothesisUpdateArgs, SubmitReportArgs
from .hypothesis_manager import HypothesisError, HypothesisManager
from .investigation_state import InvestigationRun

logger = logging.getLogger("sentinel_agent.investigator")

# Loaded security terms must appear in the cited evidence text before an *observed/confirmed* claim may use them.
# This is a heuristic guard, not a semantic proof; it exists to stop the most damaging over-claims.
LOADED_TERMS = ("ransomware", "malware", "compromise", "exfiltrat", "breach", "attacker")

STANDING_LIMITATIONS = [
    "All data is synthetic and the infrastructure is simulated; nothing here describes a real system.",
    "Certainty labels are qualitative and are not calibrated probabilities.",
    "Recovery outcomes are deterministic simulations under scenario assumptions, not measurements; no durations or costs are predicted.",
]


class IncidentNotFound(LookupError):
    pass


class InvestigationFailure(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


class Investigator:
    def __init__(self, provider: DataProvider, llm: LLMClient, registry: ToolRegistry, settings: Settings,
                 audit: AuditLog, approvals: ApprovalService):
        self.provider, self.llm, self.registry, self.s = provider, llm, registry, settings
        self.audit, self.approvals = audit, approvals

    # ------------------------------------------------------------------ lifecycle
    async def create_run(self, incident_id: str) -> InvestigationRun:
        incident = await self.provider.get_incident(incident_id)
        if incident is None or incident.historical:
            raise IncidentNotFound(incident_id)
        return InvestigationRun(
            investigation_id=InvestigationRun.new_id(),
            incident_id=incident_id,
            provider=self.provider,
            hypotheses=HypothesisManager(incident),
            ledger=EvidenceLedger(self.provider),
            model_provider=getattr(self.llm, "provider", "unknown"),
            model_id=getattr(self.llm, "model_id", "unknown"),
            data_source=self.provider.data_source,
        )

    async def execute(self, run: InvestigationRun) -> None:
        """Run the investigation to a terminal/awaiting state. Never raises."""
        run.started_at = now_utc()
        run.emit("investigation_started", f"Investigation started for {run.incident_id}", model_id=run.model_id, data_source=run.data_source)
        run.advance(S.COLLECTING_EVIDENCE, "investigation started")
        try:
            incident = await self.provider.get_incident(run.incident_id)
            if incident is None:
                raise InvestigationFailure("INCIDENT_NOT_FOUND", f"incident {run.incident_id} no longer exists")
            try:
                graph = InfraGraph.build(await self.provider.list_assets(), await self.provider.list_dependencies())
            except GraphError as exc:
                raise InvestigationFailure("INFRASTRUCTURE_MODEL_INVALID", str(exc)) from exc
            ctx = ToolContext(incident=incident, provider=self.provider, graph=graph, settings=self.s)
            policy = ToolPolicy(self.registry.names, run.incident_id, self.registry.read_only_names)
            executor = ToolExecutor(self.registry, policy, ctx, run, self.audit, self.s)
            state = {"repairs": 0}

            async def control(name: str, raw: str) -> ControlOutcome:
                if name == UPDATE_HYPOTHESIS:
                    return await self._handle_hypothesis(run, raw)
                return await self._handle_submission(run, ctx, graph, executor, raw, state)

            deadline = time.monotonic() + self.s.max_investigation_seconds
            loop = ToolLoop(self.llm, executor, run, self.s, control, deadline)
            async with asyncio.timeout(self.s.max_investigation_seconds):
                await loop.run_loop(system_prompt(self.s.max_tool_calls), user_request(run.incident_id, self.s.max_tool_calls))
        except TimeoutError:
            run.fail("INVESTIGATION_TIMEOUT", f"investigation exceeded {self.s.max_investigation_seconds}s")
        except LoopLimitError as exc:
            run.fail(exc.code, exc.message)
        except InvestigationFailure as exc:
            run.fail(exc.code, exc.message)
        except LLMError as exc:
            run.fail(exc.code, exc.message)
        except ProviderError as exc:
            run.fail("DATA_PROVIDER_ERROR", str(exc))
        except Exception:  # noqa: BLE001
            logger.exception("investigation crashed", extra={"investigation_id": run.investigation_id})
            run.fail("INTERNAL_ERROR", "unexpected internal error")

    def conclude_after_decision(self, run: InvestigationRun) -> None:
        """Called once a human decision is recorded on the proposal."""
        if run.state == S.AWAITING_APPROVAL:
            decision = run.proposal.status.value if run.proposal else "unknown"
            run.transition(S.COMPLETED, f"human decision recorded: {decision}")
            run.emit("approval_decided", f"Human decision recorded: {decision}; no action was executed by the agent",
                     proposal_id=run.proposal.proposal_id if run.proposal else None)

    # ------------------------------------------------------------------ control handlers
    async def _handle_hypothesis(self, run: InvestigationRun, raw: str) -> ControlOutcome:
        try:
            args = HypothesisUpdateArgs.model_validate_json(raw or "{}")
        except ValidationError as exc:
            return ControlOutcome({"ok": False, "error": _validation_summary(exc)})
        try:
            hyp = await run.hypotheses.update(args, run.ledger)
        except HypothesisError as exc:
            self.audit.record("evidence_rejected", investigation_id=run.investigation_id, where=UPDATE_HYPOTHESIS, reason=str(exc)[:300])
            return ControlOutcome({"ok": False, "error": str(exc)})
        run.advance(S.ANALYZING, "hypothesis updated")
        run.emit("hypothesis_updated", f"Hypothesis {hyp.hypothesis_id} -> {hyp.status.value} ({hyp.certainty.value})",
                 hypothesis_id=hyp.hypothesis_id, evidence_ids=hyp.supporting_evidence_ids + hyp.contradicting_evidence_ids)
        return ControlOutcome({"ok": True, "hypothesis": hyp.model_dump(mode="json")})

    async def _handle_submission(self, run, ctx: ToolContext, graph: InfraGraph, executor: ToolExecutor, raw: str, state: dict) -> ControlOutcome:
        try:
            args = SubmitReportArgs.model_validate_json(raw or "{}")
            problems = await self._validate_submission(run, ctx, graph, args)
        except ValidationError as exc:
            args, problems = None, [_validation_summary(exc)]
        if problems:
            state["repairs"] += 1
            run.emit("submission_rejected", f"Report rejected ({len(problems)} problem(s)); asking model to correct",
                     problems=[p[:200] for p in problems])
            self.audit.record("report_rejected", investigation_id=run.investigation_id, problems=[p[:200] for p in problems][:6])
            if state["repairs"] > self.s.max_submission_repairs:
                raise InvestigationFailure("SUBMISSION_INVALID", "model could not produce a valid report: " + "; ".join(problems)[:300])
            return ControlOutcome({
                "ok": False, "accepted": False, "problems": problems,
                "instruction": "Fix these problems (you may call more tools if budget remains) and call submit_investigation_report again.",
            })
        assert args is not None
        self._finalize(run, ctx, graph, args)
        return ControlOutcome({"ok": True, "accepted": True, "status": run.state.value}, done=True)

    # ------------------------------------------------------------------ validation
    async def _validate_submission(self, run: InvestigationRun, ctx: ToolContext, graph: InfraGraph, args: SubmitReportArgs) -> list[str]:
        problems: list[str] = []
        ok_calls = [c for c in run.tool_calls if c.status == "ok"]
        if not any(c.tool_name == "get_incident_details" for c in ok_calls):
            problems.append("call get_incident_details before submitting")
        if len(ok_calls) < self.s.min_investigation_tool_calls:
            problems.append(f"at least {self.s.min_investigation_tool_calls} successful investigation tool calls are required (have {len(ok_calls)})")
        if len(ctx.simulations) < self.s.min_simulated_strategies:
            problems.append(f"simulate at least {self.s.min_simulated_strategies} recovery strategies with simulate_recovery_strategy (have {len(ctx.simulations)})")

        all_ids = [e for f in args.findings for e in f.evidence_ids] + list(args.recommended_action.evidence_ids)
        check = await run.ledger.check(all_ids)
        if not check.ok:
            problems.extend(check.problems())
            self.audit.record("evidence_rejected", investigation_id=run.investigation_id, where=SUBMIT_REPORT,
                              fabricated=check.fabricated[:10], unseen=check.unseen[:10])

        for i, f in enumerate(args.findings, 1):
            if f.classification in (FindingClassification.OBSERVED, FindingClassification.INFERENCE) and not f.evidence_ids:
                problems.append(f"finding {i} ({f.classification.value}) must cite at least one evidence id")
            if f.certainty == Certainty.CONFIRMED and f.classification != FindingClassification.OBSERVED:
                problems.append(f"finding {i}: only 'observed' findings may be 'confirmed_by_available_evidence'")
            if f.classification == FindingClassification.OBSERVED or f.certainty == Certainty.CONFIRMED:
                texts = " ".join(
                    f"{r.summary} {r.event_type}".lower() for eid in f.evidence_ids if (r := run.ledger.get(eid))
                )
                for term in LOADED_TERMS:
                    if term in f.claim.lower() and term not in texts:
                        problems.append(f"finding {i} presents '{term}' as observed/confirmed but no cited evidence mentions it; label it a hypothesis")

        for asset in args.affected_assets + ([args.root_cause_asset_id] if args.root_cause_asset_id else []):
            if not graph.has_asset(asset):
                problems.append(f"unknown asset id {asset!r}")

        rec = args.recommended_action
        if rec.strategy == StrategyName.MAINTAIN:
            if rec.target_asset_id is not None:
                problems.append("maintain_current_state must not name a target_asset_id")
            key = (StrategyName.MAINTAIN.value, None)
        else:
            if rec.target_asset_id is None or not graph.has_asset(rec.target_asset_id):
                problems.append("recommended_action needs a valid target_asset_id")
            key = (rec.strategy.value, rec.target_asset_id)
        sim = ctx.simulations.get(key)
        if sim is None:
            problems.append(f"recommended strategy {key[0]}({key[1]}) was not simulated in this investigation; simulate it first")
        elif not sim.executable:
            problems.append(f"recommended strategy {key[0]}({key[1]}) is not executable under the current preconditions")
        return problems

    # ------------------------------------------------------------------ finalize
    def _finalize(self, run: InvestigationRun, ctx: ToolContext, graph: InfraGraph, args: SubmitReportArgs) -> None:
        observed = {a: ctx.incident.observed_asset_states[a].status if a in ctx.incident.observed_asset_states else AssetStatus.HEALTHY for a in graph.assets}
        deterministic_affected = sorted(a for a, s in observed.items() if s != AssetStatus.HEALTHY)
        roots = root_cause_candidates(graph, observed)

        run.summary = args.summary
        run.findings = [
            Finding(finding_id=f"F-{i:03d}", claim=f.claim, classification=f.classification, certainty=f.certainty,
                    evidence_ids=list(dict.fromkeys(f.evidence_ids)))
            for i, f in enumerate(args.findings, 1)
        ]
        run.affected_assets = deterministic_affected  # computed from observed state + graph, not taken from the model
        run.unaffected_assets = sorted(set(graph.assets) - set(deterministic_affected))
        run.root_cause_candidates = roots

        limitations = list(args.limitations) + list(STANDING_LIMITATIONS)
        for claimed in args.affected_assets:
            if claimed not in deterministic_affected:
                run.rejected_claims.append(f"model listed {claimed} as affected but its observed status is healthy; kept out of affected_assets")
        if args.root_cause_asset_id and roots and args.root_cause_asset_id not in roots:
            run.rejected_claims.append(f"model named {args.root_cause_asset_id} as root cause; the dependency analysis implies {roots}")
        for h in run.hypotheses.unassessed():
            limitations.append(f"hypothesis {h.hypothesis_id} was never assessed: {h.statement}")
        for h in run.hypotheses.all():
            for missing in h.missing_evidence:
                limitations.append(f"missing evidence ({h.hypothesis_id}): {missing}")
        run.limitations = list(dict.fromkeys(limitations))

        run.recovery_options = list(ctx.simulations.values())
        run.simulator_ranking = rank_options(run.recovery_options)

        rec = args.recommended_action
        requires_approval = rec.strategy != StrategyName.MAINTAIN
        action = RecommendedAction(
            action_type=rec.strategy, target_asset_id=rec.target_asset_id, requires_approval=requires_approval,
            rationale=rec.rationale, evidence_ids=list(dict.fromkeys(rec.evidence_ids)),
            escalate_to_human_analyst=rec.escalate_to_human_analyst,
        )
        sim = ctx.simulations[(rec.strategy.value, rec.target_asset_id)]
        run.analysis_complete = True
        if requires_approval:
            risks = [f"assumption: {a}" for a in sim.assumptions] + [f"tradeoff: {t}" for t in sim.tradeoffs]
            risks += [f"open question: {h.statement} ({h.certainty.value})" for h in run.hypotheses.all()
                      if h.certainty in (Certainty.POSSIBLE, Certainty.INSUFFICIENT)]
            proposal = self.approvals.create_proposal(
                investigation_id=run.investigation_id, incident_id=run.incident_id, action=action, simulation=sim,
                risk_or_uncertainty=risks,
            )
            action.proposal_id = proposal.proposal_id
            run.proposal = proposal
        run.recommended_action = action
        run.emit("report_ready", "Evidence-backed findings generated", findings=len(run.findings))
        if requires_approval:
            run.transition(S.AWAITING_APPROVAL, "operational change recommended; human approval required")
            run.emit("awaiting_approval", f"Recommendation {rec.strategy.value}({rec.target_asset_id}) awaiting human approval",
                     proposal_id=run.proposal.proposal_id if run.proposal else None)
        else:
            run.transition(S.COMPLETED, "no operational change recommended")


def _validation_summary(exc: ValidationError) -> str:
    return "; ".join(f"{'.'.join(str(p) for p in e['loc']) or 'arguments'}: {e['msg']}" for e in exc.errors()[:6])[:600]
