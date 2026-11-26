import logging
import time
import uuid
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

import app.models  # noqa: F401
from app.api.routes import auth, chat, contacts, users, well_known, ws
from app.core.config import get_settings
from app.core.errors import register_exception_handlers
from app.core.logging import configure_logging
from app.core.security import get_node_public_key_b64
from app.db.base import Base
from app.db.session import engine

configure_logging()
logger = logging.getLogger("relaychat.api")


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    pub_key = get_node_public_key_b64()
    logger.info(
        "Node '%s' (%s) initialized with Ed25519 key %s...",
        settings.APP_NAME,
        settings.APP_DOMAIN,
        pub_key[:16],
    )
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=f"{settings.APP_NAME} Federated E2EE API",
        description=(
            f"Decentralized end-to-end encrypted messaging server for node `{settings.APP_DOMAIN}`. "
            "Plaintext messages and private keys never touch this server."
        ),
        version="0.1.0",
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
    async def request_logging_middleware(request: Request, call_next) -> Response:  # type: ignore[no-untyped-def]
        req_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
        start = time.perf_counter()
        response: Response = await call_next(request)
        duration_ms = round((time.perf_counter() - start) * 1000, 2)
        response.headers["X-Request-ID"] = req_id
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

    # Primary routes per spec (/auth/*, /users/*, /conversations/*, /messages/*, /ws, /.well-known/*)
    app.include_router(well_known.router)
    app.include_router(auth.router, prefix="/auth")
    app.include_router(users.router, prefix="/users")
    app.include_router(contacts.router)
    app.include_router(chat.router)
    app.include_router(ws.router)

    # Versioned aliases (/api/v1/*)
    app.include_router(auth.router, prefix="/api/v1/auth", include_in_schema=False)
    app.include_router(users.router, prefix="/api/v1/users", include_in_schema=False)
    app.include_router(contacts.router, prefix="/api/v1", include_in_schema=False)
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

    return app


app = create_app()
