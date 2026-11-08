"""Shared types for investigation tools."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from pydantic import BaseModel, ConfigDict

from ..config import Settings
from ..integrations.data_provider import DataProvider
from ..models import EvidenceRecord, Incident, RecoveryOption
from ..simulation.graph import InfraGraph


class ToolArgs(BaseModel):
    """Base for tool argument models: unknown arguments are rejected, never silently ignored."""

    model_config = ConfigDict(extra="forbid")


class ToolFailure(Exception):
    """Expected, model-visible failure (bad id, nothing found, ...)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


@dataclass
class ToolContext:
    incident: Incident
    provider: DataProvider
    graph: InfraGraph
    settings: Settings
    simulations: dict[tuple[str, str | None], RecoveryOption] = field(default_factory=dict)

    @property
    def incident_id(self) -> str:
        return self.incident.incident_id


@dataclass
class ToolOutput:
    data: dict[str, Any]
    evidence: list[EvidenceRecord] = field(default_factory=list)
    truncated: bool = False
    summary: str = ""


@dataclass
class ToolResult:
    ok: bool
    tool_name: str
    data: dict[str, Any] | None = None
    error_code: str | None = None
    error_message: str | None = None
    evidence: list[EvidenceRecord] = field(default_factory=list)
    truncated: bool = False
    summary: str = ""


Handler = Callable[[ToolContext, Any], Awaitable[ToolOutput]]


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    args_model: type[ToolArgs]
    handler: Handler
    read_only: bool = True
