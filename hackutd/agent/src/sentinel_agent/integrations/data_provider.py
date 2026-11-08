"""Data-provider interface. The agent never owns incident state: it reads it through this seam.

Implementations: `FixtureProvider` (local synthetic data) and `LiveProvider` (contract only, see
`spacetime_adapter_contract.py`). All IDs are strings; all timestamps are timezone-aware UTC.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime

from ..models import Asset, Dependency, EvidenceRecord, Incident, ObservedState


class ProviderError(RuntimeError):
    """Provider could not complete the request (unavailable, not configured, ...)."""


class DataProvider(ABC):
    name: str = "abstract"
    data_source: str = "unknown"

    @abstractmethod
    async def get_incident(self, incident_id: str) -> Incident | None: ...

    @abstractmethod
    async def list_incidents(self) -> list[Incident]: ...

    @abstractmethod
    async def list_assets(self) -> list[Asset]: ...

    @abstractmethod
    async def list_dependencies(self) -> list[Dependency]: ...

    @abstractmethod
    async def get_logs(
        self, asset_id: str, start: datetime | None, end: datetime | None, limit: int
    ) -> list[EvidenceRecord]:
        """Most recent `limit` log events for the asset in [start, end], returned in chronological order."""

    @abstractmethod
    async def search_events(
        self, query: str, asset_ids: list[str] | None, start: datetime | None, end: datetime | None, limit: int
    ) -> list[EvidenceRecord]: ...

    @abstractmethod
    async def get_evidence(self, evidence_id: str) -> EvidenceRecord | None:
        """Resolve any evidence id (EVT-*, DEP-*, AST-*)."""

    @abstractmethod
    async def get_asset_state_evidence(self, incident_id: str, asset_id: str) -> EvidenceRecord | None: ...

    # ---- convenience built on the abstract methods
    async def get_asset(self, asset_id: str) -> Asset | None:
        return next((a for a in await self.list_assets() if a.asset_id == asset_id), None)

    async def get_observed_state(self, incident: Incident, asset_id: str) -> ObservedState:
        observed = incident.observed_asset_states.get(asset_id)
        if observed is not None:
            return observed
        return ObservedState(status="healthy", observed_at=incident.window_start, note="no non-healthy observation recorded")
