"""Application-code permission enforcement for tool calls. Prompts are never the only control."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# Names a model might try to invoke (or that an injected log might ask for). None of these exist and none may ever be added
# to the read-only registry; they are listed so denials can be reported with a precise reason.
KNOWN_FORBIDDEN_CAPABILITIES = {
    "execute_shell", "run_command", "bash", "shell", "exec", "eval", "read_file", "write_file", "delete_file",
    "http_request", "fetch_url", "send_email", "approve_proposal", "approve", "execute_recovery",
    "restart_service", "isolate_asset", "restore_backup", "get_credentials", "get_secret",
}

# Argument fields that carry an incident id; the investigation is bound to exactly one incident.
INCIDENT_ARG_FIELDS = ("incident_id",)


@dataclass(frozen=True)
class PolicyDecision:
    allowed: bool
    code: str = "ALLOWED"
    reason: str = ""


class ToolPolicy:
    def __init__(self, allowed_tools: set[str], bound_incident_id: str, read_only_tools: set[str]):
        self.allowed_tools = frozenset(allowed_tools)
        self.bound_incident_id = bound_incident_id
        self.read_only_tools = frozenset(read_only_tools)

    def authorize(self, tool_name: Any, arguments: Any) -> PolicyDecision:
        if not isinstance(tool_name, str) or not tool_name:
            return PolicyDecision(False, "TOOL_NAME_INVALID", "tool name missing or not a string")
        if tool_name not in self.allowed_tools:
            hint = " (a forbidden capability: the agent has no such tool)" if tool_name in KNOWN_FORBIDDEN_CAPABILITIES else ""
            return PolicyDecision(False, "TOOL_NOT_ALLOWED", f"tool {tool_name[:60]!r} is not on the allowlist{hint}")
        if tool_name not in self.read_only_tools:
            return PolicyDecision(False, "TOOL_NOT_READ_ONLY", f"tool {tool_name!r} is not read-only and investigations are read-only")
        if isinstance(arguments, dict):
            for field_name in INCIDENT_ARG_FIELDS:
                value = arguments.get(field_name)
                if value is not None and value != self.bound_incident_id:
                    return PolicyDecision(
                        False,
                        "CROSS_INCIDENT_ACCESS",
                        f"this investigation is bound to {self.bound_incident_id}; access to another incident is denied",
                    )
        return PolicyDecision(True)
