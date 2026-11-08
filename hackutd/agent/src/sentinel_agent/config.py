"""Environment-driven configuration with explicit validation. Secrets never appear in repr()."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any

DEFAULT_MODEL_ID = "nvidia/nemotron-3-ultra-550b-a55b"
DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1"


class ConfigError(ValueError):
    """Raised when configuration is missing or invalid."""


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _num(name: str, default: float, *, lo: float, hi: float, integer: bool = False) -> float:
    raw = _env(name)
    if raw == "":
        return int(default) if integer else default
    try:
        value = int(raw) if integer else float(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be a {'integer' if integer else 'number'}, got {raw!r}") from exc
    if not lo <= value <= hi:
        raise ConfigError(f"{name} must be between {lo} and {hi}, got {value}")
    return value


def _bool(name: str, default: bool = False) -> bool:
    raw = _env(name).lower()
    if raw == "":
        return default
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    raise ConfigError(f"{name} must be a boolean, got {raw!r}")


@dataclass(frozen=True)
class Settings:
    nvidia_api_key: str = field(default="", repr=False)
    nvidia_base_url: str = DEFAULT_BASE_URL
    model_id: str = DEFAULT_MODEL_ID
    nvidia_extra_body: dict[str, Any] = field(default_factory=dict)
    temperature: float = 0.2
    max_tokens: int = 2048
    request_timeout_s: float = 60.0
    max_retries: int = 3
    retry_backoff_s: float = 1.5

    max_tool_calls: int = 12
    max_model_turns: int = 30
    max_investigation_seconds: float = 300.0
    tool_timeout_s: float = 10.0
    max_log_results: int = 50
    min_investigation_tool_calls: int = 3
    min_simulated_strategies: int = 2
    max_submission_repairs: int = 3
    max_concurrent_investigations: int = 2
    max_queued_investigations: int = 20

    data_provider: str = "fixture"
    service_token: str = field(default="", repr=False)
    demo_mode: bool = False
    cors_origins: tuple[str, ...] = ()
    log_level: str = "INFO"

    @classmethod
    def from_env(cls) -> "Settings":
        extra_raw = _env("NVIDIA_EXTRA_BODY")
        extra: dict[str, Any] = {}
        if extra_raw:
            try:
                extra = json.loads(extra_raw)
            except json.JSONDecodeError as exc:
                raise ConfigError("NVIDIA_EXTRA_BODY must be a JSON object") from exc
            if not isinstance(extra, dict):
                raise ConfigError("NVIDIA_EXTRA_BODY must be a JSON object")
            for reserved in ("model", "messages", "tools", "tool_choice", "stream"):
                if reserved in extra:
                    raise ConfigError(f"NVIDIA_EXTRA_BODY may not override {reserved!r}")
        origins = tuple(o.strip() for o in _env("AGENT_CORS_ORIGINS").split(",") if o.strip())
        settings = cls(
            nvidia_api_key=_env("NVIDIA_API_KEY"),
            nvidia_base_url=_env("NVIDIA_BASE_URL", DEFAULT_BASE_URL).rstrip("/"),
            model_id=_env("NVIDIA_MODEL_ID", DEFAULT_MODEL_ID),
            nvidia_extra_body=extra,
            temperature=_num("NVIDIA_TEMPERATURE", 0.2, lo=0.0, hi=2.0),
            max_tokens=int(_num("NVIDIA_MAX_TOKENS", 2048, lo=64, hi=32768, integer=True)),
            request_timeout_s=_num("NVIDIA_REQUEST_TIMEOUT_S", 60, lo=1, hi=600),
            max_retries=int(_num("NVIDIA_MAX_RETRIES", 3, lo=0, hi=8, integer=True)),
            retry_backoff_s=_num("NVIDIA_RETRY_BACKOFF_S", 1.5, lo=0.0, hi=30),
            max_tool_calls=int(_num("AGENT_MAX_TOOL_CALLS", 12, lo=1, hi=50, integer=True)),
            max_model_turns=int(_num("AGENT_MAX_MODEL_TURNS", 30, lo=2, hi=100, integer=True)),
            max_investigation_seconds=_num("AGENT_MAX_INVESTIGATION_SECONDS", 300, lo=1, hi=3600),
            tool_timeout_s=_num("AGENT_TOOL_TIMEOUT_S", 10, lo=0.1, hi=120),
            max_log_results=int(_num("AGENT_MAX_LOG_RESULTS", 50, lo=1, hi=500, integer=True)),
            max_concurrent_investigations=int(
                _num("AGENT_MAX_CONCURRENT_INVESTIGATIONS", 2, lo=1, hi=16, integer=True)
            ),
            max_queued_investigations=int(
                _num("AGENT_MAX_QUEUED_INVESTIGATIONS", 20, lo=0, hi=500, integer=True)
            ),
            data_provider=_env("AGENT_DATA_PROVIDER", "fixture").lower(),
            service_token=_env("AGENT_SERVICE_TOKEN"),
            demo_mode=_bool("AGENT_DEMO_MODE", False),
            cors_origins=origins,
            log_level=_env("LOG_LEVEL", "INFO").upper(),
        )
        settings.validate()
        return settings

    def validate(self) -> None:
        if not self.nvidia_base_url.startswith(("https://", "http://localhost", "http://127.0.0.1")):
            raise ConfigError("NVIDIA_BASE_URL must be https (http allowed only for localhost)")
        if not self.model_id:
            raise ConfigError("NVIDIA_MODEL_ID must not be empty")
        if self.data_provider not in {"fixture", "live"}:
            raise ConfigError("AGENT_DATA_PROVIDER must be 'fixture' or 'live'")
        if "*" in self.cors_origins:
            raise ConfigError("AGENT_CORS_ORIGINS must list explicit origins, not '*'")
        if self.min_simulated_strategies < 1 or self.min_investigation_tool_calls > self.max_tool_calls:
            raise ConfigError("min tool/simulation requirements are inconsistent with AGENT_MAX_TOOL_CALLS")

    @property
    def nvidia_configured(self) -> bool:
        return bool(self.nvidia_api_key)
