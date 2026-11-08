"""Timestamp helpers. Everything at the integration boundary is ISO 8601 UTC with a 'Z' suffix."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Any

from pydantic import AfterValidator, BeforeValidator, PlainSerializer


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def parse_utc(value: Any) -> datetime:
    """Parse an ISO 8601 string/datetime into an aware UTC datetime. Naive values are rejected."""
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str):
        text = value.strip()
        if text.endswith(("Z", "z")):
            text = text[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(text)
        except ValueError as exc:
            raise ValueError(f"not an ISO 8601 timestamp: {value[:40]!r}") from exc
    else:
        raise ValueError("timestamp must be an ISO 8601 string")
    if dt.tzinfo is None:
        raise ValueError("timestamp must include a timezone (use 'Z' for UTC)")
    return dt.astimezone(timezone.utc)


def iso_z(dt: datetime) -> str:
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + (f".{dt.microsecond // 1000:03d}" if dt.microsecond else "") + "Z"


UTCDatetime = Annotated[
    datetime,
    BeforeValidator(parse_utc),
    AfterValidator(lambda d: d.astimezone(timezone.utc)),
    PlainSerializer(iso_z, return_type=str, when_used="always"),
]
