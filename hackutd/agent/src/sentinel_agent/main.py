"""Application factory. Run with: uvicorn sentinel_agent.main:create_app --factory"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .api.routes import ApiError, router
from .config import Settings
from .integrations.data_provider import DataProvider
from .integrations.fixture_provider import FixtureProvider
from .integrations.spacetime_adapter_contract import LiveProvider
from .llm.nvidia_client import LLMClient, NvidiaClient
from .logging_utils import setup_logging
from .orchestration.investigator import Investigator
from .orchestration.manager import InvestigationManager
from .security.approvals import ApprovalService
from .security.audit import AuditLog
from .tools.registry import ToolRegistry, build_default_registry

logger = logging.getLogger("sentinel_agent")


def _error(status_code: int, code: str, message: str, details=None, headers=None) -> JSONResponse:
    body = {"error": {"code": code, "message": message}}
    if details is not None:
        body["error"]["details"] = details
    return JSONResponse(status_code=status_code, content=body, headers=headers)


def create_app(
    settings: Settings | None = None,
    llm: LLMClient | None = None,
    provider: DataProvider | None = None,
    registry: ToolRegistry | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    setup_logging(settings.log_level)
    owns_llm = False
    if llm is None and settings.nvidia_configured:
        llm, owns_llm = NvidiaClient(settings), True
    if provider is None:
        provider = FixtureProvider() if settings.data_provider == "fixture" else LiveProvider("", settings.service_token)
    registry = registry or build_default_registry()
    audit = AuditLog()
    approvals = ApprovalService(audit)
    investigator = Investigator(provider, llm, registry, settings, audit, approvals) if llm is not None else None
    manager = InvestigationManager(investigator, settings, approvals, provider)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        await manager.shutdown()
        if owns_llm and hasattr(llm, "aclose"):
            await llm.aclose()  # type: ignore[union-attr]

    app = FastAPI(title="SentinelOS X Investigation Agent", version="0.1.0", lifespan=lifespan)
    app.state.settings, app.state.llm, app.state.provider = settings, llm, provider
    app.state.registry, app.state.audit, app.state.manager = registry, audit, manager

    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware, allow_origins=list(settings.cors_origins), allow_methods=["GET", "POST"],
            allow_headers=["Content-Type"], allow_credentials=False,
        )

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError):
        return _error(exc.status_code, exc.code, exc.message, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        details = [{"loc": [str(p) for p in e["loc"]], "msg": e["msg"]} for e in exc.errors()[:10]]
        return _error(422, "VALIDATION_ERROR", "request validation failed", details)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException):
        return _error(exc.status_code, f"HTTP_{exc.status_code}", str(exc.detail))

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception):
        logger.exception("unhandled error")
        return _error(500, "INTERNAL_ERROR", "unexpected internal error")

    app.include_router(router)
    return app
