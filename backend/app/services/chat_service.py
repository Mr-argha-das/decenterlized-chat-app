import base64
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import status
from sqlalchemy import and_, desc, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import AppError
from app.models.entities import (
    Conversation,
    ConversationMember,
    Message,
    MessageReceipt,
    User,
)
from app.schemas.chat import (
    ConversationOut,
    CursorMessagesOut,
    MessageCreateRequest,
    MessageOut,
    PeerSummaryOut,
)
from app.services.federation_hook import resolve_user_by_identifier
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
    if conv.type == "direct":
        other_member = next((m for m in members if m.user_id != current_user.id), None)
        if other_member:
            u_res = await db.execute(select(User).where(User.id == other_member.user_id))
            peer_user = u_res.scalar_one_or_none()
            if peer_user:
                peer_out = await build_peer_summary_for_viewer(db, peer_user, current_user)

    # Latest message visible to current_user
    msg_res = await db.execute(
        select(Message)
        .where(Message.conversation_id == conv.id)
        .order_by(desc(Message.created_at), desc(Message.id))
        .limit(10)
    )
    recent_msgs = list(msg_res.scalars().all())
    visible_last = next(
        (m for m in recent_msgs if current_user.id not in (m.deleted_for_user_ids or [])),
        None,
    )

    return ConversationOut(
        id=conv.id,
        type=conv.type,
        name=conv.name,
        icon_url=conv.icon_url,
        peer=peer_out,
        unread_count=my_member.unread_count if my_member else 0,
        is_pinned=my_member.is_pinned if my_member else False,
        is_muted=my_member.is_muted if my_member else False,
        last_message_at=conv.last_message_at,
        last_message=MessageOut.model_validate(visible_last) if visible_last else None,
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
) -> ConversationOut:
    member = await assert_conversation_member(db, conversation_id, current_user.id)
    if is_pinned is not None:
        member.is_pinned = is_pinned
    if is_muted is not None:
        member.is_muted = is_muted
    await db.commit()

    conv_res = await db.execute(select(Conversation).where(Conversation.id == conversation_id))
    conv = conv_res.scalar_one()
    return await build_conversation_out(db, conv, current_user)


async def list_conversation_messages(
    db: AsyncSession,
    current_user: User,
    conversation_id: str,
    before: str | None = None,
    limit: int = 40,
) -> CursorMessagesOut:
    await assert_conversation_member(db, conversation_id, current_user.id)
    safe_limit = max(1, min(limit, 100))

    stmt = select(Message).where(Message.conversation_id == conversation_id)
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
    return CursorMessagesOut(
        items=[MessageOut.model_validate(m) for m in sliced],
        next_cursor=next_cursor,
        has_more=has_more,
    )


async def create_encrypted_message(
    db: AsyncSession,
    sender: User,
    body: MessageCreateRequest,
) -> tuple[MessageOut, list[str]]:
    await assert_conversation_member(db, body.conversation_id, sender.id)
    participant_ids = await get_conversation_member_ids(db, body.conversation_id)
    await assert_not_blocked_for_messaging(db, sender.id, participant_ids)

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
    msg = Message(
        conversation_id=body.conversation_id,
        sender_id=sender.id,
        sender_global_id=sender.global_id,
        ciphertext=body.ciphertext,
        nonce=body.nonce,
        message_type=body.type,
        status="sent",
        reply_to_id=body.reply_to_id,
        client_msg_id=body.client_msg_id,
        created_at=now,
        updated_at=now,
    )
    db.add(msg)
    await db.flush()

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

    await db.commit()
    await db.refresh(msg)
    return MessageOut.model_validate(msg), member_ids


async def acknowledge_messages(
    db: AsyncSession,
    actor: User,
    conversation_id: str,
    target_status: str,
    message_ids: list[str] | None = None,
) -> list[tuple[MessageOut, str]]:
    """Marks incoming messages as delivered or read and returns [(MessageOut, sender_id), ...]."""
    my_member = await assert_conversation_member(db, conversation_id, actor.id)
    now = datetime.now(timezone.utc)

    stmt = select(Message).where(
        Message.conversation_id == conversation_id,
        Message.sender_id != actor.id,
        Message.deleted_for_everyone.is_(False),
    )
    if message_ids:
        stmt = stmt.where(Message.id.in_(message_ids))
    else:
        stmt = stmt.where(Message.status != "read")

    res = await db.execute(stmt)
    candidates = list(res.scalars().all())

    sender_read_allowed_cache: dict[str, bool] = {}
    updated: list[tuple[MessageOut, str]] = []
    for msg in candidates:
        effective_msg_status = target_status
        if target_status == "read":
            if msg.sender_id not in sender_read_allowed_cache:
                sender_read_allowed_cache[msg.sender_id] = await can_actor_emit_read_receipt(
                    db, actor, msg.sender_id
                )
            if not sender_read_allowed_cache[msg.sender_id]:
                effective_msg_status = "delivered"

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

        changed = False
        if rcpt.delivered_at is None:
            rcpt.delivered_at = now
        if target_status == "read" and rcpt.read_at is None:
            rcpt.read_at = now

        if STATUS_RANK.get(effective_msg_status, 1) > STATUS_RANK.get(msg.status, 1):
            msg.status = effective_msg_status
            if msg.delivered_at is None:
                msg.delivered_at = now
            if effective_msg_status == "read" and msg.read_at is None:
                msg.read_at = now
            msg.updated_at = now
            changed = True

        if changed:
            updated.append((MessageOut.model_validate(msg), msg.sender_id))

    if target_status == "read":
        my_member.unread_count = 0
        if candidates:
            my_member.last_read_message_id = candidates[-1].id

    await db.commit()
    return updated


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

    # 1. Queued undelivered messages while offline
    queued_res = await db.execute(
        select(Message)
        .where(
            Message.conversation_id.in_(conv_ids),
            Message.sender_id != user.id,
            Message.status == "sent",
            Message.deleted_for_everyone.is_(False),
        )
        .order_by(Message.created_at.asc())
    )
    queued_messages = list(queued_res.scalars().all())

    for msg in queued_messages:
        if user.id in (msg.deleted_for_user_ids or []):
            continue
        msg.status = "delivered"
        msg.delivered_at = now
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

        msg_out = MessageOut.model_validate(msg)
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
                        "status": "delivered",
                        "delivered_at": now.isoformat(),
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
        await db.commit()

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
    await db.commit()
    await db.refresh(msg)

    member_ids = await get_conversation_member_ids(db, msg.conversation_id)
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
        await db.commit()
        await db.refresh(msg)
        member_ids = await get_conversation_member_ids(db, msg.conversation_id)
        return MessageOut.model_validate(msg), member_ids, "everyone"

    # scope == "me"
    existing_deleted = list(msg.deleted_for_user_ids or [])
    if actor.id not in existing_deleted:
        existing_deleted.append(actor.id)
        msg.deleted_for_user_ids = existing_deleted
        await db.commit()
        await db.refresh(msg)
    return MessageOut.model_validate(msg), [actor.id], "me"
