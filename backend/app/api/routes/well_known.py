from typing import Annotated

from fastapi import APIRouter, Depends, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import AppError
from app.core.rate_limit import api_rate_limit
from app.core.security import get_node_public_key_b64
from app.db.session import get_db_session
from app.models.entities import User
from app.schemas.user import (
    WellKnownNodeInfoOut,
    WellKnownNodeKeyOut,
    WellKnownUserOut,
)

router = APIRouter(prefix="/.well-known", tags=["federation-discovery"])


def _resolve_node_url(request: Request) -> str:
    settings = get_settings()
    if settings.NODE_PUBLIC_URL and settings.NODE_PUBLIC_URL != "http://localhost:8000":
        return settings.NODE_PUBLIC_URL.rstrip("/")
    base = str(request.base_url).rstrip("/")
    return base or settings.NODE_PUBLIC_URL.rstrip("/")


@router.get(
    "/user/{username}",
    response_model=WellKnownUserOut,
    dependencies=[Depends(api_rate_limit())],
)
async def discover_user(
    username: str,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> WellKnownUserOut:
    settings = get_settings()
    normalized = username.strip().lower()
    res = await db.execute(
        select(User).where(
            User.username == normalized,
            User.domain == settings.APP_DOMAIN,
            User.is_local.is_(True),
        )
    )
    user = res.scalar_one_or_none()
    if not user:
        raise AppError(
            code="USER_NOT_FOUND",
            message=f"Local user '{normalized}@{settings.APP_DOMAIN}' was not found on this node.",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    node_url = _resolve_node_url(request)
    avatar_url: str | None = None
    if user.avatar_url and user.privacy_profile_photo == "everyone":
        avatar_url = (
            user.avatar_url
            if user.avatar_url.startswith(("http://", "https://"))
            else f"{node_url}{user.avatar_url}"
        )

    return WellKnownUserOut(
        id=user.global_id,
        user_uuid=user.id,
        username=user.username,
        domain=user.domain,
        global_id=user.global_id,
        display_name=user.display_name,
        about=user.about,
        avatar_url=avatar_url,
        public_key=user.public_key,
        node=node_url,
        node_url=node_url,
        federation_inbox_url=f"{node_url}/federation/inbox",
    )


@router.get(
    "/node-key",
    response_model=WellKnownNodeKeyOut,
    dependencies=[Depends(api_rate_limit())],
)
async def get_node_key(request: Request) -> WellKnownNodeKeyOut:
    settings = get_settings()
    node_url = _resolve_node_url(request)
    return WellKnownNodeKeyOut(
        app_name=settings.APP_NAME,
        domain=settings.APP_DOMAIN,
        node_url=node_url,
        algorithm="Ed25519",
        public_key=get_node_public_key_b64(),
        federation_inbox_url=f"{node_url}/federation/inbox",
    )


@router.get(
    "/node-info",
    response_model=WellKnownNodeInfoOut,
    dependencies=[Depends(api_rate_limit())],
)
async def get_node_info(request: Request) -> WellKnownNodeInfoOut:
    settings = get_settings()
    node_url = _resolve_node_url(request)
    pub_key = get_node_public_key_b64()
    return WellKnownNodeInfoOut(
        app_name=settings.APP_NAME,
        domain=settings.APP_DOMAIN,
        node_url=node_url,
        algorithm="Ed25519",
        public_key=pub_key,
        public_key_ed25519=pub_key,
        federation_enabled=settings.FEDERATION_ENABLED,
        federation_inbox_url=f"{node_url}/federation/inbox",
        federation_media_url=f"{node_url}/federation/attachments",
    )
