import base64
import hashlib
import secrets
from datetime import datetime, timezone
from typing import Any

from fastapi import status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.models.entities import (
    Block,
    Conversation,
    ConversationMember,
    Group,
    GroupKey,
    Message,
    User,
)
from app.schemas.chat import MessageOut
from app.schemas.groups import (
    DistributeSenderKeysRequest,
    GroupCreateRequest,
    GroupDetailOut,
    GroupInviteOut,
    GroupInvitePreviewOut,
    GroupMemberOut,
    GroupSenderKeyOut,
    GroupSummaryOut,
    GroupUpdateRequest,
    SenderKeyEnvelopeIn,
)
from app.services.federation_hook import resolve_user_by_identifier
from app.services.federation_service import (
    enqueue_federation_event,
    enqueue_for_remote_users,
    trigger_outbox_wakeup,
)

SENDER_COLOR_PALETTE: list[str] = [
    "#e542a3",
    "#00a884",
    "#53bdeb",
    "#f97316",
    "#8b5cf6",
    "#06cf9c",
    "#eab308",
    "#ef4444",
    "#3b82f6",
    "#14b8a6",
]

SYSTEM_NONCE_B64 = base64.b64encode(b"\x00" * 12).decode("ascii")


def deterministic_sender_color(user_id: str) -> str:
    digest = hashlib.sha256(user_id.encode("utf-8")).digest()
    return SENDER_COLOR_PALETTE[digest[0] % len(SENDER_COLOR_PALETTE)]


def _generate_invite_code() -> str:
    return secrets.token_urlsafe(18)


def _normalize_role(role: str) -> str:
    return "admin" if role in ("owner", "admin") else "member"


async def _resolve_target_user(db: AsyncSession, raw_id_or_handle: str) -> User:
    cleaned = raw_id_or_handle.strip()
    if not cleaned:
        raise AppError("INVALID_MEMBER", "Member identifier cannot be empty.")

    res = await db.execute(select(User).where(User.id == cleaned))
    by_uuid = res.scalar_one_or_none()
    if by_uuid:
        return by_uuid

    resolved = await resolve_user_by_identifier(db, cleaned)
    if not resolved:
        raise AppError(
            "MEMBER_NOT_FOUND",
            f"User '{cleaned}' was not found.",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    return resolved


async def _assert_no_direct_block(db: AsyncSession, actor_id: str, target_id: str) -> None:
    if actor_id == target_id:
        return
    res = await db.execute(
        select(Block.id).where(
            ((Block.blocker_id == actor_id) & (Block.blocked_id == target_id))
            | ((Block.blocker_id == target_id) & (Block.blocked_id == actor_id))
        )
    )
    if res.scalar_one_or_none():
        raise AppError(
            "USER_BLOCKED",
            "Cannot add a user when a block exists between accounts.",
            status_code=status.HTTP_403_FORBIDDEN,
        )


def _create_system_message_row(
    conversation_id: str,
    actor: User,
    text: str,
    action: str,
    extra: dict[str, Any] | None = None,
    now: datetime | None = None,
) -> Message:
    ts = now or datetime.now(timezone.utc)
    ct = base64.b64encode(text.encode("utf-8")).decode("ascii")
    ev: dict[str, Any] = {
        "action": action,
        "actor_id": actor.id,
        "actor_name": actor.display_name,
        "text": text,
    }
    if extra:
        ev.update(extra)
    return Message(
        conversation_id=conversation_id,
        sender_id=actor.id,
        sender_global_id=actor.global_id,
        ciphertext=ct,
        nonce=SYSTEM_NONCE_B64,
        message_type="system",
        status="read",
        system_event=ev,
        mentions=[],
        created_at=ts,
        updated_at=ts,
    )


async def get_group_and_membership(
    db: AsyncSession,
    group_id: str,
    user_id: str,
) -> tuple[Conversation, Group, ConversationMember]:
    conv_res = await db.execute(
        select(Conversation).where(
            Conversation.id == group_id,
            Conversation.type == "group",
        )
    )
    conv = conv_res.scalar_one_or_none()
    if not conv:
        raise AppError(
            "GROUP_NOT_FOUND",
            "Group conversation was not found.",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    grp_res = await db.execute(select(Group).where(Group.id == group_id))
    group = grp_res.scalar_one_or_none()
    if not group:
        # Backfill Group row if legacy group conversation existed
        group = Group(
            id=conv.id,
            name=conv.name or "Group",
            icon_url=conv.icon_url,
            description=conv.description or "",
            created_by_id=conv.created_by_id,
            invite_code=_generate_invite_code(),
            key_version=1,
        )
        db.add(group)
        await db.flush()

    mem_res = await db.execute(
        select(ConversationMember).where(
            ConversationMember.conversation_id == group_id,
            ConversationMember.user_id == user_id,
        )
    )
    member = mem_res.scalar_one_or_none()
    if not member:
        raise AppError(
            "FORBIDDEN_CONVERSATION",
            "You are no longer a member of this group.",
            status_code=status.HTTP_403_FORBIDDEN,
        )
    return conv, group, member


async def build_group_summary_out(
    db: AsyncSession,
    conv: Conversation,
    current_user: User,
) -> GroupSummaryOut | None:
    if conv.type != "group":
        return None

    grp_res = await db.execute(select(Group).where(Group.id == conv.id))
    group = grp_res.scalar_one_or_none()
    if not group:
        group = Group(
            id=conv.id,
            name=conv.name or "Group",
            icon_url=conv.icon_url,
            description=conv.description or "",
            created_by_id=conv.created_by_id,
            invite_code=_generate_invite_code(),
            key_version=1,
        )
        db.add(group)
        await db.flush()

    mem_rows = (
        await db.execute(
            select(ConversationMember, User)
            .join(User, User.id == ConversationMember.user_id)
            .where(ConversationMember.conversation_id == conv.id)
            .order_by(ConversationMember.joined_at.asc())
        )
    ).all()

    my_role: str = "member"
    members_out: list[GroupMemberOut] = []
    for cm, u in mem_rows:
        norm_role = _normalize_role(cm.role)
        if u.id == current_user.id:
            my_role = norm_role
        color = cm.sender_color or deterministic_sender_color(u.id)
        show_online = u.privacy_last_seen != "nobody"
        members_out.append(
            GroupMemberOut(
                user_id=u.id,
                username=u.username,
                domain=u.domain,
                global_id=u.global_id,
                display_name=u.display_name,
                avatar_url=u.avatar_url if u.privacy_profile_photo != "nobody" else None,
                public_key=u.public_key,
                role="admin" if norm_role == "admin" else "member",
                sender_color=color,
                is_online=u.is_online if show_online else False,
                joined_at=cm.joined_at,
            )
        )

    return GroupSummaryOut(
        id=group.id,
        name=group.name,
        description=group.description or "",
        icon_url=group.icon_url,
        created_by_id=group.created_by_id,
        key_version=group.key_version,
        only_admins_can_send=group.only_admins_can_send,
        only_admins_can_edit_info=group.only_admins_can_edit_info,
        my_role="admin" if my_role == "admin" else "member",
        member_count=len(members_out),
        invite_code=group.invite_code,
        members=members_out,
        created_at=group.created_at,
    )


async def build_federation_group_snapshot(
    db: AsyncSession,
    group_id: str,
) -> dict[str, Any]:
    conv = (
        await db.execute(select(Conversation).where(Conversation.id == group_id))
    ).scalar_one()
    grp = (await db.execute(select(Group).where(Group.id == group_id))).scalar_one()
    creator_gid: str | None = None
    if grp.created_by_id:
        cu = (
            await db.execute(select(User).where(User.id == grp.created_by_id))
        ).scalar_one_or_none()
        if cu:
            creator_gid = cu.global_id

    rows = (
        await db.execute(
            select(ConversationMember, User)
            .join(User, User.id == ConversationMember.user_id)
            .where(ConversationMember.conversation_id == group_id)
            .order_by(ConversationMember.joined_at.asc())
        )
    ).all()
    return {
        "group_id": grp.id,
        "name": grp.name,
        "description": grp.description or "",
        "icon_url": grp.icon_url,
        "key_version": grp.key_version,
        "only_admins_can_send": grp.only_admins_can_send,
        "only_admins_can_edit_info": grp.only_admins_can_edit_info,
        "created_by_global_id": creator_gid,
        "created_at": conv.created_at.isoformat(),
        "members": [
            {
                "global_id": u.global_id,
                "role": "admin" if _normalize_role(cm.role) == "admin" else "member",
            }
            for cm, u in rows
        ],
    }


async def _sync_group_to_remote_members(
    db: AsyncSession,
    *,
    group_id: str,
    actor: User,
    sub_event: str,
    sys_msg: Message | None = None,
    key_rotated: bool = False,
    reason: str | None = None,
) -> None:
    rows = (
        await db.execute(
            select(User)
            .join(ConversationMember, ConversationMember.user_id == User.id)
            .where(ConversationMember.conversation_id == group_id)
        )
    ).scalars().all()
    remote_users = [u for u in rows if not u.is_local and u.id != actor.id]
    if not remote_users:
        return

    snap = await build_federation_group_snapshot(db, group_id)
    sys_payload = None
    if sys_msg is not None:
        sys_payload = {
            "id": sys_msg.id,
            "ciphertext": sys_msg.ciphertext,
            "nonce": sys_msg.nonce,
            "system_event": sys_msg.system_event,
            "created_at": sys_msg.created_at.isoformat(),
        }

    await enqueue_for_remote_users(
        db,
        remote_users,
        event_type="group.sync",
        data={
            "actor_global_id": actor.global_id,
            "sub_event": sub_event,
            "key_rotated": key_rotated,
            "reason": reason,
            "group": snap,
            "system_message": sys_payload,
        },
        commit=True,
    )


async def _upsert_sender_key_envelopes_internal(
    db: AsyncSession,
    conversation_id: str,
    sender_id: str,
    key_version: int,
    active_member_ids: set[str],
    envelopes: list[SenderKeyEnvelopeIn],
) -> None:
    for env in envelopes:
        if env.recipient_id not in active_member_ids:
            raise AppError(
                "INVALID_KEY_RECIPIENT",
                f"Recipient '{env.recipient_id}' is not an active member of this group.",
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        existing = (
            await db.execute(
                select(GroupKey).where(
                    GroupKey.conversation_id == conversation_id,
                    GroupKey.sender_id == sender_id,
                    GroupKey.recipient_id == env.recipient_id,
                    GroupKey.key_generation == key_version,
                )
            )
        ).scalar_one_or_none()
        if existing:
            existing.encrypted_sender_key = env.wrapped_key
            existing.nonce = env.nonce
            existing.key_version = key_version
        else:
            db.add(
                GroupKey(
                    conversation_id=conversation_id,
                    sender_id=sender_id,
                    recipient_id=env.recipient_id,
                    key_generation=key_version,
                    key_version=key_version,
                    encrypted_sender_key=env.wrapped_key,
                    nonce=env.nonce,
                )
            )


async def create_group(
    db: AsyncSession,
    creator: User,
    body: GroupCreateRequest,
) -> tuple[GroupDetailOut, MessageOut, list[str]]:
    clean_name = body.name.strip()
    if not clean_name:
        raise AppError("INVALID_GROUP_NAME", "Group name cannot be empty.")

    target_users: dict[str, User] = {creator.id: creator}
    for raw_ident in body.member_ids:
        u = await _resolve_target_user(db, raw_ident)
        if u.id != creator.id:
            await _assert_no_direct_block(db, creator.id, u.id)
            target_users[u.id] = u

    now = datetime.now(timezone.utc)
    conv = Conversation(
        type="group",
        name=clean_name,
        description=body.description.strip(),
        icon_url=body.icon_url,
        created_by_id=creator.id,
        direct_pair_key=None,
        last_message_at=now,
        created_at=now,
        updated_at=now,
    )
    db.add(conv)
    await db.flush()

    group = Group(
        id=conv.id,
        name=clean_name,
        description=body.description.strip(),
        icon_url=body.icon_url,
        created_by_id=creator.id,
        only_admins_can_send=body.only_admins_can_send,
        only_admins_can_edit_info=body.only_admins_can_edit_info,
        invite_code=_generate_invite_code(),
        key_version=1,
        created_at=now,
        updated_at=now,
    )
    db.add(group)

    for uid, u in target_users.items():
        db.add(
            ConversationMember(
                conversation_id=conv.id,
                user_id=uid,
                role="admin" if uid == creator.id else "member",
                added_by_id=creator.id,
                sender_color=deterministic_sender_color(uid),
                unread_count=0 if uid == creator.id else 1,
                joined_at=now,
            )
        )

    sys_msg = _create_system_message_row(
        conv.id,
        creator,
        f'{creator.display_name} created group "{clean_name}"',
        action="group_created",
        now=now,
    )
    db.add(sys_msg)
    await db.flush()

    if body.sender_key_envelopes:
        await _upsert_sender_key_envelopes_internal(
            db,
            conversation_id=conv.id,
            sender_id=creator.id,
            key_version=1,
            active_member_ids=set(target_users.keys()),
            envelopes=body.sender_key_envelopes,
        )

    await db.commit()
    await db.refresh(conv)
    await db.refresh(sys_msg)

    await _sync_group_to_remote_members(
        db,
        group_id=conv.id,
        actor=creator,
        sub_event="group.created",
        sys_msg=sys_msg,
    )

    if body.sender_key_envelopes:
        await _forward_remote_sender_key_envelopes(
            db,
            group_id=conv.id,
            sender=creator,
            key_version=1,
            envelopes=body.sender_key_envelopes,
        )

    summary = await build_group_summary_out(db, conv, creator)
    assert summary is not None
    sys_out = MessageOut.model_validate(sys_msg)
    sys_out.sender_display_name = creator.display_name
    return GroupDetailOut(**summary.model_dump()), sys_out, list(target_users.keys())


async def get_group_detail(
    db: AsyncSession,
    group_id: str,
    current_user: User,
) -> GroupDetailOut:
    conv, _, _ = await get_group_and_membership(db, group_id, current_user.id)
    summary = await build_group_summary_out(db, conv, current_user)
    assert summary is not None
    return GroupDetailOut(**summary.model_dump())


async def update_group_info_and_settings(
    db: AsyncSession,
    group_id: str,
    actor: User,
    body: GroupUpdateRequest,
) -> tuple[GroupDetailOut, MessageOut | None, list[str]]:
    conv, group, my_mem = await get_group_and_membership(db, group_id, actor.id)
    is_admin = _normalize_role(my_mem.role) == "admin"

    wants_policy_change = (
        body.only_admins_can_send is not None
        or body.only_admins_can_edit_info is not None
    )
    if wants_policy_change and not is_admin:
        raise AppError(
            "ADMIN_REQUIRED",
            "Only group admins can modify group permission settings.",
            status_code=status.HTTP_403_FORBIDDEN,
        )

    wants_info_change = (
        body.name is not None
        or body.description is not None
        or body.icon_url is not None
    )
    if wants_info_change and group.only_admins_can_edit_info and not is_admin:
        raise AppError(
            "ADMIN_REQUIRED",
            "Only group admins can edit this group's info.",
            status_code=status.HTTP_403_FORBIDDEN,
        )

    changes: list[str] = []
    now = datetime.now(timezone.utc)

    if body.name is not None and body.name.strip() != group.name:
        group.name = body.name.strip()
        conv.name = group.name
        changes.append(f'{actor.display_name} changed the group name to "{group.name}"')

    if body.description is not None and body.description.strip() != (group.description or ""):
        group.description = body.description.strip()
        conv.description = group.description
        changes.append(f"{actor.display_name} updated the group description")

    if body.icon_url is not None and body.icon_url != group.icon_url:
        group.icon_url = body.icon_url
        conv.icon_url = body.icon_url
        changes.append(f"{actor.display_name} changed the group icon")

    if (
        body.only_admins_can_send is not None
        and body.only_admins_can_send != group.only_admins_can_send
    ):
        group.only_admins_can_send = body.only_admins_can_send
        mode_lbl = "only admins" if group.only_admins_can_send else "all members"
        changes.append(
            f"{actor.display_name} changed who can send messages to {mode_lbl}"
        )

    if (
        body.only_admins_can_edit_info is not None
        and body.only_admins_can_edit_info != group.only_admins_can_edit_info
    ):
        group.only_admins_can_edit_info = body.only_admins_can_edit_info
        edit_lbl = "only admins" if group.only_admins_can_edit_info else "all members"
        changes.append(
            f"{actor.display_name} changed who can edit group info to {edit_lbl}"
        )

    sys_msg: Message | None = None
    if changes:
        group.updated_at = now
        conv.updated_at = now
        conv.last_message_at = now
        sys_msg = _create_system_message_row(
            conv.id,
            actor,
            " • ".join(changes),
            action="group_updated",
            now=now,
        )
        db.add(sys_msg)

    await db.commit()
    if sys_msg:
        await db.refresh(sys_msg)
        await _sync_group_to_remote_members(
            db,
            group_id=conv.id,
            actor=actor,
            sub_event="group.updated",
            sys_msg=sys_msg,
        )

    mem_ids = list(
        (
            await db.execute(
                select(ConversationMember.user_id).where(
                    ConversationMember.conversation_id == conv.id
                )
            )
        )
        .scalars()
        .all()
    )
    summary = await build_group_summary_out(db, conv, actor)
    assert summary is not None
    sys_out = MessageOut.model_validate(sys_msg) if sys_msg else None
    return GroupDetailOut(**summary.model_dump()), sys_out, mem_ids


async def add_group_members(
    db: AsyncSession,
    group_id: str,
    actor: User,
    raw_member_ids: list[str],
) -> tuple[GroupDetailOut, list[MessageOut], list[str]]:
    conv, group, my_mem = await get_group_and_membership(db, group_id, actor.id)
    if _normalize_role(my_mem.role) != "admin":
        raise AppError(
            "ADMIN_REQUIRED",
            "Only group admins can add new members.",
            status_code=status.HTTP_403_FORBIDDEN,
        )

    existing_ids = set(
        (
            await db.execute(
                select(ConversationMember.user_id).where(
                    ConversationMember.conversation_id == group_id
                )
            )
        )
        .scalars()
        .all()
    )

    added_users: list[User] = []
    for raw_ident in raw_member_ids:
        u = await _resolve_target_user(db, raw_ident)
        if u.id in existing_ids or any(a.id == u.id for a in added_users):
            continue
        await _assert_no_direct_block(db, actor.id, u.id)
        added_users.append(u)

    if not added_users:
        summary = await build_group_summary_out(db, conv, actor)
        assert summary is not None
        return GroupDetailOut(**summary.model_dump()), [], list(existing_ids)

    now = datetime.now(timezone.utc)
    # Rotate sender key version on membership addition!
    group.key_version += 1
    group.updated_at = now
    conv.updated_at = now
    conv.last_message_at = now

    sys_msgs: list[Message] = []
    for u in added_users:
        db.add(
            ConversationMember(
                conversation_id=conv.id,
                user_id=u.id,
                role="member",
                added_by_id=actor.id,
                sender_color=deterministic_sender_color(u.id),
                unread_count=1,
                joined_at=now,
            )
        )
        sm = _create_system_message_row(
            conv.id,
            actor,
            f"{actor.display_name} added {u.display_name}",
            action="member_added",
            extra={"target_id": u.id, "target_name": u.display_name},
            now=now,
        )
        db.add(sm)
        sys_msgs.append(sm)

    await db.commit()
    for sm in sys_msgs:
        await db.refresh(sm)

    await _sync_group_to_remote_members(
        db,
        group_id=conv.id,
        actor=actor,
        sub_event="group.member_added",
        sys_msg=sys_msgs[-1] if sys_msgs else None,
        key_rotated=True,
        reason="member_added",
    )

    all_member_ids = list(existing_ids | {u.id for u in added_users})
    summary = await build_group_summary_out(db, conv, actor)
    assert summary is not None
    return (
        GroupDetailOut(**summary.model_dump()),
        [MessageOut.model_validate(sm) for sm in sys_msgs],
        all_member_ids,
    )


async def remove_group_member(
    db: AsyncSession,
    group_id: str,
    actor: User,
    target_user_id: str,
) -> tuple[GroupDetailOut, MessageOut, list[str]]:
    conv, group, my_mem = await get_group_and_membership(db, group_id, actor.id)
    if _normalize_role(my_mem.role) != "admin":
        raise AppError(
            "ADMIN_REQUIRED",
            "Only group admins can remove members.",
            status_code=status.HTTP_403_FORBIDDEN,
        )
    if target_user_id == actor.id:
        raise AppError(
            "USE_LEAVE_ENDPOINT",
            "Use the leave endpoint to exit a group yourself.",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    target_mem = (
        await db.execute(
            select(ConversationMember).where(
                ConversationMember.conversation_id == group_id,
                ConversationMember.user_id == target_user_id,
            )
        )
    ).scalar_one_or_none()
    if not target_mem:
        raise AppError(
            "MEMBER_NOT_FOUND",
            "Target user is not a member of this group.",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    target_user = (
        await db.execute(select(User).where(User.id == target_user_id))
    ).scalar_one()

    now = datetime.now(timezone.utc)
    await db.delete(target_mem)

    # Rotate sender key version so removed member NEVER receives future sender keys!
    group.key_version += 1
    group.updated_at = now
    conv.updated_at = now
    conv.last_message_at = now

    # Purge any wrapped key envelopes addressed to removed member at >= rotated version
    await db.execute(
        delete(GroupKey).where(
            GroupKey.conversation_id == group_id,
            GroupKey.recipient_id == target_user_id,
            GroupKey.key_version >= group.key_version,
        )
    )

    sys_msg = _create_system_message_row(
        conv.id,
        actor,
        f"{actor.display_name} removed {target_user.display_name}",
        action="member_removed",
        extra={"target_id": target_user.id, "target_name": target_user.display_name},
        now=now,
    )
    db.add(sys_msg)
    await db.commit()
    await db.refresh(sys_msg)

    if not target_user.is_local:
        snap = await build_federation_group_snapshot(db, group_id)
        await enqueue_federation_event(
            db,
            target_domain=target_user.domain,
            event_type="group.member_removed",
            data={
                "actor_global_id": actor.global_id,
                "group_id": group_id,
                "removed_global_id": target_user.global_id,
                "group": snap,
            },
            commit=True,
        )

    await _sync_group_to_remote_members(
        db,
        group_id=group_id,
        actor=actor,
        sub_event="group.member_removed",
        sys_msg=sys_msg,
        key_rotated=True,
        reason="member_removed",
    )

    remaining_ids = list(
        (
            await db.execute(
                select(ConversationMember.user_id).where(
                    ConversationMember.conversation_id == group_id
                )
            )
        )
        .scalars()
        .all()
    )
    summary = await build_group_summary_out(db, conv, actor)
    assert summary is not None
    return (
        GroupDetailOut(**summary.model_dump()),
        MessageOut.model_validate(sys_msg),
        remaining_ids,
    )


async def update_group_member_role(
    db: AsyncSession,
    group_id: str,
    actor: User,
    target_user_id: str,
    new_role: str,
) -> tuple[GroupDetailOut, MessageOut | None, list[str]]:
    conv, group, my_mem = await get_group_and_membership(db, group_id, actor.id)
    if _normalize_role(my_mem.role) != "admin":
        raise AppError(
            "ADMIN_REQUIRED",
            "Only group admins can promote or demote admins.",
            status_code=status.HTTP_403_FORBIDDEN,
        )

    target_mem = (
        await db.execute(
            select(ConversationMember).where(
                ConversationMember.conversation_id == group_id,
                ConversationMember.user_id == target_user_id,
            )
        )
    ).scalar_one_or_none()
    if not target_mem:
        raise AppError(
            "MEMBER_NOT_FOUND",
            "Target user is not a member of this group.",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    current_norm = _normalize_role(target_mem.role)
    if current_norm == new_role:
        mem_ids = list(
            (
                await db.execute(
                    select(ConversationMember.user_id).where(
                        ConversationMember.conversation_id == group_id
                    )
                )
            )
            .scalars()
            .all()
        )
        summary = await build_group_summary_out(db, conv, actor)
        assert summary is not None
        return GroupDetailOut(**summary.model_dump()), None, mem_ids

    if new_role == "member":
        all_mems = list(
            (
                await db.execute(
                    select(ConversationMember).where(
                        ConversationMember.conversation_id == group_id
                    )
                )
            )
            .scalars()
            .all()
        )
        admin_count = sum(1 for m in all_mems if _normalize_role(m.role) == "admin")
        if admin_count <= 1:
            raise AppError(
                "LAST_ADMIN_REQUIRED",
                "Cannot demote the last admin of the group.",
                status_code=status.HTTP_400_BAD_REQUEST,
            )

    target_user = (
        await db.execute(select(User).where(User.id == target_user_id))
    ).scalar_one()

    now = datetime.now(timezone.utc)
    target_mem.role = new_role
    group.updated_at = now
    conv.updated_at = now
    conv.last_message_at = now

    label = (
        f"{actor.display_name} made {target_user.display_name} an admin"
        if new_role == "admin"
        else f"{actor.display_name} dismissed {target_user.display_name} as admin"
    )
    sys_msg = _create_system_message_row(
        conv.id,
        actor,
        label,
        action="member_role_changed",
        extra={"target_id": target_user.id, "new_role": new_role},
        now=now,
    )
    db.add(sys_msg)
    await db.commit()
    await db.refresh(sys_msg)

    mem_ids = list(
        (
            await db.execute(
                select(ConversationMember.user_id).where(
                    ConversationMember.conversation_id == group_id
                )
            )
        )
        .scalars()
        .all()
    )
    summary = await build_group_summary_out(db, conv, actor)
    assert summary is not None
    return (
        GroupDetailOut(**summary.model_dump()),
        MessageOut.model_validate(sys_msg),
        mem_ids,
    )


async def leave_group(
    db: AsyncSession,
    group_id: str,
    actor: User,
) -> tuple[MessageOut | None, list[str], int]:
    conv, group, my_mem = await get_group_and_membership(db, group_id, actor.id)

    other_mems = list(
        (
            await db.execute(
                select(ConversationMember)
                .where(
                    ConversationMember.conversation_id == group_id,
                    ConversationMember.user_id != actor.id,
                )
                .order_by(ConversationMember.joined_at.asc())
            )
        )
        .scalars()
        .all()
    )

    now = datetime.now(timezone.utc)
    await db.delete(my_mem)

    if not other_mems:
        # Last member left -> delete group conversation cleanly
        await db.delete(conv)
        await db.commit()
        return None, [], group.key_version

    # If actor was the sole admin, auto-promote the earliest-joined remaining member!
    if not any(_normalize_role(m.role) == "admin" for m in other_mems):
        other_mems[0].role = "admin"

    group.key_version += 1
    group.updated_at = now
    conv.updated_at = now
    conv.last_message_at = now

    sys_msg = _create_system_message_row(
        conv.id,
        actor,
        f"{actor.display_name} left",
        action="member_left",
        now=now,
    )
    db.add(sys_msg)
    await db.commit()
    await db.refresh(sys_msg)

    remaining_ids = [m.user_id for m in other_mems]
    return MessageOut.model_validate(sys_msg), remaining_ids, group.key_version


async def get_group_invite_info(
    db: AsyncSession,
    group_id: str,
    actor: User,
) -> GroupInviteOut:
    _, group, _ = await get_group_and_membership(db, group_id, actor.id)
    if not group.invite_code:
        group.invite_code = _generate_invite_code()
        await db.commit()
    return GroupInviteOut(
        group_id=group.id,
        invite_code=group.invite_code,
        invite_path=f"/?join={group.invite_code}",
        invite_revoked_at=group.invite_revoked_at,
    )


async def revoke_group_invite_link(
    db: AsyncSession,
    group_id: str,
    actor: User,
) -> tuple[GroupInviteOut, MessageOut, list[str]]:
    conv, group, my_mem = await get_group_and_membership(db, group_id, actor.id)
    if _normalize_role(my_mem.role) != "admin":
        raise AppError(
            "ADMIN_REQUIRED",
            "Only group admins can revoke and reset the invite link.",
            status_code=status.HTTP_403_FORBIDDEN,
        )

    now = datetime.now(timezone.utc)
    group.invite_code = _generate_invite_code()
    group.invite_revoked_at = now
    group.updated_at = now
    conv.updated_at = now
    conv.last_message_at = now

    sys_msg = _create_system_message_row(
        conv.id,
        actor,
        f"{actor.display_name} reset the group invite link",
        action="invite_revoked",
        now=now,
    )
    db.add(sys_msg)
    await db.commit()
    await db.refresh(sys_msg)

    mem_ids = list(
        (
            await db.execute(
                select(ConversationMember.user_id).where(
                    ConversationMember.conversation_id == group_id
                )
            )
        )
        .scalars()
        .all()
    )
    return (
        GroupInviteOut(
            group_id=group.id,
            invite_code=group.invite_code,
            invite_path=f"/?join={group.invite_code}",
            invite_revoked_at=group.invite_revoked_at,
        ),
        MessageOut.model_validate(sys_msg),
        mem_ids,
    )


async def preview_group_by_invite_code(
    db: AsyncSession,
    invite_code: str,
    viewer: User,
) -> GroupInvitePreviewOut:
    group = (
        await db.execute(select(Group).where(Group.invite_code == invite_code.strip()))
    ).scalar_one_or_none()
    if not group:
        raise AppError(
            "INVITE_INVALID_OR_REVOKED",
            "This group invite link is invalid or has been revoked.",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    mems = list(
        (
            await db.execute(
                select(ConversationMember.user_id).where(
                    ConversationMember.conversation_id == group.id
                )
            )
        )
        .scalars()
        .all()
    )
    return GroupInvitePreviewOut(
        group_id=group.id,
        name=group.name,
        description=group.description or "",
        icon_url=group.icon_url,
        member_count=len(mems),
        already_member=viewer.id in mems,
    )


async def join_group_by_invite_code(
    db: AsyncSession,
    invite_code: str,
    joiner: User,
) -> tuple[GroupDetailOut, MessageOut | None, list[str], bool]:
    group = (
        await db.execute(select(Group).where(Group.invite_code == invite_code.strip()))
    ).scalar_one_or_none()
    if not group:
        raise AppError(
            "INVITE_INVALID_OR_REVOKED",
            "This group invite link is invalid or has been revoked.",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    conv = (
        await db.execute(select(Conversation).where(Conversation.id == group.id))
    ).scalar_one()

    existing_mem = (
        await db.execute(
            select(ConversationMember).where(
                ConversationMember.conversation_id == group.id,
                ConversationMember.user_id == joiner.id,
            )
        )
    ).scalar_one_or_none()

    if existing_mem:
        mem_ids = list(
            (
                await db.execute(
                    select(ConversationMember.user_id).where(
                        ConversationMember.conversation_id == group.id
                    )
                )
            )
            .scalars()
            .all()
        )
        summary = await build_group_summary_out(db, conv, joiner)
        assert summary is not None
        return GroupDetailOut(**summary.model_dump()), None, mem_ids, False

    now = datetime.now(timezone.utc)
    group.key_version += 1
    group.updated_at = now
    conv.updated_at = now
    conv.last_message_at = now

    db.add(
        ConversationMember(
            conversation_id=group.id,
            user_id=joiner.id,
            role="member",
            added_by_id=joiner.id,
            sender_color=deterministic_sender_color(joiner.id),
            unread_count=0,
            joined_at=now,
        )
    )
    sys_msg = _create_system_message_row(
        conv.id,
        joiner,
        f"{joiner.display_name} joined via invite link",
        action="member_joined_invite",
        now=now,
    )
    db.add(sys_msg)
    await db.commit()
    await db.refresh(sys_msg)

    mem_ids = list(
        (
            await db.execute(
                select(ConversationMember.user_id).where(
                    ConversationMember.conversation_id == group.id
                )
            )
        )
        .scalars()
        .all()
    )
    summary = await build_group_summary_out(db, conv, joiner)
    assert summary is not None
    return (
        GroupDetailOut(**summary.model_dump()),
        MessageOut.model_validate(sys_msg),
        mem_ids,
        True,
    )


async def _forward_remote_sender_key_envelopes(
    db: AsyncSession,
    *,
    group_id: str,
    sender: User,
    key_version: int,
    envelopes: list[SenderKeyEnvelopeIn],
) -> None:
    if not envelopes:
        return
    rcpt_ids = list({e.recipient_id for e in envelopes})
    users = list(
        (await db.execute(select(User).where(User.id.in_(rcpt_ids)))).scalars().all()
    )
    users_by_id = {u.id: u for u in users}
    by_domain: dict[str, list[dict[str, str]]] = {}
    for env in envelopes:
        ru = users_by_id.get(env.recipient_id)
        if ru and not ru.is_local:
            by_domain.setdefault(ru.domain.lower(), []).append(
                {
                    "recipient_global_id": ru.global_id,
                    "wrapped_key": env.wrapped_key,
                    "nonce": env.nonce,
                }
            )
    queued = False
    for dom, dom_envs in by_domain.items():
        q = await enqueue_federation_event(
            db,
            target_domain=dom,
            event_type="group.sender_keys",
            data={
                "group_id": group_id,
                "sender_global_id": sender.global_id,
                "key_version": key_version,
                "envelopes": dom_envs,
            },
            commit=False,
        )
        if q is not None:
            queued = True
    if queued:
        await db.commit()
        trigger_outbox_wakeup()


async def distribute_sender_keys(
    db: AsyncSession,
    group_id: str,
    sender: User,
    body: DistributeSenderKeysRequest,
) -> tuple[int, list[str]]:
    _, group, _ = await get_group_and_membership(db, group_id, sender.id)
    if body.key_version != group.key_version:
        raise AppError(
            "STALE_GROUP_KEY_VERSION",
            f"Group is at key_version={group.key_version}; cannot distribute keys for v{body.key_version}.",
            status_code=status.HTTP_409_CONFLICT,
        )

    active_ids = set(
        (
            await db.execute(
                select(ConversationMember.user_id).where(
                    ConversationMember.conversation_id == group_id
                )
            )
        )
        .scalars()
        .all()
    )

    await _upsert_sender_key_envelopes_internal(
        db,
        conversation_id=group_id,
        sender_id=sender.id,
        key_version=body.key_version,
        active_member_ids=active_ids,
        envelopes=body.envelopes,
    )
    await db.commit()
    await _forward_remote_sender_key_envelopes(
        db,
        group_id=group_id,
        sender=sender,
        key_version=body.key_version,
        envelopes=body.envelopes,
    )
    return body.key_version, [env.recipient_id for env in body.envelopes]


async def list_my_group_sender_keys(
    db: AsyncSession,
    group_id: str,
    requester: User,
    key_version: int | None = None,
    sender_id: str | None = None,
) -> list[GroupSenderKeyOut]:
    # Strictly enforce active group membership — removed users get 403!
    await get_group_and_membership(db, group_id, requester.id)

    stmt = (
        select(GroupKey, User)
        .join(User, User.id == GroupKey.sender_id)
        .where(
            GroupKey.conversation_id == group_id,
            GroupKey.recipient_id == requester.id,
        )
    )
    if key_version is not None:
        stmt = stmt.where(GroupKey.key_version == key_version)
    if sender_id is not None:
        stmt = stmt.where(GroupKey.sender_id == sender_id)

    stmt = stmt.order_by(GroupKey.key_version.desc())
    rows = (await db.execute(stmt)).all()

    return [
        GroupSenderKeyOut(
            id=gk.id,
            group_id=gk.conversation_id,
            sender_id=gk.sender_id,
            sender_global_id=sender_user.global_id,
            sender_public_key=sender_user.public_key,
            recipient_id=gk.recipient_id,
            key_version=gk.key_version,
            wrapped_key=gk.encrypted_sender_key,
            nonce=gk.nonce,
            created_at=gk.created_at,
        )
        for gk, sender_user in rows
    ]
