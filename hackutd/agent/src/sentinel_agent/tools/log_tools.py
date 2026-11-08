"""Log and event retrieval tools. Results are bounded and every record carries provenance."""

from __future__ import annotations

from datetime import datetime

from pydantic import Field, model_validator

from ..models import ASSET_ID_PATTERN
from ..timeutil import UTCDatetime, iso_z
from .base import ToolArgs, ToolContext, ToolFailure, ToolOutput, ToolSpec

DEFAULT_LOG_LIMIT = 20
MAX_SEARCH_RESULTS = 25


class TimeRange(ToolArgs):
    start: UTCDatetime | None = Field(default=None, description="ISO 8601 UTC, e.g. 2026-11-07T14:00:00Z")
    end: UTCDatetime | None = None

    @model_validator(mode="after")
    def _ordered(self):
        if self.start and self.end and self.start > self.end:
            raise ValueError("start must not be after end")
        return self


class GetRecentLogsArgs(ToolArgs):
    asset_id: str = Field(pattern=ASSET_ID_PATTERN)
    limit: int = Field(default=DEFAULT_LOG_LIMIT, ge=1, le=500, description="Max records (capped by server limit)")
    start_time: UTCDatetime | None = Field(default=None, description="ISO 8601 UTC; defaults to the incident window start")
    end_time: UTCDatetime | None = Field(default=None, description="ISO 8601 UTC; defaults to the incident window end")

    @model_validator(mode="after")
    def _ordered(self):
        if self.start_time and self.end_time and self.start_time > self.end_time:
            raise ValueError("start_time must not be after end_time")
        return self


class SearchEventsArgs(ToolArgs):
    query: str = Field(min_length=2, max_length=200, description="Keywords; records matching more terms rank first")
    asset_ids: list[str] | None = Field(default=None, max_length=8, description="Optional asset ids to restrict the search")
    time_range: TimeRange | None = Field(default=None, description="Defaults to the incident window; widen it explicitly")

    @model_validator(mode="after")
    def _assets(self):
        import re

        for a in self.asset_ids or []:
            if not re.fullmatch(ASSET_ID_PATTERN, a):
                raise ValueError("asset_ids contains an invalid asset id")
        return self


def _rng(start: datetime | None, end: datetime | None, ctx: ToolContext) -> tuple[datetime, datetime]:
    return start or ctx.incident.window_start, end or ctx.incident.window_end


async def get_recent_logs(ctx: ToolContext, args: GetRecentLogsArgs) -> ToolOutput:
    if not ctx.graph.has_asset(args.asset_id):
        raise ToolFailure("ASSET_NOT_FOUND", f"unknown asset {args.asset_id}")
    limit = min(args.limit, ctx.settings.max_log_results)
    start, end = _rng(args.start_time, args.end_time, ctx)
    rows = await ctx.provider.get_logs(args.asset_id, start, end, limit + 1)
    truncated = len(rows) > limit
    rows = rows[-limit:] if truncated else rows  # keep the most recent `limit`
    data = {
        "asset_id": args.asset_id,
        "time_range": {"start": iso_z(start), "end": iso_z(end)},
        "returned": len(rows),
        "applied_limit": limit,
        "order": "chronological",
    }
    return ToolOutput(data=data, evidence=rows, truncated=truncated, summary=f"{len(rows)} log records for {args.asset_id}")


async def search_security_events(ctx: ToolContext, args: SearchEventsArgs) -> ToolOutput:
    for a in args.asset_ids or []:
        if not ctx.graph.has_asset(a):
            raise ToolFailure("ASSET_NOT_FOUND", f"unknown asset {a}")
    tr = args.time_range or TimeRange()
    start, end = _rng(tr.start, tr.end, ctx)
    limit = min(MAX_SEARCH_RESULTS, ctx.settings.max_log_results)
    rows = await ctx.provider.search_events(args.query, args.asset_ids, start, end, limit + 1)
    truncated = len(rows) > limit
    rows = rows[:limit]
    data = {
        "query": args.query,
        "asset_ids": args.asset_ids,
        "time_range": {"start": iso_z(start), "end": iso_z(end)},
        "returned": len(rows),
        "applied_limit": limit,
        "order": "relevance",
    }
    return ToolOutput(data=data, evidence=rows, truncated=truncated, summary=f"{len(rows)} events matched")


TOOLS = [
    ToolSpec("get_recent_logs", "Get the most recent log events for one asset within a time range (defaults to the incident window). Bounded; returns evidence records with ids.", GetRecentLogsArgs, get_recent_logs),
    ToolSpec("search_security_events", "Keyword search of security events across assets and time (defaults to the incident window). Widen time_range to find earlier precursors.", SearchEventsArgs, search_security_events),
]
