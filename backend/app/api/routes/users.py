import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Body, Depends, File, Query, Response, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_auth, get_current_user
from app.core.config import get_settings
from app.core.errors import AppError
from app.core.rate_limit import api_rate_limit
from app.core.security import verify_password
from app.db.session import get_db_session
from app.models.entities import (
    Conversation,
    ConversationMember,
    Device,
    RefreshToken,
    User,
)
from app.schemas.contacts import PeerProfileViewOut
from app.schemas.user import (
    DeleteAccountRequest,
    DeviceOut,
    PublicKeyRotateRequest,
    UserProfileOut,
    UserProfileUpdate,
    UsernameCheckOut,
)
from app.services.chat_service import get_peer_user_ids_for_presence
from app.services.federation_hook import resolve_user_by_identifier
from app.services.privacy_service import (
    build_peer_profile_view,
    filter_presence_audience,
)
from app.services.realtime import ws_manager
from app.services.user_service import check_username_availability

router = APIRouter(tags=["users"], dependencies=[Depends(api_rate_limit())])
media_router = APIRouter(prefix="/api/v1/media", tags=["media"])

_AVATAR_SIGNATURES: list[tuple[bytes, str, str]] = [
    (b"\x89PNG\r\n\x1a\n", ".png", "image/png"),
    (b"\xff\xd8\xff", ".jpg", "image/jpeg"),
    (b"GIF87a", ".gif", "image/gif"),
    (b"GIF89a", ".gif", "image/gif"),
]


def _detect_image_ext(data: bytes) -> tuple[str, str] | None:
    for magic, ext, mime in _AVATAR_SIGNATURES:
        if data.startswith(magic):
            return ext, mime
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp", "image/webp"
    return None


@router.get("/check-username/{username}", response_model=UsernameCheckOut)
async def check_username(
    username: str,
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> UsernameCheckOut:
    return await check_username_availability(db, username)


@router.get("/me", response_model=UserProfileOut)
async def get_me(current_user: Annotated[User, Depends(get_current_user)]) -> UserProfileOut:
    return UserProfileOut.model_validate(current_user)


@router.patch("/me", response_model=UserProfileOut)
async def update_me(
    body: UserProfileUpdate,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> UserProfileOut:
    last_seen_changed = False

    if body.display_name is not None:
        current_user.display_name = body.display_name.strip()
    if body.about is not None:
        current_user.about = body.about.strip()
    if body.avatar_url is not None:
        current_user.avatar_url = body.avatar_url.strip() or None
    if body.privacy_last_seen is not None:
        last_seen_changed = current_user.privacy_last_seen != body.privacy_last_seen
        current_user.privacy_last_seen = body.privacy_last_seen
    if body.privacy_profile_photo is not None:
        current_user.privacy_profile_photo = body.privacy_profile_photo

    if body.privacy_read_receipts_visibility is not None:
        current_user.privacy_read_receipts_visibility = body.privacy_read_receipts_visibility
        current_user.privacy_read_receipts = (
            body.privacy_read_receipts_visibility != "nobody"
        )
    elif body.privacy_read_receipts is not None:
        if isinstance(body.privacy_read_receipts, bool):
            current_user.privacy_read_receipts = body.privacy_read_receipts
            current_user.privacy_read_receipts_visibility = (
                "everyone" if body.privacy_read_receipts else "nobody"
            )
        else:
            current_user.privacy_read_receipts_visibility = body.privacy_read_receipts
            current_user.privacy_read_receipts = body.privacy_read_receipts != "nobody"

    if body.notifications_enabled is not None:
        current_user.notifications_enabled = body.notifications_enabled
    if body.notification_sound is not None:
        current_user.notification_sound = body.notification_sound
    if body.chat_wallpaper is not None:
        current_user.chat_wallpaper = body.chat_wallpaper
    if body.theme is not None:
        current_user.theme = body.theme

    await db.commit()
    await db.refresh(current_user)

    # If last-seen privacy tightened, hide live online indicator from excluded peers immediately
    if last_seen_changed:
        all_peers = await get_peer_user_ids_for_presence(db, current_user.id)
        allowed_peers = await filter_presence_audience(db, current_user, all_peers)
        hidden_peers = all_peers - allowed_peers
        now_iso = datetime.now(timezone.utc).isoformat()
        if hidden_peers:
            await ws_manager.broadcast_to_users(
                hidden_peers,
                {
                    "event": "presence.offline",
                    "data": {
                        "user_id": current_user.id,
                        "global_id": current_user.global_id,
                        "is_online": False,
                        "last_seen_at": None,
                    },
                    "ts": now_iso,
                },
            )

    return UserProfileOut.model_validate(current_user)


@router.delete("/me")
async def delete_my_account(
    response: Response,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
    body: Annotated[DeleteAccountRequest | None, Body()] = None,
) -> dict[str, str]:
    if body and body.password and current_user.password_hash:
        if not verify_password(body.password, current_user.password_hash):
            raise AppError(
                "INVALID_PASSWORD",
                "Password confirmation failed.",
                status_code=status.HTTP_401_UNAUTHORIZED,
            )

    user_id = current_user.id
    global_id = current_user.global_id

    # Delete direct 1:1 conversations belonging to this user so orphaned 1-member direct chats aren't left behind
    direct_conv_ids = list(
        (
            await db.execute(
                select(Conversation.id)
                .join(
                    ConversationMember,
                    ConversationMember.conversation_id == Conversation.id,
                )
                .where(
                    ConversationMember.user_id == user_id,
                    Conversation.type == "direct",
                )
            )
        )
        .scalars()
        .all()
    )
    if direct_conv_ids:
        await db.execute(
            delete(Conversation).where(Conversation.id.in_(direct_conv_ids))
        )

    await db.delete(current_user)
    await db.commit()

    await ws_manager.close_all_user_sockets(user_id)
    response.delete_cookie("relaychat_access", path="/")
    response.delete_cookie("relaychat_refresh", path="/")
    return {"status": "deleted", "global_id": global_id}


@router.put("/me/public-key", response_model=UserProfileOut)
async def update_public_key(
    body: PublicKeyRotateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> UserProfileOut:
    current_user.public_key = body.public_key
    await db.commit()
    await db.refresh(current_user)
    return UserProfileOut.model_validate(current_user)


@router.post("/me/avatar", response_model=UserProfileOut)
async def upload_avatar(
    file: Annotated[UploadFile, File(...)],
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> UserProfileOut:
    settings = get_settings()
    raw = await file.read(settings.MAX_AVATAR_BYTES + 1)
    if not raw:
        raise AppError("EMPTY_FILE", "Uploaded avatar file is empty.")
    if len(raw) > settings.MAX_AVATAR_BYTES:
        raise AppError(
            "FILE_TOO_LARGE",
            f"Avatar must not exceed {settings.MAX_AVATAR_BYTES // (1024 * 1024)} MB.",
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
        )
    detected = _detect_image_ext(raw)
    if not detected:
        raise AppError(
            "UNSUPPORTED_IMAGE",
            "Avatar must be a valid PNG, JPEG, WEBP, or GIF image.",
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        )
    ext, _ = detected
    avatars_dir = settings.storage_path / "avatars"
    avatars_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{current_user.id}_{uuid.uuid4().hex[:12]}{ext}"
    (avatars_dir / filename).write_bytes(raw)

    current_user.avatar_url = f"/api/v1/media/avatars/{filename}"
    await db.commit()
    await db.refresh(current_user)
    return UserProfileOut.model_validate(current_user)


@media_router.get("/avatars/{filename}")
async def serve_avatar(filename: str) -> FileResponse:
    safe_name = Path(filename).name
    if safe_name != filename or ".." in filename:
        raise AppError("INVALID_FILENAME", "Invalid avatar path.", status_code=400)
    path = get_settings().storage_path / "avatars" / safe_name
    if not path.is_file():
        raise AppError("NOT_FOUND", "Avatar not found.", status_code=404)
    return FileResponse(path)


@router.get("/me/devices", response_model=list[DeviceOut])
async def list_my_devices(
    auth: Annotated[tuple[User, Device], Depends(get_current_auth)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> list[DeviceOut]:
    user, current_device = auth
    res = await db.execute(
        select(Device)
        .where(Device.user_id == user.id, Device.is_revoked.is_(False))
        .order_by(Device.last_active.desc())
    )
    devices = res.scalars().all()
    output: list[DeviceOut] = []
    for dev in devices:
        d_out = DeviceOut.model_validate(dev)
        d_out.is_current = dev.id == current_device.id
        output.append(d_out)
    return output


@router.delete("/me/devices/{device_id}")
async def unlink_device(
    device_id: str,
    auth: Annotated[tuple[User, Device], Depends(get_current_auth)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> dict[str, str]:
    user, current_device = auth
    if device_id == current_device.id:
        raise AppError(
            "CANNOT_UNLINK_CURRENT_DEVICE",
            "Use logout to end the session on your current device.",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    res = await db.execute(
        select(Device).where(Device.id == device_id, Device.user_id == user.id)
    )
    target = res.scalar_one_or_none()
    if not target:
        raise AppError("DEVICE_NOT_FOUND", "Device not found.", status_code=404)

    target.is_revoked = True
    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.device_id == target.id)
        .values(is_revoked=True)
    )
    await db.commit()
    await ws_manager.close_device_sockets(user.id, {target.id})
    return {"status": "unlinked", "device_id": device_id}


@router.delete("/me/devices")
async def logout_all_other_devices(
    auth: Annotated[tuple[User, Device], Depends(get_current_auth)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> dict[str, int]:
    user, current_device = auth
    res = await db.execute(
        select(Device).where(
            Device.user_id == user.id,
            Device.id != current_device.id,
            Device.is_revoked.is_(False),
        )
    )
    other_devices = list(res.scalars().all())
    revoked_ids = {d.id for d in other_devices}
    for dev in other_devices:
        dev.is_revoked = True

    if revoked_ids:
        await db.execute(
            update(RefreshToken)
            .where(RefreshToken.device_id.in_(revoked_ids))
            .values(is_revoked=True)
        )
        await db.commit()
        await ws_manager.close_device_sockets(user.id, revoked_ids)

    return {"revoked_count": len(revoked_ids)}


@router.get("/profile/{identifier:path}", response_model=PeerProfileViewOut)
async def get_peer_profile(
    identifier: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> PeerProfileViewOut:
    # Support lookup by UUID `id` OR `username@domain` / `username`
    by_id = (
        await db.execute(select(User).where(User.id == identifier.strip()))
    ).scalar_one_or_none()
    target = by_id or await resolve_user_by_identifier(db, identifier)
    return await build_peer_profile_view(db, target, current_user)


@router.get("/search", response_model=list[PeerProfileViewOut])
async def search_users(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
    q: Annotated[str, Query(max_length=100)] = "",
) -> list[PeerProfileViewOut]:
    cleaned = q.strip().lower()
    stmt = select(User).where(User.id != current_user.id)
    if cleaned:
        pattern = f"%{cleaned}%"
        stmt = stmt.where(
            or_(
                User.username.ilike(pattern),
                User.display_name.ilike(pattern),
                User.global_id.ilike(pattern),
            )
        )
    stmt = stmt.order_by(User.display_name.asc()).limit(25)
    users = list((await db.execute(stmt)).scalars().all())
    out: list[PeerProfileViewOut] = []
    for u in users:
        out.append(await build_peer_profile_view(db, u, current_user))
    return out
