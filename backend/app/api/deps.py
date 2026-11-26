from datetime import datetime, timezone
from typing import Annotated

from fastapi import Cookie, Depends, Header, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.security import decode_jwt_token
from app.db.session import get_db_session
from app.models.entities import Device, User

bearer_scheme = HTTPBearer(auto_error=False)


async def verify_access_token_and_load_auth(
    raw_token: str,
    db: AsyncSession,
    touch_device: bool = True,
) -> tuple[User, Device]:
    payload = decode_jwt_token(raw_token, expected_type="access")
    user_id = payload.get("sub")
    device_id = payload.get("did")
    if not user_id or not device_id:
        raise AppError(
            code="INVALID_TOKEN",
            message="Malformed token claims.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    user_res = await db.execute(select(User).where(User.id == user_id, User.is_local.is_(True)))
    user = user_res.scalar_one_or_none()
    if not user:
        raise AppError(
            code="USER_NOT_FOUND",
            message="Authenticated user no longer exists.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    dev_res = await db.execute(
        select(Device).where(Device.id == device_id, Device.user_id == user.id)
    )
    device = dev_res.scalar_one_or_none()
    if not device or device.is_revoked:
        raise AppError(
            code="DEVICE_REVOKED",
            message="This device session has been logged out or unlinked.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    if touch_device:
        device.last_active = datetime.now(timezone.utc)
        await db.commit()
    return user, device


async def get_current_auth(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
    x_relaychat_token: Annotated[str | None, Header(alias="X-RelayChat-Token")] = None,
    access_cookie: Annotated[str | None, Cookie(alias="relaychat_access")] = None,
) -> tuple[User, Device]:
    raw_token: str | None = None
    if credentials and credentials.scheme.lower() == "bearer":
        raw_token = credentials.credentials
    elif x_relaychat_token:
        raw_token = x_relaychat_token.strip()
    elif access_cookie:
        raw_token = access_cookie

    if not raw_token:
        raise AppError(
            code="NOT_AUTHENTICATED",
            message="Missing authentication token.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    return await verify_access_token_and_load_auth(raw_token, db, touch_device=True)


async def get_current_user(
    auth: Annotated[tuple[User, Device], Depends(get_current_auth)],
) -> User:
    return auth[0]
