import base64
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import status
from sqlalchemy import and_, desc, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import AppError
from app.core.metrics import metrics_registry
from app.models.entities import (
    Attachment,
    Conversation,
    ConversationMember,
    Group,
    LiveLocationSession,
    Message,
    MessageReceipt,
    StarredMessage,
    User,
)
from app.schemas.chat import (
    ConversationOut,
    CursorMessagesOut,
    MessageCreateRequest,
    MessageOut,
    MessageReceiptEntryOut,
    PeerSummaryOut,
    StarredMessageOut,
)
from app.services.federation_hook import resolve_user_by_identifier
from app.services.federation_service import (
    enqueue_federation_event,
    enqueue_for_remote_users,
    trigger_outbox_wakeup,
)
from app.services.group_service import (
    build_federation_group_snapshot,
    build_group_summary_out,
    deterministic_sender_color,
)
from app.services.privacy_service import (
    assert_not_blocked_for_messaging,
    build_peer_summary_for_viewer,
    can_actor_emit_read_receipt,
)

EDIT_WINDOW_MINUTES = 15
STATUS_RANK = {"sent": 1, "delivered": 2, "read": 3}


def _ensure_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _encode_cursor(dt: datetime, msg_id: str) -> str:
    raw = f"{_ensure_utc(dt).isoformat()}|{msg_id}".encode("utf-8")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _decode_cursor(cursor: str) -> tuple[datetime, str]:
    try:
        padded = cursor.strip() + "=" * (-len(cursor.strip()) % 4)
        decoded = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
        iso_part, msg_id = decoded.split("|", 1)
        dt = datetime.fromisoformat(iso_part)
        return _ensure_utc(dt), msg_id
    except Exception as exc:
        raise AppError("INVALID_CURSOR", "Invalid pagination cursor.", status_code=400) from exc


def _peer_summary(peer: User) -> PeerSummaryOut:
    # Enforce peer's privacy_last_seen preference when nobody is selected
    show_presence = peer.privacy_last_seen != "nobody"
    return PeerSummaryOut(
        id=peer.id,
        username=peer.username,
        domain=peer.domain,
        global_id=peer.global_id,
        display_name=peer.display_name,
        about=peer.about,
        avatar_url=peer.avatar_url,
        public_key=peer.public_key,
        is_online=peer.is_online if show_presence else False,
        last_seen_at=peer.last_seen_at if show_presence else None,
    )


async def get_conversation_member_ids(db: AsyncSession, conversation_id: str) -> list[str]:
    res = await db.execute(
        select(ConversationMember.user_id).where(
            ConversationMember.conversation_id == conversation_id
        )
    )
    return list(res.scalars().all())


async def assert_conversation_member(
    db: AsyncSession, conversation_id: str, user_id: str
) -> ConversationMember:
    res = await db.execute(
        select(ConversationMember).where(
            ConversationMember.conversation_id == conversation_id,
            ConversationMember.user_id == user_id,
        )
    )
    member = res.scalar_one_or_none()
    if not member:
        raise AppError(
            "FORBIDDEN_CONVERSATION",
            "You are not a participant of this conversation.",
            status_code=status.HTTP_403_FORBIDDEN,
        )
    return member


async def get_peer_user_ids_for_presence(db: AsyncSession, user_id: str) -> set[str]:
    my_convs = select(ConversationMember.conversation_id).where(
        ConversationMember.user_id == user_id
    )
    res = await db.execute(
        select(ConversationMember.user_id).where(
            ConversationMember.conversation_id.in_(my_convs),
            ConversationMember.user_id != user_id,
        )
    )
    return set(res.scalars().all())


async def get_or_create_direct_conversation(
    db: AsyncSession,
    current_user: User,
    peer_id: str | None = None,
    peer_username: str | None = None,
) -> ConversationOut:
    settings = get_settings()
    peer: User | None = None

    if peer_id:
        r = await db.execute(select(User).where(User.id == peer_id))
        peer = r.scalar_one_or_none()
    elif peer_username:
        peer = await resolve_user_by_identifier(db, peer_username)

    if not peer:
        raise AppError("PEER_NOT_FOUND", "Target user was not found.", status_code=404)
    if peer.id == current_user.id:
        raise AppError("SELF_CHAT_NOT_ALLOWED", "Select another user to start a 1:1 chat.")

    pair_key = ":".join(sorted([current_user.id, peer.id]))
    conv_res = await db.execute(
        select(Conversation).where(Conversation.direct_pair_key == pair_key)
    )
    conv = conv_res.scalar_one_or_none()

    if not conv:
        now = datetime.now(timezone.utc)
        conv = Conversation(
            type="direct",
            created_by_id=current_user.id,
            direct_pair_key=pair_key,
            last_message_at=now,
        )
        db.add(conv)
        await db.flush()
        db.add(
            ConversationMember(
                conversation_id=conv.id,
                user_id=current_user.id,
                role="member",
            )
        )
        db.add(
            ConversationMember(
                conversation_id=conv.id,
                user_id=peer.id,
                role="member",
            )
        )
        await db.commit()
        await db.refresh(conv)

    return await build_conversation_out(db, conv, current_user)


async def _enrich_messages_batch(
    db: AsyncSession,
    messages: list[Message],
    *,
    viewer_id: str | None = None,
) -> list[MessageOut]:
    if not messages:
        return []

    msg_ids = [m.id for m in messages]
    sender_ids = list({m.sender_id for m in messages})

    starred_ids: set[str] = set()
    if viewer_id:
        st_rows = (
            await db.execute(
                select(StarredMessage.message_id).where(
                    StarredMessage.user_id == viewer_id,
                    StarredMessage.message_id.in_(msg_ids),
                )
            )
        ).scalars().all()
        starred_ids = set(st_rows)

    users_map: dict[str, User] = {}
    if sender_ids:
        u_rows = (
            await db.execute(select(User).where(User.id.in_(sender_ids)))
        ).scalars().all()
        users_map = {u.id: u for u in u_rows}

    att_map: dict[str, str] = {}
    att_rows = (
        await db.execute(
            select(Attachment.message_id, Attachment.id).where(
                Attachment.message_id.in_(msg_ids)
            )
        )
    ).all()
    for mid, aid in att_rows:
        if mid:
            att_map[mid] = aid

    rcpt_rows = (
        await db.execute(
            select(MessageReceipt, User)
            .join(User, User.id == MessageReceipt.user_id)
            .where(MessageReceipt.message_id.in_(msg_ids))
        )
    ).all()

    read_by_map: dict[str, list[MessageReceiptEntryOut]] = {mid: [] for mid in msg_ids}
    delivered_map: dict[str, list[MessageReceiptEntryOut]] = {mid: [] for mid in msg_ids}

    for rcpt, r_user in rcpt_rows:
        entry = MessageReceiptEntryOut(
            user_id=r_user.id,
            global_id=r_user.global_id,
            display_name=r_user.display_name,
            avatar_url=r_user.avatar_url if r_user.privacy_profile_photo != "nobody" else None,
            delivered_at=rcpt.delivered_at,
            read_at=rcpt.read_at,
        )
        if rcpt.read_at is not None:
            read_by_map[rcpt.message_id].append(entry)
        elif rcpt.delivered_at is not None:
            delivered_map[rcpt.message_id].append(entry)

    out_list: list[MessageOut] = []
    for m in messages:
        mo = MessageOut.model_validate(m)
        sender_u = users_map.get(m.sender_id)
        mo.sender_display_name = sender_u.display_name if sender_u else m.sender_global_id
        mo.sender_color = deterministic_sender_color(m.sender_id)
        mo.attachment_id = att_map.get(m.id)
        mo.mentions = list(m.mentions or [])
        mo.is_starred = m.id in starred_ids
        mo.read_by = read_by_map.get(m.id, [])
        mo.delivered_to = delivered_map.get(m.id, [])
        out_list.append(mo)
    return out_list


async def build_conversation_out(
    db: AsyncSession,
    conv: Conversation,
    current_user: User,
) -> ConversationOut:
    mem_res = await db.execute(
        select(ConversationMember).where(ConversationMember.conversation_id == conv.id)
    )
    members = list(mem_res.scalars().all())
    my_member = next((m for m in members if m.user_id == current_user.id), None)

    peer_out: PeerSummaryOut | None = None
    group_out = None
    if conv.type == "direct":
        other_member = next((m for m in members if m.user_id != current_user.id), None)
        if other_member:
            u_res = await db.execute(select(User).where(User.id == other_member.user_id))
            peer_user = u_res.scalar_one_or_none()
            if peer_user:
                peer_out = await build_peer_summary_for_viewer(db, peer_user, current_user)
    elif conv.type == "group":
        group_out = await build_group_summary_out(db, conv, current_user)

    # Latest message visible to current_user (excluding expired disappearing messages)
    now_utc = datetime.now(timezone.utc)
    msg_res = await db.execute(
        select(Message)
        .where(
            Message.conversation_id == conv.id,
            or_(
                Message.expires_at.is_(None),
                Message.message_type == "live_location",
                Message.expires_at > now_utc,
            ),
        )
        .order_by(desc(Message.created_at), desc(Message.id))
        .limit(10)
    )
    recent_msgs = list(msg_res.scalars().all())
    visible_last = next(
        (m for m in recent_msgs if current_user.id not in (m.deleted_for_user_ids or [])),
        None,
    )
    enriched_last = (
        (
            await _enrich_messages_batch(
                db, [visible_last], viewer_id=current_user.id
            )
        )[0]
        if visible_last
        else None
    )

    return ConversationOut(
        id=conv.id,
        type=conv.type,
        name=group_out.name if group_out else conv.name,
        description=group_out.description if group_out else conv.description,
        icon_url=group_out.icon_url if group_out else conv.icon_url,
        peer=peer_out,
        group=group_out,
        unread_count=my_member.unread_count if my_member else 0,
        is_pinned=my_member.is_pinned if my_member else False,
        is_muted=my_member.is_muted if my_member else False,
        is_archived=my_member.is_archived if my_member else False,
        disappearing_timer_seconds=conv.disappearing_timer_seconds or 0,
        last_message_at=conv.last_message_at,
        last_message=enriched_last,
        created_at=conv.created_at,
    )


async def list_user_conversations(
    db: AsyncSession,
    current_user: User,
) -> list[ConversationOut]:
    res = await db.execute(
        select(Conversation, ConversationMember)
        .join(
            ConversationMember,
            ConversationMember.conversation_id == Conversation.id,
        )
        .where(ConversationMember.user_id == current_user.id)
        .order_by(
            desc(ConversationMember.is_pinned),
            desc(Conversation.last_message_at),
            desc(Conversation.created_at),
        )
    )
    rows = res.all()
    output: list[ConversationOut] = []
    for conv, _ in rows:
        output.append(await build_conversation_out(db, conv, current_user))
    return output


async def update_conversation_preferences(
    db: AsyncSession,
    current_user: User,
    conversation_id: str,
    is_pinned: bool | None,
    is_muted: bool | None,
    is_archived: bool | None = None,
    disappearing_timer_seconds: int | None = None,
) -> tuple[ConversationOut, list[str], bool]:
    member = await assert_conversation_member(db, conversation_id, current_user.id)
    conv_res = await db.execute(select(Conversation).where(Conversation.id == conversation_id))
    conv = conv_res.scalar_one()

    if is_pinned is not None:
        member.is_pinned = is_pinned
    if is_muted is not None:
        member.is_muted = is_muted
    if is_archived is not None:
        member.is_archived = is_archived

    timer_changed = False
    if disappearing_timer_seconds is not None:
        if conv.type == "group":
            grp = (
                await db.execute(select(Group).where(Group.id == conv.id))
            ).scalar_one_or_none()
            if grp and grp.only_admins_can_edit_info and member.role not in ("admin", "owner"):
                raise AppError(
                    "ADMIN_REQUIRED",
                    "Only group admins can update the disappearing messages timer.",
                    status_code=status.HTTP_403_FORBIDDEN,
                )
        if conv.disappearing_timer_seconds != disappearing_timer_seconds:
            conv.disappearing_timer_seconds = disappearing_timer_seconds
            conv.updated_at = datetime.now(timezone.utc)
            timer_changed = True

    await db.commit()
    member_ids = await get_conversation_member_ids(db, conversation_id)
    conv_out = await build_conversation_out(db, conv, current_user)
    return conv_out, member_ids, timer_changed


async def list_conversation_messages(
    db: AsyncSession,
    current_user: User,
    conversation_id: str,
    before: str | None = None,
    limit: int = 40,
) -> CursorMessagesOut:
    await assert_conversation_member(db, conversation_id, current_user.id)
    safe_limit = max(1, min(limit, 100))
    now_utc = datetime.now(timezone.utc)

    stmt = select(Message).where(
        Message.conversation_id == conversation_id,
        or_(
            Message.expires_at.is_(None),
            Message.message_type == "live_location",
            Message.expires_at > now_utc,
        ),
    )
    if before:
        cursor_dt, cursor_id = _decode_cursor(before)
        stmt = stmt.where(
            or_(
                Message.created_at < cursor_dt,
                and_(Message.created_at == cursor_dt, Message.id < cursor_id),
            )
        )

    stmt = stmt.order_by(desc(Message.created_at), desc(Message.id)).limit(safe_limit + 5)
    res = await db.execute(stmt)
    raw = [
        m
        for m in res.scalars().all()
        if current_user.id not in (m.deleted_for_user_ids or [])
    ]

    has_more = len(raw) > safe_limit
    sliced = raw[:safe_limit]
    # Return chronological ascending order for UI rendering
    sliced.reverse()

    next_cursor = (
        _encode_cursor(sliced[0].created_at, sliced[0].id) if has_more and sliced else None
    )
    enriched_items = await _enrich_messages_batch(
        db, sliced, viewer_id=current_user.id
    )
    return CursorMessagesOut(
        items=enriched_items,
        next_cursor=next_cursor,
        has_more=has_more,
    )


async def create_encrypted_message(
    db: AsyncSession,
    sender: User,
    body: MessageCreateRequest,
) -> tuple[MessageOut, list[str]]:
    sender_member = await assert_conversation_member(db, body.conversation_id, sender.id)
    conv = (
        await db.execute(select(Conversation).where(Conversation.id == body.conversation_id))
    ).scalar_one()

    participant_ids = await get_conversation_member_ids(db, body.conversation_id)
    if conv.type == "direct":
        await assert_not_blocked_for_messaging(db, sender.id, participant_ids)

    effective_key_version: int | None = body.sender_key_version
    if conv.type == "group":
        grp = (
            await db.execute(select(Group).where(Group.id == conv.id))
        ).scalar_one_or_none()
        if grp:
            if grp.only_admins_can_send and sender_member.role not in ("admin", "owner"):
                raise AppError(
                    "ADMIN_ONLY_MESSAGES",
                    "Only admins can send messages in this group.",
                    status_code=status.HTTP_403_FORBIDDEN,
                )
            if body.sender_key_version is None or body.sender_key_version != grp.key_version:
                raise AppError(
                    "STALE_GROUP_KEY_VERSION",
                    f"Group requires sender_key_version={grp.key_version}.",
                    status_code=status.HTTP_409_CONFLICT,
                )
            effective_key_version = grp.key_version

    # Idempotency check if client retries with same client_msg_id
    if body.client_msg_id:
        existing_res = await db.execute(
            select(Message).where(
                Message.conversation_id == body.conversation_id,
                Message.sender_id == sender.id,
                Message.client_msg_id == body.client_msg_id,
            )
        )
        existing_msg = existing_res.scalar_one_or_none()
        if existing_msg:
            member_ids = await get_conversation_member_ids(db, body.conversation_id)
            return MessageOut.model_validate(existing_msg), member_ids

    if body.reply_to_id:
        rep_res = await db.execute(
            select(Message.id).where(
                Message.id == body.reply_to_id,
                Message.conversation_id == body.conversation_id,
            )
        )
        if not rep_res.scalar_one_or_none():
            raise AppError("INVALID_REPLY_TARGET", "Replied-to message not found.", status_code=404)

    now = datetime.now(timezone.utc)
    linked_attachment: Attachment | None = None
    if body.attachment_id:
        att_res = await db.execute(
            select(Attachment).where(Attachment.id == body.attachment_id)
        )
        linked_attachment = att_res.scalar_one_or_none()
        if not linked_attachment or linked_attachment.uploader_id != sender.id:
            raise AppError(
                "ATTACHMENT_NOT_FOUND",
                "Referenced encrypted attachment was not found.",
                status_code=status.HTTP_404_NOT_FOUND,
            )
        if not linked_attachment.is_complete:
            raise AppError(
                "ATTACHMENT_INCOMPLETE",
                "Attachment upload must be completed before sending message.",
                status_code=status.HTTP_400_BAD_REQUEST,
            )

    live_expires_at: datetime | None = None
    if body.type == "live_location":
        if body.expires_at is not None:
            candidate = _ensure_utc(body.expires_at)
            max_exp = now + timedelta(hours=8, minutes=5)
            min_exp = now + timedelta(seconds=1)
            live_expires_at = min(max(candidate, min_exp), max_exp)
        else:
            live_expires_at = now + timedelta(minutes=15)
    elif body.expires_at is not None:
        candidate = _ensure_utc(body.expires_at)
        if candidate > now:
            live_expires_at = candidate
    elif (conv.disappearing_timer_seconds or 0) > 0:
        live_expires_at = now + timedelta(seconds=int(conv.disappearing_timer_seconds))

    # Normalize @mentions (accept user_id, username, or global_id of current members)
    normalized_mentions: list[str] = []
    if body.mentions:
        mem_users = (
            await db.execute(select(User).where(User.id.in_(participant_ids)))
        ).scalars().all()
        for raw_m in body.mentions:
            token = raw_m.strip().lstrip("@").lower()
            if not token:
                continue
            for mu in mem_users:
                if (
                    mu.id.lower() == token
                    or mu.username.lower() == token
                    or mu.global_id.lower() == token
                ):
                    if mu.id not in normalized_mentions:
                        normalized_mentions.append(mu.id)

    settings = get_settings()
    msg_uuid = str(__import__("uuid").uuid4())
    fed_id = f"{msg_uuid}@{settings.APP_DOMAIN.lower()}"

    msg = Message(
        id=msg_uuid,
        conversation_id=body.conversation_id,
        sender_id=sender.id,
        sender_global_id=sender.global_id,
        ciphertext=body.ciphertext,
        nonce=body.nonce,
        sender_key_version=effective_key_version,
        mentions=normalized_mentions,
        message_type=body.type,
        status="sent",
        reply_to_id=body.reply_to_id,
        client_msg_id=body.client_msg_id,
        expires_at=live_expires_at,
        federation_id=fed_id,
        created_at=now,
        updated_at=now,
    )
    db.add(msg)
    await db.flush()
    metrics_registry.inc_counter("messages_relayed_total", 1)

    att_fed_payload: dict[str, Any] | None = None
    if linked_attachment is not None:
        linked_attachment.message_id = msg.id
        linked_attachment.conversation_id = body.conversation_id
        att_fed_payload = {
            "id": linked_attachment.id,
            "origin_domain": settings.APP_DOMAIN.lower(),
            "encrypted_filename": linked_attachment.encrypted_filename,
            "mime_type": linked_attachment.mime_type,
            "total_size": linked_attachment.total_size,
            "ciphertext_size": linked_attachment.ciphertext_size,
            "chunk_size": linked_attachment.chunk_size,
            "chunk_count": linked_attachment.chunk_count,
            "file_nonce": linked_attachment.file_nonce,
            "thumbnail_ciphertext": linked_attachment.thumbnail_ciphertext,
            "thumbnail_nonce": linked_attachment.thumbnail_nonce,
            "sha256_ciphertext": linked_attachment.sha256_ciphertext,
            "remote_download_url": (
                f"{settings.NODE_PUBLIC_URL.rstrip('/')}/federation/attachments/"
                f"{linked_attachment.id}/download"
            ),
        }

    if body.type == "live_location" and live_expires_at is not None:
        db.add(
            LiveLocationSession(
                message_id=msg.id,
                conversation_id=body.conversation_id,
                sender_id=sender.id,
                ciphertext=body.ciphertext,
                nonce=body.nonce,
                is_active=True,
                expires_at=live_expires_at,
                created_at=now,
                updated_at=now,
            )
        )

    mem_res = await db.execute(
        select(ConversationMember).where(
            ConversationMember.conversation_id == body.conversation_id
        )
    )
    members = list(mem_res.scalars().all())
    member_ids: list[str] = []

    for m in members:
        member_ids.append(m.user_id)
        if m.user_id != sender.id:
            m.unread_count = (m.unread_count or 0) + 1
            db.add(
                MessageReceipt(
                    message_id=msg.id,
                    user_id=m.user_id,
                    created_at=now,
                )
            )

    conv_res = await db.execute(
        select(Conversation).where(Conversation.id == body.conversation_id)
    )
    conv = conv_res.scalar_one()
    conv.last_message_at = now

    # Enqueue S2S federation delivery for any remote conversation members
    member_users = list(
        (await db.execute(select(User).where(User.id.in_(member_ids)))).scalars().all()
    )
    remote_recipients = [
        u for u in member_users if not u.is_local and u.id != sender.id
    ]
    queued_remote = False
    if remote_recipients:
        users_by_id = {u.id: u for u in member_users}
        mentions_gids = [
            users_by_id[mid].global_id
            for mid in normalized_mentions
            if mid in users_by_id
        ]
        base_msg_data: dict[str, Any] = {
            "message_id": msg.id,
            "federation_id": fed_id,
            "conversation_id": conv.id,
            "conversation_type": conv.type,
            "sender_global_id": sender.global_id,
            "ciphertext": msg.ciphertext,
            "nonce": msg.nonce,
            "sender_key_version": effective_key_version,
            "mentions_global_ids": mentions_gids,
            "type": msg.message_type,
            "reply_to_id": msg.reply_to_id,
            "client_msg_id": msg.client_msg_id,
            "expires_at": live_expires_at.isoformat() if live_expires_at else None,
            "created_at": now.isoformat(),
            "attachment": att_fed_payload,
        }
        if conv.type == "direct":
            for ru in remote_recipients:
                q_item = await enqueue_federation_event(
                    db,
                    target_domain=ru.domain,
                    event_type="message",
                    data={**base_msg_data, "peer_global_id": ru.global_id},
                    commit=False,
                )
                if q_item is not None:
                    queued_remote = True
        else:
            grp_snap = await build_federation_group_snapshot(db, conv.id)
            q_items = await enqueue_for_remote_users(
                db,
                remote_recipients,
                event_type="message",
                data={**base_msg_data, "group_snapshot": grp_snap},
                commit=False,
            )
            if q_items:
                queued_remote = True

    linked_att_id = linked_attachment.id if linked_attachment is not None else None
    await db.commit()
    if queued_remote:
        trigger_outbox_wakeup()
    await db.refresh(msg)
    enriched = (await _enrich_messages_batch(db, [msg]))[0]
    if linked_att_id:
        enriched.attachment_id = linked_att_id
    return enriched, member_ids


async def acknowledge_messages(
    db: AsyncSession,
    actor: User,
    conversation_id: str,
    target_status: str,
    message_ids: list[str] | None = None,
) -> list[tuple[MessageOut, str]]:
    """Marks incoming messages as delivered or read and returns [(MessageOut, sender_id), ...]."""
    my_member = await assert_conversation_member(db, conversation_id, actor.id)
    conv = (
        await db.execute(select(Conversation).where(Conversation.id == conversation_id))
    ).scalar_one()
    now = datetime.now(timezone.utc)

    stmt = select(Message).where(
        Message.conversation_id == conversation_id,
        Message.sender_id != actor.id,
        Message.message_type != "system",
        Message.deleted_for_everyone.is_(False),
    )
    if message_ids:
        stmt = stmt.where(Message.id.in_(message_ids))
    else:
        stmt = stmt.where(Message.status != "read")

    res = await db.execute(stmt)
    candidates = list(res.scalars().all())

    sender_read_allowed_cache: dict[str, bool] = {}
    changed_msgs: list[Message] = []

    for msg in candidates:
        can_emit_read = True
        if target_status == "read":
            if msg.sender_id not in sender_read_allowed_cache:
                sender_read_allowed_cache[msg.sender_id] = await can_actor_emit_read_receipt(
                    db, actor, msg.sender_id
                )
            can_emit_read = sender_read_allowed_cache[msg.sender_id]

        effective_msg_status = (
            "read" if (target_status == "read" and can_emit_read) else "delivered"
        )

        rcpt_res = await db.execute(
            select(MessageReceipt).where(
                MessageReceipt.message_id == msg.id,
                MessageReceipt.user_id == actor.id,
            )
        )
        rcpt = rcpt_res.scalar_one_or_none()
        if not rcpt:
            rcpt = MessageReceipt(message_id=msg.id, user_id=actor.id, created_at=now)
            db.add(rcpt)
            await db.flush()

        rcpt_changed = False
        if rcpt.delivered_at is None:
            rcpt.delivered_at = now
            rcpt_changed = True
        if effective_msg_status == "read" and rcpt.read_at is None:
            rcpt.read_at = now
            rcpt_changed = True

        if conv.type == "group":
            await db.flush()
            all_rcpts = list(
                (
                    await db.execute(
                        select(MessageReceipt).where(MessageReceipt.message_id == msg.id)
                    )
                )
                .scalars()
                .all()
            )
            if all_rcpts and all(r.read_at is not None for r in all_rcpts):
                agg_status = "read"
            elif any(r.delivered_at is not None for r in all_rcpts):
                agg_status = "delivered"
            else:
                agg_status = "sent"

            if (
                STATUS_RANK.get(agg_status, 1) > STATUS_RANK.get(msg.status, 1)
                or rcpt_changed
            ):
                if STATUS_RANK.get(agg_status, 1) > STATUS_RANK.get(msg.status, 1):
                    msg.status = agg_status
                if msg.delivered_at is None and agg_status in ("delivered", "read"):
                    msg.delivered_at = now
                if agg_status == "read" and msg.read_at is None:
                    msg.read_at = now
                msg.updated_at = now
                changed_msgs.append(msg)
        else:
            if STATUS_RANK.get(effective_msg_status, 1) > STATUS_RANK.get(msg.status, 1):
                msg.status = effective_msg_status
                if msg.delivered_at is None:
                    msg.delivered_at = now
                if effective_msg_status == "read" and msg.read_at is None:
                    msg.read_at = now
                msg.updated_at = now
                changed_msgs.append(msg)

    if target_status == "read":
        my_member.unread_count = 0
        if candidates:
            my_member.last_read_message_id = candidates[-1].id

    # Enqueue S2S receipt events back to remote message senders
    remote_receipt_queued = False
    if changed_msgs:
        sender_ids_set = {m.sender_id for m in changed_msgs}
        sender_users = {
            u.id: u
            for u in (
                await db.execute(select(User).where(User.id.in_(sender_ids_set)))
            )
            .scalars()
            .all()
        }
        for m in changed_msgs:
            su = sender_users.get(m.sender_id)
            if su and not su.is_local:
                can_read = sender_read_allowed_cache.get(m.sender_id, True)
                emitted_status = (
                    "read" if (target_status == "read" and can_read) else "delivered"
                )
                q_item = await enqueue_federation_event(
                    db,
                    target_domain=su.domain,
                    event_type="receipt",
                    data={
                        "message_id": m.id,
                        "federation_id": m.federation_id,
                        "conversation_id": conv.id,
                        "conversation_type": conv.type,
                        "actor_global_id": actor.global_id,
                        "status": emitted_status,
                        "delivered_at": now.isoformat(),
                        "read_at": now.isoformat() if emitted_status == "read" else None,
                    },
                    commit=False,
                )
                if q_item is not None:
                    remote_receipt_queued = True

    await db.commit()
    if remote_receipt_queued:
        trigger_outbox_wakeup()
    enriched_list = await _enrich_messages_batch(db, changed_msgs)
    return [(mo, mo.sender_id) for mo in enriched_list]


async def flush_offline_queue_and_resume(
    db: AsyncSession,
    user: User,
    since_iso: str | None = None,
) -> tuple[list[dict[str, Any]], list[tuple[str, dict[str, Any]]]]:
    """
    Called when `user` connects/reconnects to /ws:
    1. Finds all undelivered incoming messages (queued while offline), prepares `message.new`
       events for `user`, marks them `delivered`, and prepares `message.ack` events for senders.
    2. If `since_iso` is supplied, also replays missed updates/acks/deletes since `since_iso`.
    Returns: (events_for_reconnecting_user, [(target_sender_id, ack_event), ...])
    """
    my_convs_res = await db.execute(
        select(ConversationMember.conversation_id).where(
            ConversationMember.user_id == user.id
        )
    )
    conv_ids = list(my_convs_res.scalars().all())
    if not conv_ids:
        return [], []

    user_events: list[dict[str, Any]] = []
    sender_notifications: list[tuple[str, dict[str, Any]]] = []
    delivered_msg_ids: set[str] = set()
    now = datetime.now(timezone.utc)

    # 1. Queued undelivered messages while offline (supports both 1:1 and multi-user group receipts!)
    queued_res = await db.execute(
        select(Message)
        .outerjoin(
            MessageReceipt,
            and_(
                MessageReceipt.message_id == Message.id,
                MessageReceipt.user_id == user.id,
            ),
        )
        .where(
            Message.conversation_id.in_(conv_ids),
            Message.sender_id != user.id,
            Message.message_type != "system",
            Message.deleted_for_everyone.is_(False),
            or_(
                MessageReceipt.id.is_(None),
                MessageReceipt.delivered_at.is_(None),
            ),
        )
        .order_by(Message.created_at.asc())
    )
    queued_messages = list(queued_res.scalars().all())

    for msg in queued_messages:
        if user.id in (msg.deleted_for_user_ids or []):
            continue
        if msg.status == "sent":
            msg.status = "delivered"
        msg.delivered_at = msg.delivered_at or now
        msg.updated_at = now

        rcpt_res = await db.execute(
            select(MessageReceipt).where(
                MessageReceipt.message_id == msg.id,
                MessageReceipt.user_id == user.id,
            )
        )
        rcpt = rcpt_res.scalar_one_or_none()
        if rcpt:
            rcpt.delivered_at = rcpt.delivered_at or now
        else:
            db.add(
                MessageReceipt(
                    message_id=msg.id,
                    user_id=user.id,
                    delivered_at=now,
                    created_at=now,
                )
            )
        await db.flush()

        msg_out = (await _enrich_messages_batch(db, [msg]))[0]
        delivered_msg_ids.add(msg.id)
        user_events.append(
            {
                "event": "message.new",
                "data": msg_out.model_dump(mode="json"),
                "ts": now.isoformat(),
            }
        )
        sender_notifications.append(
            (
                msg.sender_id,
                {
                    "event": "message.ack",
                    "data": {
                        "conversation_id": msg.conversation_id,
                        "message_id": msg.id,
                        "status": msg.status,
                        "delivered_at": now.isoformat(),
                        "read_by": [r.model_dump(mode="json") for r in msg_out.read_by],
                        "delivered_to": [
                            d.model_dump(mode="json") for d in msg_out.delivered_to
                        ],
                    },
                    "ts": now.isoformat(),
                },
            )
        )

    # 2. Resume missed events since `since_iso` (acks on my outgoing messages, edits, deletes)
    if since_iso:
        try:
            since_dt = _ensure_utc(datetime.fromisoformat(since_iso))
            missed_res = await db.execute(
                select(Message)
                .where(
                    Message.conversation_id.in_(conv_ids),
                    Message.updated_at >= since_dt,
                )
                .order_by(Message.updated_at.asc())
                .limit(200)
            )
            for m in missed_res.scalars().all():
                if m.id in delivered_msg_ids or user.id in (m.deleted_for_user_ids or []):
                    continue
                m_dump = MessageOut.model_validate(m).model_dump(mode="json")
                if m.deleted_for_everyone:
                    user_events.append(
                        {"event": "message.deleted", "data": m_dump, "ts": now.isoformat()}
                    )
                elif m.edited_at and _ensure_utc(m.edited_at) >= since_dt:
                    user_events.append(
                        {"event": "message.updated", "data": m_dump, "ts": now.isoformat()}
                    )
                elif m.sender_id == user.id:
                    user_events.append(
                        {
                            "event": "message.ack",
                            "data": {
                                "conversation_id": m.conversation_id,
                                "message_id": m.id,
                                "status": m.status,
                                "delivered_at": m.delivered_at.isoformat() if m.delivered_at else None,
                                "read_at": m.read_at.isoformat() if m.read_at else None,
                            },
                            "ts": now.isoformat(),
                        }
                    )
                else:
                    user_events.append(
                        {"event": "message.new", "data": m_dump, "ts": now.isoformat()}
                    )
        except ValueError:
            pass

    if queued_messages:
        q_sender_ids = {m.sender_id for m in queued_messages}
        q_senders = {
            u.id: u
            for u in (
                await db.execute(select(User).where(User.id.in_(q_sender_ids)))
            )
            .scalars()
            .all()
        }
        remote_flushed = False
        for m in queued_messages:
            if m.id not in delivered_msg_ids:
                continue
            su = q_senders.get(m.sender_id)
            if su and not su.is_local:
                q_item = await enqueue_federation_event(
                    db,
                    target_domain=su.domain,
                    event_type="receipt",
                    data={
                        "message_id": m.id,
                        "federation_id": m.federation_id,
                        "conversation_id": m.conversation_id,
                        "actor_global_id": user.global_id,
                        "status": "delivered",
                        "delivered_at": now.isoformat(),
                        "read_at": None,
                    },
                    commit=False,
                )
                if q_item is not None:
                    remote_flushed = True
        await db.commit()
        if remote_flushed:
            trigger_outbox_wakeup()

    return user_events, sender_notifications


async def edit_encrypted_message(
    db: AsyncSession,
    actor: User,
    message_id: str,
    ciphertext: str,
    nonce: str,
) -> tuple[MessageOut, list[str]]:
    res = await db.execute(select(Message).where(Message.id == message_id))
    msg = res.scalar_one_or_none()
    if not msg:
        raise AppError("MESSAGE_NOT_FOUND", "Message not found.", status_code=404)
    if msg.sender_id != actor.id:
        raise AppError(
            "FORBIDDEN",
            "Only the sender can edit a message.",
            status_code=status.HTTP_403_FORBIDDEN,
        )
    if msg.deleted_for_everyone:
        raise AppError("MESSAGE_DELETED", "Cannot edit a deleted message.", status_code=400)

    now = datetime.now(timezone.utc)
    created_utc = _ensure_utc(msg.created_at)
    if now - created_utc > timedelta(minutes=EDIT_WINDOW_MINUTES):
        raise AppError(
            "EDIT_WINDOW_EXPIRED",
            f"Messages can only be edited within {EDIT_WINDOW_MINUTES} minutes of sending.",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    msg.ciphertext = ciphertext
    msg.nonce = nonce
    msg.edited_at = now
    msg.updated_at = now

    member_ids = await get_conversation_member_ids(db, msg.conversation_id)
    mem_users = list(
        (await db.execute(select(User).where(User.id.in_(member_ids)))).scalars().all()
    )
    remote_Queued = await enqueue_for_remote_users(
        db,
        [u for u in mem_users if u.id != actor.id],
        event_type="message.edit",
        data={
            "message_id": msg.id,
            "federation_id": msg.federation_id,
            "conversation_id": msg.conversation_id,
            "sender_global_id": actor.global_id,
            "ciphertext": ciphertext,
            "nonce": nonce,
            "edited_at": now.isoformat(),
        },
        commit=False,
    )
    await db.commit()
    if remote_Queued:
        trigger_outbox_wakeup()
    await db.refresh(msg)

    return MessageOut.model_validate(msg), member_ids


async def delete_encrypted_message(
    db: AsyncSession,
    actor: User,
    message_id: str,
    scope: str,
) -> tuple[MessageOut, list[str], str]:
    res = await db.execute(select(Message).where(Message.id == message_id))
    msg = res.scalar_one_or_none()
    if not msg:
        raise AppError("MESSAGE_NOT_FOUND", "Message not found.", status_code=404)

    await assert_conversation_member(db, msg.conversation_id, actor.id)
    now = datetime.now(timezone.utc)

    if scope == "everyone":
        if msg.sender_id != actor.id:
            raise AppError(
                "FORBIDDEN",
                "Only the sender can delete a message for everyone.",
                status_code=status.HTTP_403_FORBIDDEN,
            )
        msg.deleted_for_everyone = True
        msg.deleted_at = now
        msg.ciphertext = ""
        msg.nonce = ""
        msg.updated_at = now
        member_ids = await get_conversation_member_ids(db, msg.conversation_id)
        mem_users = list(
            (await db.execute(select(User).where(User.id.in_(member_ids)))).scalars().all()
        )
        remote_del = await enqueue_for_remote_users(
            db,
            [u for u in mem_users if u.id != actor.id],
            event_type="message.delete",
            data={
                "message_id": msg.id,
                "federation_id": msg.federation_id,
                "conversation_id": msg.conversation_id,
                "sender_global_id": actor.global_id,
                "scope": "everyone",
            },
            commit=False,
        )
        await db.commit()
        if remote_del:
            trigger_outbox_wakeup()
        await db.refresh(msg)
        return MessageOut.model_validate(msg), member_ids, "everyone"

    # scope == "me"
    existing_deleted = list(msg.deleted_for_user_ids or [])
    if actor.id not in existing_deleted:
        existing_deleted.append(actor.id)
        msg.deleted_for_user_ids = existing_deleted
        await db.commit()
        await db.refresh(msg)
    return MessageOut.model_validate(msg), [actor.id], "me"


async def update_live_location_message(
    db: AsyncSession,
    *,
    actor: User,
    message_id: str,
    ciphertext: str,
    nonce: str,
) -> tuple[MessageOut, list[str]]:
    res = await db.execute(select(Message).where(Message.id == message_id))
    msg = res.scalar_one_or_none()
    if not msg or msg.message_type != "live_location":
        raise AppError(
            "LIVE_LOCATION_NOT_FOUND",
            "Live location message not found.",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    if msg.sender_id != actor.id:
        raise AppError(
            "FORBIDDEN",
            "Only the sender can update their live location.",
            status_code=status.HTTP_403_FORBIDDEN,
        )

    member_ids = await get_conversation_member_ids(db, msg.conversation_id)
    await assert_not_blocked_for_messaging(db, actor.id, member_ids)

    now = datetime.now(timezone.utc)
    sess_res = await db.execute(
        select(LiveLocationSession).where(LiveLocationSession.message_id == message_id)
    )
    sess = sess_res.scalar_one_or_none()

    exp = _ensure_utc(msg.expires_at) if msg.expires_at else None
    if (sess and not sess.is_active) or (exp is not None and now >= exp):
        if sess and sess.is_active:
            sess.is_active = False
            sess.updated_at = now
            await db.commit()
        raise AppError(
            "LIVE_LOCATION_EXPIRED",
            "Live location sharing session has ended or expired.",
            status_code=status.HTTP_410_GONE,
        )

    msg.ciphertext = ciphertext
    msg.nonce = nonce
    msg.updated_at = now
    if sess:
        sess.ciphertext = ciphertext
        sess.nonce = nonce
        sess.updated_at = now

    await db.commit()
    await db.refresh(msg)
    return MessageOut.model_validate(msg), member_ids


async def stop_live_location_message(
    db: AsyncSession,
    *,
    actor: User,
    message_id: str,
    ciphertext: str | None = None,
    nonce: str | None = None,
) -> tuple[MessageOut, list[str]]:
    res = await db.execute(select(Message).where(Message.id == message_id))
    msg = res.scalar_one_or_none()
    if not msg or msg.message_type != "live_location":
        raise AppError(
            "LIVE_LOCATION_NOT_FOUND",
            "Live location message not found.",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    if msg.sender_id != actor.id:
        raise AppError(
            "FORBIDDEN",
            "Only the sender can stop live location sharing.",
            status_code=status.HTTP_403_FORBIDDEN,
        )

    now = datetime.now(timezone.utc)
    if ciphertext and nonce:
        msg.ciphertext = ciphertext
        msg.nonce = nonce
    msg.expires_at = now
    msg.updated_at = now

    sess_res = await db.execute(
        select(LiveLocationSession).where(LiveLocationSession.message_id == message_id)
    )
    sess = sess_res.scalar_one_or_none()
    if sess:
        sess.is_active = False
        sess.expires_at = now
        if ciphertext and nonce:
            sess.ciphertext = ciphertext
            sess.nonce = nonce
        sess.updated_at = now

    await db.commit()
    await db.refresh(msg)
    member_ids = await get_conversation_member_ids(db, msg.conversation_id)
    enriched = (await _enrich_messages_batch(db, [msg]))[0]
    return enriched, member_ids


async def get_message_receipts_detail(
    db: AsyncSession,
    current_user: User,
    message_id: str,
) -> dict[str, Any]:
    msg = (await db.execute(select(Message).where(Message.id == message_id))).scalar_one_or_none()
    if not msg:
        raise AppError("MESSAGE_NOT_FOUND", "Message not found.", status_code=404)
    await assert_conversation_member(db, msg.conversation_id, current_user.id)
    enriched = (await _enrich_messages_batch(db, [msg]))[0]
    return {
        "message_id": msg.id,
        "conversation_id": msg.conversation_id,
        "status": msg.status,
        "read_by": [r.model_dump(mode="json") for r in enriched.read_by],
        "delivered_to": [d.model_dump(mode="json") for d in enriched.delivered_to],
    }


async def get_unmuted_mentioned_user_ids(
    db: AsyncSession,
    conversation_id: str,
    sender_id: str,
    mentioned_user_ids: list[str],
) -> tuple[str, list[str]]:
    if not mentioned_user_ids:
        return "", []
    conv = (
        await db.execute(select(Conversation).where(Conversation.id == conversation_id))
    ).scalar_one_or_none()
    if not conv:
        return "", []
    rows = (
        await db.execute(
            select(ConversationMember).where(
                ConversationMember.conversation_id == conversation_id,
                ConversationMember.user_id.in_(mentioned_user_ids),
                ConversationMember.user_id != sender_id,
                ConversationMember.is_muted.is_(False),
            )
        )
    ).scalars().all()
    return (conv.name or "Group"), [r.user_id for r in rows]


async def star_encrypted_message(
    db: AsyncSession,
    current_user: User,
    message_id: str,
) -> dict[str, Any]:
    msg = (await db.execute(select(Message).where(Message.id == message_id))).scalar_one_or_none()
    if not msg or msg.deleted_for_everyone or current_user.id in (msg.deleted_for_user_ids or []):
        raise AppError("MESSAGE_NOT_FOUND", "Message not found.", status_code=404)
    await assert_conversation_member(db, msg.conversation_id, current_user.id)

    existing = (
        await db.execute(
            select(StarredMessage).where(
                StarredMessage.user_id == current_user.id,
                StarredMessage.message_id == msg.id,
            )
        )
    ).scalar_one_or_none()
    now = datetime.now(timezone.utc)
    if not existing:
        db.add(
            StarredMessage(
                user_id=current_user.id,
                message_id=msg.id,
                conversation_id=msg.conversation_id,
                created_at=now,
            )
        )
        await db.commit()
    return {"message_id": msg.id, "conversation_id": msg.conversation_id, "is_starred": True}


async def unstar_encrypted_message(
    db: AsyncSession,
    current_user: User,
    message_id: str,
) -> dict[str, Any]:
    rows = list(
        (
            await db.execute(
                select(StarredMessage).where(
                    StarredMessage.user_id == current_user.id,
                    StarredMessage.message_id == message_id,
                )
            )
        ).scalars().all()
    )
    for row in rows:
        await db.delete(row)
    await db.commit()
    return {"message_id": message_id, "is_starred": False}


async def list_starred_messages(
    db: AsyncSession,
    current_user: User,
    limit: int = 100,
) -> list[StarredMessageOut]:
    now_utc = datetime.now(timezone.utc)
    rows = (
        await db.execute(
            select(StarredMessage, Message, Conversation)
            .join(Message, Message.id == StarredMessage.message_id)
            .join(Conversation, Conversation.id == StarredMessage.conversation_id)
            .where(
                StarredMessage.user_id == current_user.id,
                Message.deleted_for_everyone.is_(False),
                or_(
                    Message.expires_at.is_(None),
                    Message.message_type == "live_location",
                    Message.expires_at > now_utc,
                ),
            )
            .order_by(desc(StarredMessage.created_at))
            .limit(max(1, min(limit, 200)))
        )
    ).all()
    filtered = [
        (st, m, conv)
        for st, m, conv in rows
        if current_user.id not in (m.deleted_for_user_ids or [])
    ]
    if not filtered:
        return []

    enriched_map = {
        mo.id: mo
        for mo in await _enrich_messages_batch(
            db, [m for _, m, _ in filtered], viewer_id=current_user.id
        )
    }
    out: list[StarredMessageOut] = []
    for st, m, conv in filtered:
        mo = enriched_map.get(m.id)
        if not mo:
            continue
        out.append(
            StarredMessageOut(
                starred_at=st.created_at,
                conversation_id=conv.id,
                conversation_name=conv.name,
                message=mo,
            )
        )
    return out


