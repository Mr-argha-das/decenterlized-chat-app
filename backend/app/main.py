import asyncio
import logging
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import AsyncIterator

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from sqlalchemy import func, select

import app.models  # noqa: F401
from app.api.routes import (
    attachments,
    auth,
    chat,
    contacts,
    federation,
    groups,
    push,
    statuses,
    users,
    well_known,
    ws,
)
from app.core.config import get_settings
from app.core.errors import register_exception_handlers
from app.core.logging import configure_logging
from app.core.metrics import metrics_registry
from app.core.security import get_node_public_key_b64
from app.core.security_headers import apply_security_headers
from app.db.base import Base
from app.db.session import AsyncSessionLocal, engine
from app.models.entities import (
    FederationOutbox,
    PushSubscription,
    StatusPost,
    User,
)
from app.services.federation_service import outbox_worker_loop
from app.services.push_service import get_or_create_vapid_keys
from app.services.realtime import ws_manager
from app.services.status_service import expiry_cleanup_worker_loop

configure_logging()
logger = logging.getLogger("relaychat.api")


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    pub_key = get_node_public_key_b64()
    vapid_pub, _ = get_or_create_vapid_keys()
    logger.info(
        "Node '%s' (%s) initialized with Ed25519 key %s... | VAPID %s...",
        settings.APP_NAME,
        settings.APP_DOMAIN,
        pub_key[:16],
        vapid_pub[:16],
    )
    stop_event = asyncio.Event()
    outbox_task = asyncio.create_task(outbox_worker_loop(stop_event))
    cleanup_task = asyncio.create_task(expiry_cleanup_worker_loop(stop_event))
    try:
        yield
    finally:
        stop_event.set()
        for task in (outbox_task, cleanup_task):
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=f"{settings.APP_NAME} Federated E2EE API",
        description=(
            f"Decentralized end-to-end encrypted messaging server for node `{settings.APP_DOMAIN}`. "
            "Plaintext messages and private keys never touch this server."
        ),
        version="1.0.0",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_origin_regex=r"^https://.*\.e2b\.app$",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def request_observability_and_security_middleware(
        request: Request, call_next
    ) -> Response:  # type: ignore[no-untyped-def]
        req_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
        start = time.perf_counter()
        response: Response = await call_next(request)
        duration_sec = time.perf_counter() - start
        duration_ms = round(duration_sec * 1000, 2)

        response.headers["X-Request-ID"] = req_id
        rl_headers = getattr(request.state, "rate_limit_headers", None)
        if isinstance(rl_headers, dict):
            for k, v in rl_headers.items():
                response.headers.setdefault(k, v)

        apply_security_headers(request, response)
        metrics_registry.observe_http_request(
            request.method, request.url.path, response.status_code, duration_sec
        )

        logger.info(
            "%s %s -> %s (%.2fms)",
            request.method,
            request.url.path,
            response.status_code,
            duration_ms,
            extra={
                "request_id": req_id,
                "method": request.method,
                "path": request.url.path,
                "status_code": response.status_code,
                "duration_ms": duration_ms,
            },
        )
        return response

    register_exception_handlers(app)

    # Primary routes per spec
    app.include_router(well_known.router)
    app.include_router(federation.router)
    app.include_router(auth.router, prefix="/auth")
    app.include_router(users.router, prefix="/users")
    app.include_router(contacts.router)
    app.include_router(attachments.router)
    app.include_router(groups.router)
    app.include_router(statuses.router)
    app.include_router(push.router)
    app.include_router(chat.router)
    app.include_router(ws.router)

    # Versioned aliases (/api/v1/*)
    app.include_router(auth.router, prefix="/api/v1/auth", include_in_schema=False)
    app.include_router(users.router, prefix="/api/v1/users", include_in_schema=False)
    app.include_router(contacts.router, prefix="/api/v1", include_in_schema=False)
    app.include_router(attachments.router, prefix="/api/v1", include_in_schema=False)
    app.include_router(groups.router, prefix="/api/v1", include_in_schema=False)
    app.include_router(statuses.router, prefix="/api/v1", include_in_schema=False)
    app.include_router(push.router, prefix="/api/v1", include_in_schema=False)
    app.include_router(federation.router, prefix="/api/v1", include_in_schema=False)
    app.include_router(chat.router, prefix="/api/v1", include_in_schema=False)
    app.include_router(users.media_router)

    @app.get("/health", tags=["system"])
    @app.get("/api/v1/health", include_in_schema=False)
    async def health() -> dict[str, str]:
        return {
            "status": "ok",
            "app_name": settings.APP_NAME,
            "domain": settings.APP_DOMAIN,
        }

    @app.get("/api/v1/node-info", tags=["system"])
    async def node_info() -> dict[str, str]:
        return {
            "app_name": settings.APP_NAME,
            "domain": settings.APP_DOMAIN,
            "node_public_key_ed25519": get_node_public_key_b64(),
            "protocol_version": "1.0",
        }

    @app.get(
        "/metrics",
        tags=["observability"],
        response_class=PlainTextResponse,
    )
    async def prometheus_metrics() -> PlainTextResponse:
        now = datetime.now(timezone.utc)
        ws_users = len(ws_manager._connections)
        ws_sockets = sum(len(v) for v in ws_manager._connections.values())
        extra_gauges: dict[str, float] = {
            "active_ws_users": float(ws_users),
            "active_ws_connections": float(ws_sockets),
        }
        try:
            async with AsyncSessionLocal() as db:
                local_users = (
                    await db.execute(
                        select(func.count()).select_from(User).where(User.is_local.is_(True))
                    )
                ).scalar_one()
                active_statuses = (
                    await db.execute(
                        select(func.count())
                        .select_from(StatusPost)
                        .where(StatusPost.expires_at > now)
                    )
                ).scalar_one()
                push_subs = (
                    await db.execute(select(func.count()).select_from(PushSubscription))
                ).scalar_one()
                outbox_pending = (
                    await db.execute(
                        select(func.count())
                        .select_from(FederationOutbox)
                        .where(FederationOutbox.status == "pending")
                    )
                ).scalar_one()
                outbox_dlq = (
                    await db.execute(
                        select(func.count())
                        .select_from(FederationOutbox)
                        .where(FederationOutbox.status == "dead_letter")
                    )
                ).scalar_one()
                extra_gauges.update(
                    {
                        "local_users_count": float(local_users),
                        "active_statuses_count": float(active_statuses),
                        "push_subscriptions_count": float(push_subs),
                        "federation_outbox_pending": float(outbox_pending),
                        "federation_outbox_dead_letters": float(outbox_dlq),
                    }
                )
        except Exception:
            pass

        body = metrics_registry.render_prometheus(extra_gauges=extra_gauges)
        return PlainTextResponse(
            content=body,
            media_type="text/plain; version=0.0.4; charset=utf-8",
        )

    return app


app = create_app()
