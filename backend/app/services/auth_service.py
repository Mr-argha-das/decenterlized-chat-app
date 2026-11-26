from datetime import datetime, timezone

from fastapi import status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import AppError
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_jwt_token,
    hash_password,
    verify_password,
)
from app.models.entities import Device, RefreshToken, User
from app.schemas.auth import AuthTokensOut, LoginRequest, SignupRequest
from app.schemas.user import DeviceOut, UserProfileOut


def _device_to_out(device: Device, is_current: bool = True) -> DeviceOut:
    out = DeviceOut.model_validate(device)
    out.is_current = is_current
    return out


async def register_user_and_device(
    db: AsyncSession,
    body: SignupRequest,
    user_agent: str | None,
    ip_addr: str,
) -> AuthTokensOut:
    settings = get_settings()
    global_id = f"{body.username}@{settings.APP_DOMAIN}"

    existing = await db.execute(
        select(User).where(
            (User.global_id == global_id)
            | ((User.username == body.username) & (User.domain == settings.APP_DOMAIN))
        )
    )
    if existing.scalar_one_or_none() is not None:
        raise AppError(
            code="USERNAME_TAKEN",
            message=f"Username '{body.username}' is already taken on {settings.APP_DOMAIN}.",
            status_code=status.HTTP_409_CONFLICT,
        )

    now = datetime.now(timezone.utc)
    user = User(
        username=body.username,
        domain=settings.APP_DOMAIN,
        global_id=global_id,
        password_hash=hash_password(body.password),
        public_key=body.public_key,
        display_name=(body.display_name or body.username).strip(),
        about=f"Hey there! I am using {settings.APP_NAME}.",
        is_local=True,
        node_url=settings.NODE_PUBLIC_URL.rstrip("/"),
        is_online=True,
        last_seen_at=now,
    )
    db.add(user)
    await db.flush()

    device = Device(
        user_id=user.id,
        name=body.device_name,
        user_agent=(user_agent or "")[:255] or None,
        ip_address=ip_addr[:64],
        last_active=now,
    )
    db.add(device)
    await db.flush()

    access_token, expires_in = create_access_token(user.id, device.id, user.global_id)
    refresh_jwt, jti, refresh_exp = create_refresh_token(user.id, device.id)

    db.add(
        RefreshToken(
            user_id=user.id,
            device_id=device.id,
            token_jti=jti,
            expires_at=refresh_exp,
        )
    )
    await db.commit()
    await db.refresh(user)
    await db.refresh(device)

    return AuthTokensOut(
        access_token=access_token,
        refresh_token=refresh_jwt,
        expires_in=expires_in,
        user=UserProfileOut.model_validate(user),
        device=_device_to_out(device, is_current=True),
    )


async def authenticate_user_and_device(
    db: AsyncSession,
    body: LoginRequest,
    user_agent: str | None,
    ip_addr: str,
) -> AuthTokensOut:
    settings = get_settings()
    res = await db.execute(
        select(User).where(
            User.username == body.username,
            User.domain == settings.APP_DOMAIN,
            User.is_local.is_(True),
        )
    )
    user = res.scalar_one_or_none()
    if not user or not verify_password(body.password, user.password_hash):
        raise AppError(
            code="INVALID_CREDENTIALS",
            message="Invalid username or password.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    now = datetime.now(timezone.utc)
    user.is_online = True
    user.last_seen_at = now

    device = Device(
        user_id=user.id,
        name=body.device_name,
        user_agent=(user_agent or "")[:255] or None,
        ip_address=ip_addr[:64],
        last_active=now,
    )
    db.add(device)
    await db.flush()

    access_token, expires_in = create_access_token(user.id, device.id, user.global_id)
    refresh_jwt, jti, refresh_exp = create_refresh_token(user.id, device.id)

    db.add(
        RefreshToken(
            user_id=user.id,
            device_id=device.id,
            token_jti=jti,
            expires_at=refresh_exp,
        )
    )
    await db.commit()
    await db.refresh(user)
    await db.refresh(device)

    return AuthTokensOut(
        access_token=access_token,
        refresh_token=refresh_jwt,
        expires_in=expires_in,
        user=UserProfileOut.model_validate(user),
        device=_device_to_out(device, is_current=True),
    )


async def rotate_refresh_token(db: AsyncSession, raw_token: str) -> AuthTokensOut:
    payload = decode_jwt_token(raw_token, expected_type="refresh")
    user_id = payload.get("sub")
    device_id = payload.get("did")
    jti = payload.get("jti")
    if not user_id or not device_id or not jti:
        raise AppError(
            code="INVALID_TOKEN",
            message="Malformed refresh token.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    dev_res = await db.execute(
        select(Device).where(Device.id == device_id, Device.user_id == user_id)
    )
    device = dev_res.scalar_one_or_none()
    if not device or device.is_revoked:
        raise AppError(
            code="DEVICE_REVOKED",
            message="Device session is no longer active.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    tok_res = await db.execute(
        select(RefreshToken).where(
            RefreshToken.token_jti == jti,
            RefreshToken.device_id == device.id,
            RefreshToken.user_id == user_id,
        )
    )
    token_row = tok_res.scalar_one_or_none()
    if not token_row or token_row.is_revoked or token_row.replaced_by_jti is not None:
        # Replay of an already-rotated or revoked refresh token -> revoke device & all its tokens!
        device.is_revoked = True
        await db.execute(
            update(RefreshToken)
            .where(RefreshToken.device_id == device.id)
            .values(is_revoked=True)
        )
        await db.commit()
        raise AppError(
            code="REFRESH_TOKEN_REUSED",
            message="Refresh token was already used; device session revoked for security.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    now = datetime.now(timezone.utc)
    exp = token_row.expires_at
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    if exp <= now:
        token_row.is_revoked = True
        await db.commit()
        raise AppError(
            code="TOKEN_EXPIRED",
            message="Refresh token has expired.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    user_res = await db.execute(select(User).where(User.id == user_id, User.is_local.is_(True)))
    user = user_res.scalar_one_or_none()
    if not user:
        raise AppError(
            code="USER_NOT_FOUND",
            message="User does not exist.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    access_token, expires_in = create_access_token(user.id, device.id, user.global_id)
    new_refresh_jwt, new_jti, new_exp = create_refresh_token(user.id, device.id)

    token_row.is_revoked = True
    token_row.replaced_by_jti = new_jti
    device.last_active = now

    db.add(
        RefreshToken(
            user_id=user.id,
            device_id=device.id,
            token_jti=new_jti,
            expires_at=new_exp,
        )
    )
    await db.commit()
    await db.refresh(user)
    await db.refresh(device)

    return AuthTokensOut(
        access_token=access_token,
        refresh_token=new_refresh_jwt,
        expires_in=expires_in,
        user=UserProfileOut.model_validate(user),
        device=_device_to_out(device, is_current=True),
    )


async def revoke_device_session(db: AsyncSession, user: User, device: Device) -> None:
    device.is_revoked = True
    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.device_id == device.id)
        .values(is_revoked=True)
    )
    user.is_online = False
    user.last_seen_at = datetime.now(timezone.utc)
    await db.commit()
