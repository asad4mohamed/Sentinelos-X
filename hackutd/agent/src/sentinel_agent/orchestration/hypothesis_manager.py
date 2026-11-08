"""Hypothesis tracking. Seeded from triage hypotheses; revised by the model through validated updates."""

from __future__ import annotations

from ..models import Certainty, Hypothesis, HypothesisStatus, Incident
from ..reporting.evidence import EvidenceLedger
from .control_tools import HypothesisUpdateArgs


class HypothesisError(ValueError):
    pass


MAX_HYPOTHESES = 8


class HypothesisManager:
    def __init__(self, incident: Incident):
        self._items: dict[str, Hypothesis] = {
            h.hypothesis_id: Hypothesis(hypothesis_id=h.hypothesis_id, statement=h.statement, origin="triage")
            for h in incident.triage_hypotheses
        }
        self._model_counter = 0

    def all(self) -> list[Hypothesis]:
        return list(self._items.values())

    def unassessed(self) -> list[Hypothesis]:
        return [h for h in self._items.values() if h.status == HypothesisStatus.OPEN]

    async def update(self, args: HypothesisUpdateArgs, ledger: EvidenceLedger) -> Hypothesis:
        support = list(dict.fromkeys(args.supporting_evidence_ids))
        contra = list(dict.fromkeys(args.contradicting_evidence_ids))
        check = await ledger.check(support + contra)
        if not check.ok:
            raise HypothesisError("; ".join(check.problems()))

        strong = args.certainty in (Certainty.CONFIRMED, Certainty.STRONG)
        if args.status == HypothesisStatus.SUPPORTED and not support:
            raise HypothesisError("status 'supported' requires supporting_evidence_ids")
        if args.status == HypothesisStatus.REFUTED and not contra:
            raise HypothesisError("status 'refuted' requires contradicting_evidence_ids; use 'unresolved' if you only lack evidence")
        if strong and args.status in (HypothesisStatus.OPEN, HypothesisStatus.UNRESOLVED):
            raise HypothesisError(f"certainty '{args.certainty.value}' is not allowed while status is '{args.status.value}'")

        existing = self._items.get(args.hypothesis_id) if args.hypothesis_id else None
        if existing is None:
            if not args.statement:
                raise HypothesisError("a new hypothesis needs a statement (unknown hypothesis_id?)")
            if len(self._items) >= MAX_HYPOTHESES:
                raise HypothesisError(f"at most {MAX_HYPOTHESES} hypotheses are tracked")
            hid = args.hypothesis_id
            if hid is None or hid in self._items:
                self._model_counter += 1
                hid = f"H-M{self._model_counter}"
            existing = Hypothesis(hypothesis_id=hid, statement=args.statement, origin="model")
            self._items[hid] = existing
        existing.status = args.status
        existing.certainty = args.certainty
        existing.supporting_evidence_ids = support
        existing.contradicting_evidence_ids = contra
        existing.missing_evidence = [m[:200] for m in args.missing_evidence]
        existing.revision += 1
        return existing
