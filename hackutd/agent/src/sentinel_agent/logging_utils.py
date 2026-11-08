"""Structured JSON logging. Messages and extras are passed through credential redaction."""

from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone

from .security.audit import redact

_RESERVED = set(logging.LogRecord("", 0, "", 0, "", (), None).__dict__) | {"message", "asctime"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.fromtimestamp(record.created, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
            "level": record.levelname,
            "logger": record.name,
            "message": redact(record.getMessage()),
        }
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["exc_type"] = record.exc_info[0].__name__ if record.exc_info[0] else None
        return redact(json.dumps(payload, default=str))


def setup_logging(level: str = "INFO") -> None:
    root = logging.getLogger()
    if any(getattr(h, "_sentinel", False) for h in root.handlers):
        root.setLevel(level)
        return
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(JsonFormatter())
    handler._sentinel = True  # type: ignore[attr-defined]
    root.addHandler(handler)
    root.setLevel(level)
    logging.getLogger("httpx").setLevel(logging.WARNING)  # httpx logs full URLs; keep it quiet
