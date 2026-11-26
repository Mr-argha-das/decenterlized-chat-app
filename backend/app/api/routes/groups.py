import uuid
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, File, Query, UploadFile, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.api.routes.users import _detect_image_ext
from app.core.config import get_settings
from app.core.errors import AppError
from app.core.rate_limit import api_rate_limit
from app.db.session import get_db_session
from app.models.entities import User
from app.schemas.groups import (
    DistributeSenderKeysRequest,
    GroupAddMembersRequest,
    GroupCreateRequest,
    GroupDetailOut,
    GroupInviteOut,
    GroupInvitePreviewOut,
    GroupMemberRoleUpdateRequest,
    GroupSenderKeyOut,
    GroupUpdateRequest,
)
from app.services.group_service import (
    add_group_members,
    create_group,
    distribute_sender_keys,
    get_group_detail,
    get_group_invite_info,
    join_group_by_invite_code,
    leave_group,
    list_my_group_sender_keys,
    preview_group_by_invite_code,
    remove_group_member,
    revoke_group_invite_link,
    update_group_info_and_settings,
    update_group_member_role,
)
from app.services.realtime import ws_manager

router = APIRouter(
    prefix="/groups",
    tags=["groups"],
    dependencies=[Depends(api_rate_limit())],
)


@router.post("", response_model=GroupDetailOut, status_code=status.HTTP_201_CREATED)
async def post_create_group(
    body: GroupCreateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> GroupDetailOut:
    detail, sys_msg, member_ids = await create_group(db, current_user, body)
    now_iso = datetime.now(timezone.utc).isoformat()
    await ws_manager.broadcast_to_users(
        member_ids,
        {
            "event": "group.created",
            "data": {
                "group": detail.model_dump(mode="json"),
                "system_message": sys_msg.model_dump(mode="json"),
            },
            "ts": now_iso,
        },
    )
    await ws_manager.broadcast_to_users(
        member_ids,
        {
            "event": "message.new",
            "data": sys_msg.model_dump(mode="json"),
            "ts": now_iso,
        },
    )
    return detail


@router.get("/invite/{invite_code}", response_model=GroupInvitePreviewOut)
async def get_invite_preview(
    invite_code: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> GroupInvitePreviewOut:
    return await preview_group_by_invite_code(db, invite_code, current_user)


@router.post("/join/{invite_code}", response_model=GroupDetailOut)
async def post_join_by_invite(
    invite_code: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> GroupDetailOut:
    detail, sys_msg, member_ids, newly_joined = await join_group_by_invite_code(
        db, invite_code, current_user
    )
    if newly_joined and sys_msg:
        now_iso = datetime.now(timezone.utc).isoformat()
        await ws_manager.broadcast_to_users(
            member_ids,
            {
                "event": "group.member_added",
                "data": {
                    "group_id": detail.id,
                    "group": detail.model_dump(mode="json"),
                    "key_version": detail.key_version,
                },
                "ts": now_iso,
            },
        )
        await ws_manager.broadcast_to_users(
            member_ids,
            {
                "event": "group.key_rotated",
                "data": {
                    "group_id": detail.id,
                    "key_version": detail.key_version,
                    "reason": "member_joined_invite",
                },
                "ts": now_iso,
            },
        )
        await ws_manager.broadcast_to_users(
            member_ids,
            {
                "event": "message.new",
                "data": sys_msg.model_dump(mode="json"),
                "ts": now_iso,
            },
        )
    return detail


@router.get("/{group_id}", response_model=GroupDetailOut)
async def get_group(
    group_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> GroupDetailOut:
    return await get_group_detail(db, group_id, current_user)


@router.patch("/{group_id}", response_model=GroupDetailOut)
async def patch_group(
    group_id: str,
    body: GroupUpdateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> GroupDetailOut:
    detail, sys_msg, member_ids = await update_group_info_and_settings(
        db, group_id, current_user, body
    )
    now_iso = datetime.now(timezone.utc).isoformat()
    await ws_manager.broadcast_to_users(
        member_ids,
        {
            "event": "group.updated",
            "data": {"group_id": group_id, "group": detail.model_dump(mode="json")},
            "ts": now_iso,
        },
    )
    if sys_msg:
        await ws_manager.broadcast_to_users(
            member_ids,
            {
                "event": "message.new",
                "data": sys_msg.model_dump(mode="json"),
                "ts": now_iso,
            },
        )
    return detail


@router.post("/{group_id}/icon", response_model=GroupDetailOut)
async def post_group_icon(
    group_id: str,
    file: Annotated[UploadFile, File(...)],
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> GroupDetailOut:
    settings = get_settings()
    raw = await file.read(settings.MAX_AVATAR_BYTES + 1)
    if not raw:
        raise AppError("EMPTY_FILE", "Uploaded group icon is empty.")
    if len(raw) > settings.MAX_AVATAR_BYTES:
        raise AppError(
            "FILE_TOO_LARGE",
            "Group icon must not exceed 5 MB.",
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
        )
    detected = _detect_image_ext(raw)
    if not detected:
        raise AppError(
            "UNSUPPORTED_IMAGE",
            "Group icon must be a valid PNG, JPEG, WEBP, or GIF image.",
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        )
    ext, _ = detected
    avatars_dir = settings.storage_path / "avatars"
    avatars_dir.mkdir(parents=True, exist_ok=True)
    filename = f"grp_{group_id[:12]}_{uuid.uuid4().hex[:10]}{ext}"
    (avatars_dir / filename).write_bytes(raw)

    icon_url = f"/api/v1/media/avatars/{filename}"
    detail, sys_msg, member_ids = await update_group_info_and_settings(
        db, group_id, current_user, GroupUpdateRequest(icon_url=icon_url)
    )
    now_iso = datetime.now(timezone.utc).isoformat()
    await ws_manager.broadcast_to_users(
        member_ids,
        {
            "event": "group.updated",
            "data": {"group_id": group_id, "group": detail.model_dump(mode="json")},
            "ts": now_iso,
        },
    )
    if sys_msg:
        await ws_manager.broadcast_to_users(
            member_ids,
            {
                "event": "message.new",
                "data": sys_msg.model_dump(mode="json"),
                "ts": now_iso,
            },
        )
    return detail


@router.post("/{group_id}/members", response_model=GroupDetailOut)
async def post_add_members(
    group_id: str,
    body: GroupAddMembersRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> GroupDetailOut:
    detail, sys_msgs, member_ids = await add_group_members(
        db, group_id, current_user, body.member_ids
    )
    now_iso = datetime.now(timezone.utc).isoformat()
    if sys_msgs:
        await ws_manager.broadcast_to_users(
            member_ids,
            {
                "event": "group.member_added",
                "data": {
                    "group_id": group_id,
                    "group": detail.model_dump(mode="json"),
                    "key_version": detail.key_version,
                },
                "ts": now_iso,
            },
        )
        await ws_manager.broadcast_to_users(
            member_ids,
            {
                "event": "group.key_rotated",
                "data": {
                    "group_id": group_id,
                    "key_version": detail.key_version,
                    "reason": "member_added",
                },
                "ts": now_iso,
            },
        )
        for sm in sys_msgs:
            await ws_manager.broadcast_to_users(
                member_ids,
                {
                    "event": "message.new",
                    "data": sm.model_dump(mode="json"),
                    "ts": now_iso,
                },
            )
    return detail


@router.delete("/{group_id}/members/{target_user_id}", response_model=GroupDetailOut)
async def delete_remove_member(
    group_id: str,
    target_user_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> GroupDetailOut:
    detail, sys_msg, remaining_ids = await remove_group_member(
        db, group_id, current_user, target_user_id
    )
    now_iso = datetime.now(timezone.utc).isoformat()

    # Notify remaining members of new roster + rotated key_version + system message
    await ws_manager.broadcast_to_users(
        remaining_ids,
        {
            "event": "group.member_removed",
            "data": {
                "group_id": group_id,
                "removed_user_id": target_user_id,
                "group": detail.model_dump(mode="json"),
                "key_version": detail.key_version,
            },
            "ts": now_iso,
        },
    )
    await ws_manager.broadcast_to_users(
        remaining_ids,
        {
            "event": "group.key_rotated",
            "data": {
                "group_id": group_id,
                "key_version": detail.key_version,
                "reason": "member_removed",
            },
            "ts": now_iso,
        },
    )
    await ws_manager.broadcast_to_users(
        remaining_ids,
        {
            "event": "message.new",
            "data": sys_msg.model_dump(mode="json"),
            "ts": now_iso,
        },
    )

    # Also notify the removed user so their client removes/disables the group chat immediately
    await ws_manager.send_to_user(
        target_user_id,
        {
            "event": "group.member_removed",
            "data": {
                "group_id": group_id,
                "removed_user_id": target_user_id,
            },
            "ts": now_iso,
        },
    )
    return detail


@router.patch("/{group_id}/members/{target_user_id}", response_model=GroupDetailOut)
@router.patch("/{group_id}/members/{target_user_id}/role", response_model=GroupDetailOut)
async def patch_member_role(
    group_id: str,
    target_user_id: str,
    body: GroupMemberRoleUpdateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> GroupDetailOut:
    detail, sys_msg, member_ids = await update_group_member_role(
        db, group_id, current_user, target_user_id, body.role
    )
    now_iso = datetime.now(timezone.utc).isoformat()
    await ws_manager.broadcast_to_users(
        member_ids,
        {
            "event": "group.updated",
            "data": {"group_id": group_id, "group": detail.model_dump(mode="json")},
            "ts": now_iso,
        },
    )
    if sys_msg:
        await ws_manager.broadcast_to_users(
            member_ids,
            {
                "event": "message.new",
                "data": sys_msg.model_dump(mode="json"),
                "ts": now_iso,
            },
        )
    return detail


@router.post("/{group_id}/leave")
async def post_leave_group(
    group_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> dict[str, object]:
    sys_msg, remaining_ids, new_key_version = await leave_group(db, group_id, current_user)
    now_iso = datetime.now(timezone.utc).isoformat()
    if remaining_ids:
        await ws_manager.broadcast_to_users(
            remaining_ids,
            {
                "event": "group.member_left",
                "data": {
                    "group_id": group_id,
                    "left_user_id": current_user.id,
                    "key_version": new_key_version,
                },
                "ts": now_iso,
            },
        )
        await ws_manager.broadcast_to_users(
            remaining_ids,
            {
                "event": "group.key_rotated",
                "data": {
                    "group_id": group_id,
                    "key_version": new_key_version,
                    "reason": "member_left",
                },
                "ts": now_iso,
            },
        )
        if sys_msg:
            await ws_manager.broadcast_to_users(
                remaining_ids,
                {
                    "event": "message.new",
                    "data": sys_msg.model_dump(mode="json"),
                    "ts": now_iso,
                },
            )
    return {
        "status": "left",
        "group_id": group_id,
        "key_version": new_key_version,
    }


@router.get("/{group_id}/invite", response_model=GroupInviteOut)
async def get_invite_link(
    group_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> GroupInviteOut:
    return await get_group_invite_info(db, group_id, current_user)


@router.post("/{group_id}/invite/revoke", response_model=GroupInviteOut)
async def post_revoke_invite(
    group_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> GroupInviteOut:
    invite_out, sys_msg, member_ids = await revoke_group_invite_link(
        db, group_id, current_user
    )
    now_iso = datetime.now(timezone.utc).isoformat()
    await ws_manager.broadcast_to_users(
        member_ids,
        {
            "event": "message.new",
            "data": sys_msg.model_dump(mode="json"),
            "ts": now_iso,
        },
    )
    return invite_out


@router.post("/{group_id}/keys")
async def post_distribute_sender_keys(
    group_id: str,
    body: DistributeSenderKeysRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> dict[str, object]:
    key_version, recipient_ids = await distribute_sender_keys(
        db, group_id, current_user, body
    )
    now_iso = datetime.now(timezone.utc).isoformat()
    await ws_manager.broadcast_to_users(
        [rid for rid in recipient_ids if rid != current_user.id],
        {
            "event": "group.sender_key_available",
            "data": {
                "group_id": group_id,
                "sender_id": current_user.id,
                "key_version": key_version,
            },
            "ts": now_iso,
        },
    )
    return {
        "status": "distributed",
        "group_id": group_id,
        "key_version": key_version,
        "recipients": len(recipient_ids),
    }


@router.get("/{group_id}/keys", response_model=list[GroupSenderKeyOut])
async def get_my_sender_keys(
    group_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
    key_version: Annotated[int | None, Query(ge=1)] = None,
    sender_id: Annotated[str | None, Query(max_length=36)] = None,
) -> list[GroupSenderKeyOut]:
    return await list_my_group_sender_keys(
        db,
        group_id=group_id,
        requester=current_user,
        key_version=key_version,
        sender_id=sender_id,
    )
