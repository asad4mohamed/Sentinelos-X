"""Tool registry: machine-readable schemas, argument validation, bounded safe execution."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from pydantic import ValidationError

from . import asset_tools, dependency_tools, incident_tools, log_tools, simulation_tools
from .base import ToolContext, ToolFailure, ToolResult, ToolSpec

logger = logging.getLogger("sentinel_agent.tools")

REQUIRED_TOOL_NAMES = [
    "get_incident_details",
    "get_asset_status",
    "get_recent_logs",
    "get_infrastructure_dependencies",
    "get_incident_timeline",
    "search_security_events",
    "get_related_incidents",
    "calculate_blast_radius",
    "simulate_recovery_strategy",
    "get_evidence_record",
]


def _simplify(node: Any) -> Any:
    """Make a pydantic JSON schema friendlier to LLM tool-calling servers (no titles, no null-unions)."""
    if isinstance(node, dict):
        node = {
            k: _simplify(v)
            for k, v in node.items()
            if k != "title" and not (k == "default" and v is None)
        }
        any_of = node.get("anyOf")
        if isinstance(any_of, list):
            non_null = [s for s in any_of if s.get("type") != "null"]
            if len(non_null) == 1 and len(any_of) == 2:
                merged = {k: v for k, v in node.items() if k != "anyOf"}
                merged.update(non_null[0])
                return merged
        return node
    if isinstance(node, list):
        return [_simplify(v) for v in node]
    return node


def _inline_refs(schema: dict[str, Any]) -> dict[str, Any]:
    defs = schema.pop("$defs", {})

    def resolve(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                name = node["$ref"].rsplit("/", 1)[-1]
                return resolve(dict(defs[name]))
            return {k: resolve(v) for k, v in node.items()}
        if isinstance(node, list):
            return [resolve(v) for v in node]
        return node

    return resolve(schema)


def model_schema(model: type) -> dict[str, Any]:
    """JSON schema of a pydantic model, simplified for LLM tool-calling servers."""
    return _simplify(_inline_refs(model.model_json_schema()))


class ToolRegistry:
    def __init__(self, specs: list[ToolSpec]):
        self._specs: dict[str, ToolSpec] = {}
        for spec in specs:
            if spec.name in self._specs:
                raise ValueError(f"duplicate tool {spec.name}")
            if not spec.read_only:
                raise ValueError(f"tool {spec.name} is not read-only; investigation tools must be read-only")
            self._specs[spec.name] = spec

    @property
    def names(self) -> set[str]:
        return set(self._specs)

    @property
    def read_only_names(self) -> set[str]:
        return {n for n, s in self._specs.items() if s.read_only}

    def get(self, name: str) -> ToolSpec | None:
        return self._specs.get(name)

    def json_schema(self, name: str) -> dict[str, Any]:
        raw = self._specs[name].args_model.model_json_schema()
        return _simplify(_inline_refs(raw))

    def openai_tools(self) -> list[dict[str, Any]]:
        return [
            {
                "type": "function",
                "function": {"name": s.name, "description": s.description, "parameters": self.json_schema(s.name)},
            }
            for s in self._specs.values()
        ]

    def describe(self) -> list[dict[str, Any]]:
        return [
            {"name": s.name, "description": s.description, "read_only": s.read_only, "parameters": self.json_schema(s.name)}
            for s in self._specs.values()
        ]

    async def execute(self, name: str, raw_arguments: Any, ctx: ToolContext) -> ToolResult:
        """Validate and run a tool. Never raises: every failure becomes a structured ToolResult."""
        spec = self._specs.get(name)
        if spec is None:
            return ToolResult(False, name, error_code="UNKNOWN_TOOL", error_message=f"no tool named {str(name)[:60]!r}")
        # --- parse
        if isinstance(raw_arguments, (str, bytes)):
            try:
                arguments = json.loads(raw_arguments) if raw_arguments else {}
            except json.JSONDecodeError:
                return ToolResult(False, name, error_code="MALFORMED_ARGUMENTS", error_message="arguments are not valid JSON")
        else:
            arguments = raw_arguments if raw_arguments is not None else {}
        if not isinstance(arguments, dict):
            return ToolResult(False, name, error_code="MALFORMED_ARGUMENTS", error_message="arguments must be a JSON object")
        # --- validate
        try:
            args = spec.args_model.model_validate(arguments)
        except ValidationError as exc:
            problems = [
                f"{'.'.join(str(p) for p in err['loc']) or 'arguments'}: {err['msg']}" for err in exc.errors()[:6]
            ]
            return ToolResult(False, name, error_code="INVALID_ARGUMENTS", error_message="; ".join(problems)[:600])
        # --- execute (bounded)
        try:
            out = await asyncio.wait_for(spec.handler(ctx, args), timeout=ctx.settings.tool_timeout_s)
        except ToolFailure as failure:
            return ToolResult(False, name, error_code=failure.code, error_message=failure.message)
        except asyncio.TimeoutError:
            return ToolResult(False, name, error_code="TOOL_TIMEOUT", error_message="tool exceeded its time limit")
        except Exception:  # noqa: BLE001 - tool bugs must not crash the investigation
            logger.exception("tool crashed", extra={"tool": name})
            return ToolResult(False, name, error_code="INTERNAL_ERROR", error_message="tool failed unexpectedly")
        return ToolResult(
            True, name, data=out.data, evidence=out.evidence, truncated=out.truncated, summary=out.summary
        )


def build_default_registry() -> ToolRegistry:
    return ToolRegistry(
        incident_tools.TOOLS + asset_tools.TOOLS + log_tools.TOOLS + dependency_tools.TOOLS + simulation_tools.TOOLS
    )
