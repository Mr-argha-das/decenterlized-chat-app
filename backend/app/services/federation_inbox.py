"""
Phase 8 Federation Inbox Event Processor (`POST /federation/inbox`).
Processes Ed25519-authenticated server-to-server events:
- `message` (1:1 & group E2EE ciphertext + remote attachment metadata)
- `message.edit` & `message.delete`
- `location.live_update` & `location.live_stop`
- `receipt` (delivery & read receipts propagated back to remote senders)
- `typing` (`typing.start` / `typing.stop`)
- `presence` (privacy-aware `presence.online` / `presence.offline`)
- `group.sync`, `group.member_removed`, `group.sender_keys`
- `call.signal` (1:1 WebRTC offer / answer / ICE candidate / hangup / decline)
"""
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import status
from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import AppError
from app.models.entities import (
    Attachment,
    CallLog,
    Conversation,
    ConversationMember,
    Group,
    GroupKey,
    LiveLocationSession,
    Message,
    MessageReceipt,
    User,
)
from app.schemas.federation import FederationInboxEnvelope
from app.services.chat_service import (
    STATUS_RANK,
    _enrich_messages_batch,
    get_unmuted_mentioned_user_ids,
)
from app.services.federation_hook import parse_user_identifier, resolve_user_by_identifier
from app.services.federation_service import enqueue_federation_event
from app.services.group_service import (
    SYSTEM_NONCE_B64,
    deterministic_sender_color,
    get_group_detail,
)
from app.services.privacy_service import assert_not_blocked_for_messaging
from app.services.realtime import ws_manager


def _parse_iso_dt(val: Any) -> datetime | None:
    if not val:
        return None
    if isinstance(val, datetime):
        return val if val.tzinfo else val.replace(tzinfo=timezone.utc)
    try:
        dt = datetime.fromisoformat(str(val).replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None


async def _resolve_verified_origin_actor(
    db: AsyncSession,
    raw_global_id: str,
    origin_domain: str,
) -> User:
    """Ensure actor's domain matches the authenticated origin node domain (anti-spoofing)."""
    _, actor_domain = parse_user_identifier(raw_global_id)
    if actor_domain.lower() != origin_domain.lower():
        raise AppError(
            "FEDERATION_ACTOR_SPOOFED",
            f"Origin '{origin_domain}' cannot emit events on behalf of '{raw_global_id}'.",
            status_code=status.HTTP_403_FORBIDDEN,
        )
    return await resolve_user_by_identifier(db, raw_global_id)


async def _find_or_create_direct_conv(
    db: AsyncSession,
    user_a: User,
    user_b: User,
    now: datetime,
) -> Conversation:
    pair_key = ":".join(sorted([user_a.id, user_b.id]))
    conv = (
        await db.execute(
            select(Conversation).where(Conversation.direct_pair_key == pair_key)
        )
    ).scalar_one_or_none()
    if conv:
        return conv

    conv = Conversation(
        type="direct",
        created_by_id=user_a.id,
        direct_pair_key=pair_key,
        last_message_at=now,
        created_at=now,
        updated_at=now,
    )
    db.add(conv)
    await db.flush()
    db.add(ConversationMember(conversation_id=conv.id, user_id=user_a.id, role="member"))
    db.add(ConversationMember(conversation_id=conv.id, user_id=user_b.id, role="member"))
    await db.flush()
    return conv


async def _sync_group_snapshot_from_federation(
    db: AsyncSession,
    snapshot: dict[str, Any],
    origin_domain: str,
) -> tuple[Conversation, Group, list[User]]:
    """Upsert federated group conversation, metadata, and member roster on receiving node."""
    now = datetime.now(timezone.utc)
    group_id = str(snapshot.get("group_id") or snapshot.get("id") or "").strip()
    if not group_id:
        raise AppError("INVALID_GROUP_PAYLOAD", "Missing group_id in group federation payload.")

    name = str(snapshot.get("name") or "Federated Group")[:100]
    description = str(snapshot.get("description") or "")[:500]
    icon_url = str(snapshot["icon_url"])[:512] if snapshot.get("icon_url") else None
    key_version = int(snapshot.get("key_version") or 1)
    only_admins_can_send = bool(snapshot.get("only_admins_can_send", False))
    only_admins_can_edit_info = bool(snapshot.get("only_admins_can_edit_info", True))

    creator_gid = str(snapshot.get("created_by_global_id") or "").strip()
    creator_user: User | None = None
    if creator_gid:
        try:
            creator_user = await resolve_user_by_identifier(db, creator_gid)
        except Exception:
            creator_user = None

    conv = (
        await db.execute(select(Conversation).where(Conversation.id == group_id))
    ).scalar_one_or_none()
    if not conv:
        conv = Conversation(
            id=group_id,
            type="group",
            name=name,
            description=description,
            icon_url=icon_url,
            created_by_id=creator_user.id if creator_user else None,
            last_message_at=now,
            created_at=now,
            updated_at=now,
        )
        db.add(conv)
        await db.flush()
    else:
        conv.name = name
        conv.description = description
        conv.icon_url = icon_url
        conv.updated_at = now

    grp = (await db.execute(select(Group).where(Group.id == group_id))).scalar_one_or_none()
    if not grp:
        grp = Group(
            id=group_id,
            name=name,
            description=description,
            icon_url=icon_url,
            created_by_id=creator_user.id if creator_user else None,
            only_admins_can_send=only_admins_can_send,
            only_admins_can_edit_info=only_admins_can_edit_info,
            key_version=key_version,
            created_at=now,
            updated_at=now,
        )
        db.add(grp)
        await db.flush()
    else:
        grp.name = name
        grp.description = description
        grp.icon_url = icon_url
        grp.only_admins_can_send = only_admins_can_send
        grp.only_admins_can_edit_info = only_admins_can_edit_info
        if key_version >= grp.key_version:
            grp.key_version = key_version
        grp.updated_at = now

    roster_items = snapshot.get("members") or []
    desired_users: list[tuple[User, str]] = []
    for item in roster_items:
        gid = str(item.get("global_id") or "").strip()
        role = "admin" if str(item.get("role")) == "admin" else "member"
        if not gid:
            continue
        u = await resolve_user_by_identifier(db, gid)
        desired_users.append((u, role))

    if desired_users:
        desired_ids = {u.id for u, _ in desired_users}
        existing_mems = list(
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
        existing_map = {m.user_id: m for m in existing_mems}

        for m in existing_mems:
            if m.user_id not in desired_ids:
                await db.delete(m)

        for u, role in desired_users:
            if u.id in existing_map:
                existing_map[u.id].role = role
            else:
                db.add(
                    ConversationMember(
                        conversation_id=group_id,
                        user_id=u.id,
                        role=role,
                        sender_color=deterministic_sender_color(u.id),
                        joined_at=now,
                    )
                )
        await db.flush()

    local_members = [u for u, _ in desired_users if u.is_local]
    return conv, grp, local_members


async def _handle_incoming_message(
    db: AsyncSession,
    origin_domain: str,
    data: dict[str, Any],
) -> None:
    now = datetime.now(timezone.utc)
    sender = await _resolve_verified_origin_actor(
        db, str(data.get("sender_global_id") or ""), origin_domain
    )
    conv_type = str(data.get("conversation_type") or "direct")
    msg_id = str(data.get("message_id") or uuid.uuid4())
    fed_id = str(data.get("federation_id") or f"{msg_id}@{origin_domain}")

    # Idempotent deduplication
    existing_msg = (
        await db.execute(
            select(Message).where(
                or_(Message.federation_id == fed_id, Message.id == msg_id)
            )
        )
    ).scalar_one_or_none()
    if existing_msg is not None:
        return

    if conv_type == "group":
        if data.get("group_snapshot"):
            conv, grp, _ = await _sync_group_snapshot_from_federation(
                db, data["group_snapshot"], origin_domain
            )
        else:
            group_id = str(data.get("conversation_id") or "")
            conv = (
                await db.execute(
                    select(Conversation).where(
                        Conversation.id == group_id, Conversation.type == "group"
                    )
                )
            ).scalar_one_or_none()
            if not conv:
                raise AppError("GROUP_NOT_FOUND", "Federated group not found on this node.", 404)
            grp = (await db.execute(select(Group).where(Group.id == conv.id))).scalar_one_or_none()

        mem_check = (
            await db.execute(
                select(ConversationMember).where(
                    ConversationMember.conversation_id == conv.id,
                    ConversationMember.user_id == sender.id,
                )
            )
        ).scalar_one_or_none()
        if not mem_check:
            raise AppError("FORBIDDEN_GROUP_SENDER", "Sender is not a member of this group.", 403)
    else:
        peer_gid = str(data.get("peer_global_id") or "")
        recipient = await resolve_user_by_identifier(db, peer_gid)
        if not recipient.is_local:
            raise AppError(
                "RECIPIENT_NOT_LOCAL",
                f"Recipient '{peer_gid}' does not belong to this node.",
                status_code=status.HTTP_404_NOT_FOUND,
            )
        await assert_not_blocked_for_messaging(db, sender.id, [recipient.id])
        conv = await _find_or_create_direct_conv(db, sender, recipient, now)
        grp = None

    # Resolve mentions global_ids -> local/cached user IDs
    mentions_ids: list[str] = []
    for raw_m in data.get("mentions_global_ids") or []:
        try:
            mu = await resolve_user_by_identifier(db, str(raw_m))
            if mu.id not in mentions_ids:
                mentions_ids.append(mu.id)
        except Exception:
            continue

    created_at = _parse_iso_dt(data.get("created_at")) or now
    expires_at = _parse_iso_dt(data.get("expires_at"))
    reply_to_id = str(data["reply_to_id"]) if data.get("reply_to_id") else None
    if reply_to_id:
        rep_exists = (
            await db.execute(select(Message.id).where(Message.id == reply_to_id))
        ).scalar_one_or_none()
        if not rep_exists:
            reply_to_id = None

    msg_type = str(data.get("type") or data.get("message_type") or "text")
    msg = Message(
        id=msg_id,
        conversation_id=conv.id,
        sender_id=sender.id,
        sender_global_id=sender.global_id,
        ciphertext=str(data.get("ciphertext") or ""),
        nonce=str(data.get("nonce") or ""),
        sender_key_version=data.get("sender_key_version"),
        mentions=mentions_ids,
        system_event=data.get("system_event"),
        message_type=msg_type,
        status="sent",
        reply_to_id=reply_to_id,
        client_msg_id=data.get("client_msg_id"),
        expires_at=expires_at,
        federation_id=fed_id,
        created_at=created_at,
        updated_at=now,
    )
    db.add(msg)
    await db.flush()

    # Mirror remote attachment metadata if attached
    att_payload = data.get("attachment")
    if isinstance(att_payload, dict) and att_payload.get("id"):
        remote_att_id = str(att_payload["id"])
        existing_att = (
            await db.execute(select(Attachment).where(Attachment.id == remote_att_id))
        ).scalar_one_or_none()
        local_att_id = remote_att_id if existing_att is None else str(uuid.uuid4())
        remote_att = Attachment(
            id=local_att_id,
            conversation_id=conv.id,
            message_id=msg.id,
            uploader_id=sender.id,
            storage_backend="remote",
            storage_key=f"remote_{origin_domain}_{remote_att_id}_{local_att_id[:8]}",
            origin_domain=origin_domain,
            remote_attachment_id=remote_att_id,
            remote_download_url=str(att_payload.get("remote_download_url") or "")[:512] or None,
            encrypted_filename=str(att_payload.get("encrypted_filename") or ""),
            mime_type=str(att_payload.get("mime_type") or "application/octet-stream"),
            total_size=int(att_payload.get("total_size") or 0),
            ciphertext_size=int(att_payload.get("ciphertext_size") or 0),
            chunk_size=int(att_payload.get("chunk_size") or 1_048_576),
            chunk_count=int(att_payload.get("chunk_count") or 1),
            uploaded_chunks=int(att_payload.get("chunk_count") or 1),
            uploaded_chunk_map=list(range(int(att_payload.get("chunk_count") or 1))),
            file_nonce=str(att_payload.get("file_nonce") or ""),
            thumbnail_ciphertext=att_payload.get("thumbnail_ciphertext"),
            thumbnail_nonce=att_payload.get("thumbnail_nonce"),
            sha256_ciphertext=att_payload.get("sha256_ciphertext"),
            is_complete=True,
            completed_at=now,
            created_at=now,
        )
        db.add(remote_att)
        await db.flush()

    if msg_type == "live_location" and expires_at is not None:
        db.add(
            LiveLocationSession(
                message_id=msg.id,
                conversation_id=conv.id,
                sender_id=sender.id,
                ciphertext=msg.ciphertext,
                nonce=msg.nonce,
                is_active=True,
                expires_at=expires_at,
                created_at=now,
                updated_at=now,
            )
        )

    mem_rows = (
        await db.execute(
            select(ConversationMember, User)
            .join(User, User.id == ConversationMember.user_id)
            .where(ConversationMember.conversation_id == conv.id)
        )
    ).all()

    local_recipient_users: list[User] = []
    for cm, u in mem_rows:
        if u.id == sender.id:
            continue
        if u.is_local:
            if msg_type != "system":
                cm.unread_count = (cm.unread_count or 0) + 1
                db.add(
                    MessageReceipt(
                        message_id=msg.id,
                        user_id=u.id,
                        created_at=now,
                    )
                )
            local_recipient_users.append(u)

    conv.last_message_at = now
    await db.commit()
    await db.refresh(msg)

    enriched = (await _enrich_messages_batch(db, [msg]))[0]
    msg_json = enriched.model_dump(mode="json")
    now_iso = now.isoformat()

    online_delivered_users: list[User] = []
    for lu in local_recipient_users:
        sent_cnt = await ws_manager.send_to_user(
            lu.id,
            {"event": "message.new", "data": msg_json, "ts": now_iso},
        )
        if sent_cnt > 0 and msg_type != "system":
            online_delivered_users.append(lu)

    if mentions_ids:
        grp_name, mention_targets = await get_unmuted_mentioned_user_ids(
            db, conv.id, sender.id, mentions_ids
        )
        for m_uid in mention_targets:
            await ws_manager.send_to_user(
                m_uid,
                {
                    "event": "group.mention",
                    "data": {
                        "group_id": conv.id,
                        "conversation_id": conv.id,
                        "group_name": grp_name,
                        "message_id": msg.id,
                        "sender_id": sender.id,
                        "sender_display_name": sender.display_name,
                    },
                    "ts": now_iso,
                },
            )

    if msg_type != "system" and local_recipient_users:
        from app.services.push_service import dispatch_push_for_new_message

        await dispatch_push_for_new_message(
            db,
            sender=sender,
            msg_out=enriched,
            recipient_ids=[u.id for u in local_recipient_users],
            is_group=(conv.type == "group"),
        )

    # Emit automatic S2S `delivered` receipt for online local recipients who received the WS frame
    for du in online_delivered_users:
        rcpt = (
            await db.execute(
                select(MessageReceipt).where(
                    MessageReceipt.message_id == msg.id,
                    MessageReceipt.user_id == du.id,
                )
            )
        ).scalar_one_or_none()
        if rcpt and rcpt.delivered_at is None:
            rcpt.delivered_at = now
        if msg.status == "sent":
            msg.status = "delivered"
            msg.delivered_at = now
        await enqueue_federation_event(
            db,
            target_domain=origin_domain,
            event_type="receipt",
            data={
                "message_id": msg.id,
                "federation_id": fed_id,
                "conversation_id": conv.id,
                "conversation_type": conv.type,
                "actor_global_id": du.global_id,
                "status": "delivered",
                "delivered_at": now_iso,
                "read_at": None,
            },
            commit=False,
        )
    if online_delivered_users:
        await db.commit()
        from app.services.federation_service import trigger_outbox_wakeup

        trigger_outbox_wakeup()


async def _handle_incoming_message_edit(
    db: AsyncSession,
    origin_domain: str,
    data: dict[str, Any],
) -> None:
    sender = await _resolve_verified_origin_actor(
        db, str(data.get("sender_global_id") or ""), origin_domain
    )
    msg_id = str(data.get("message_id") or "")
    fed_id = str(data.get("federation_id") or "")
    msg = (
        await db.execute(
            select(Message).where(
                or_(
                    Message.id == msg_id,
                    and_fed(fed_id),
                )
            )
        )
    ).scalar_one_or_none()
    if not msg or msg.sender_id != sender.id:
        return

    now = datetime.now(timezone.utc)
    msg.ciphertext = str(data.get("ciphertext") or msg.ciphertext)
    msg.nonce = str(data.get("nonce") or msg.nonce)
    msg.edited_at = _parse_iso_dt(data.get("edited_at")) or now
    msg.updated_at = now
    await db.commit()
    await db.refresh(msg)

    enriched = (await _enrich_messages_batch(db, [msg]))[0]
    local_ids = await _get_local_member_ids(db, msg.conversation_id)
    await ws_manager.broadcast_to_users(
        local_ids,
        {
            "event": "message.updated",
            "data": enriched.model_dump(mode="json"),
            "ts": now.isoformat(),
        },
    )


def and_fed(fed_id: str) -> Any:
    if not fed_id:
        return Message.id == "__never__"
    return Message.federation_id == fed_id


async def _get_local_member_ids(db: AsyncSession, conversation_id: str) -> list[str]:
    rows = (
        await db.execute(
            select(User.id)
            .join(ConversationMember, ConversationMember.user_id == User.id)
            .where(
                ConversationMember.conversation_id == conversation_id,
                User.is_local.is_(True),
            )
        )
    ).scalars().all()
    return list(rows)


async def _handle_incoming_message_delete(
    db: AsyncSession,
    origin_domain: str,
    data: dict[str, Any],
) -> None:
    sender = await _resolve_verified_origin_actor(
        db, str(data.get("sender_global_id") or ""), origin_domain
    )
    msg_id = str(data.get("message_id") or "")
    fed_id = str(data.get("federation_id") or "")
    msg = (
        await db.execute(
            select(Message).where(or_(Message.id == msg_id, and_fed(fed_id)))
        )
    ).scalar_one_or_none()
    if not msg or msg.sender_id != sender.id:
        return

    now = datetime.now(timezone.utc)
    msg.deleted_for_everyone = True
    msg.deleted_at = now
    msg.ciphertext = ""
    msg.nonce = "AAAAAAAAAAAAAAAA"
    msg.updated_at = now
    await db.commit()

    local_ids = await _get_local_member_ids(db, msg.conversation_id)
    await ws_manager.broadcast_to_users(
        local_ids,
        {
            "event": "message.deleted",
            "data": {
                "conversation_id": msg.conversation_id,
                "message_id": msg.id,
                "scope": "everyone",
                "deleted_for_everyone": True,
            },
            "ts": now.isoformat(),
        },
    )


async def _handle_incoming_receipt(
    db: AsyncSession,
    origin_domain: str,
    data: dict[str, Any],
) -> None:
    actor = await _resolve_verified_origin_actor(
        db, str(data.get("actor_global_id") or ""), origin_domain
    )
    msg_id = str(data.get("message_id") or "")
    fed_id = str(data.get("federation_id") or "")
    target_status = str(data.get("status") or "delivered")
    if target_status not in ("delivered", "read"):
        return

    msg = (
        await db.execute(
            select(Message).where(or_(Message.id == msg_id, and_fed(fed_id)))
        )
    ).scalar_one_or_none()
    if not msg:
        return

    now = datetime.now(timezone.utc)
    delivered_dt = _parse_iso_dt(data.get("delivered_at")) or now
    read_dt = _parse_iso_dt(data.get("read_at")) or (now if target_status == "read" else None)

    rcpt = (
        await db.execute(
            select(MessageReceipt).where(
                MessageReceipt.message_id == msg.id,
                MessageReceipt.user_id == actor.id,
            )
        )
    ).scalar_one_or_none()
    if not rcpt:
        rcpt = MessageReceipt(message_id=msg.id, user_id=actor.id, created_at=now)
        db.add(rcpt)
        await db.flush()

    if rcpt.delivered_at is None:
        rcpt.delivered_at = delivered_dt
    if target_status == "read" and rcpt.read_at is None:
        rcpt.read_at = read_dt

    await db.flush()
    conv = (
        await db.execute(select(Conversation).where(Conversation.id == msg.conversation_id))
    ).scalar_one_or_none()

    if conv and conv.type == "group":
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
        if STATUS_RANK.get(agg_status, 1) > STATUS_RANK.get(msg.status, 1):
            msg.status = agg_status
            if msg.delivered_at is None and agg_status in ("delivered", "read"):
                msg.delivered_at = delivered_dt
            if agg_status == "read" and msg.read_at is None:
                msg.read_at = read_dt
    else:
        if STATUS_RANK.get(target_status, 1) > STATUS_RANK.get(msg.status, 1):
            msg.status = target_status
            if msg.delivered_at is None:
                msg.delivered_at = delivered_dt
            if target_status == "read" and msg.read_at is None:
                msg.read_at = read_dt

    msg.updated_at = now
    await db.commit()
    await db.refresh(msg)

    enriched = (await _enrich_messages_batch(db, [msg]))[0]
    await ws_manager.send_to_user(
        msg.sender_id,
        {
            "event": "message.ack",
            "data": {
                "conversation_id": msg.conversation_id,
                "message_id": msg.id,
                "status": enriched.status,
                "delivered_at": enriched.delivered_at.isoformat()
                if enriched.delivered_at
                else None,
                "read_at": enriched.read_at.isoformat() if enriched.read_at else None,
                "read_by": [r.model_dump(mode="json") for r in enriched.read_by],
                "delivered_to": [d.model_dump(mode="json") for d in enriched.delivered_to],
            },
            "ts": now.isoformat(),
        },
    )


async def _handle_incoming_typing(
    db: AsyncSession,
    origin_domain: str,
    data: dict[str, Any],
) -> None:
    actor = await _resolve_verified_origin_actor(
        db, str(data.get("actor_global_id") or ""), origin_domain
    )
    typing_event = str(data.get("typing_event") or "typing.start")
    if typing_event not in ("typing.start", "typing.stop"):
        return

    conv_type = str(data.get("conversation_type") or "direct")
    conv: Conversation | None = None
    if conv_type == "group":
        group_id = str(data.get("conversation_id") or "")
        conv = (
            await db.execute(select(Conversation).where(Conversation.id == group_id))
        ).scalar_one_or_none()
    else:
        peer_gid = str(data.get("peer_global_id") or "")
        if peer_gid:
            recipient = await resolve_user_by_identifier(db, peer_gid)
            pair_key = ":".join(sorted([actor.id, recipient.id]))
            conv = (
                await db.execute(
                    select(Conversation).where(Conversation.direct_pair_key == pair_key)
                )
            ).scalar_one_or_none()

    if not conv:
        return

    local_ids = await _get_local_member_ids(db, conv.id)
    now_iso = datetime.now(timezone.utc).isoformat()
    await ws_manager.broadcast_to_users(
        local_ids,
        {
            "event": typing_event,
            "data": {
                "conversation_id": conv.id,
                "user_id": actor.id,
                "global_id": actor.global_id,
                "display_name": actor.display_name,
            },
            "ts": now_iso,
        },
    )


async def _handle_incoming_presence(
    db: AsyncSession,
    origin_domain: str,
    data: dict[str, Any],
) -> None:
    actor = await _resolve_verified_origin_actor(
        db, str(data.get("actor_global_id") or ""), origin_domain
    )
    is_online = bool(data.get("is_online", False))
    last_seen_dt = _parse_iso_dt(data.get("last_seen_at"))
    actor.is_online = is_online
    if last_seen_dt is not None:
        actor.last_seen_at = last_seen_dt
    await db.commit()

    target_gids = data.get("target_global_ids") or []
    local_target_ids: list[str] = []
    settings = get_settings()
    for gid in target_gids:
        u_res = (
            await db.execute(
                select(User.id).where(
                    User.global_id == str(gid).lower(),
                    User.domain == settings.APP_DOMAIN.lower(),
                    User.is_local.is_(True),
                )
            )
        ).scalar_one_or_none()
        if u_res:
            local_target_ids.append(u_res)

    if local_target_ids:
        ev_name = "presence.online" if is_online else "presence.offline"
        now_iso = datetime.now(timezone.utc).isoformat()
        await ws_manager.broadcast_to_users(
            local_target_ids,
            {
                "event": ev_name,
                "data": {
                    "user_id": actor.id,
                    "global_id": actor.global_id,
                    "is_online": is_online,
                    "last_seen_at": last_seen_dt.isoformat() if last_seen_dt else None,
                },
                "ts": now_iso,
            },
        )


async def _handle_incoming_group_sync(
    db: AsyncSession,
    origin_domain: str,
    data: dict[str, Any],
) -> None:
    await _resolve_verified_origin_actor(
        db, str(data.get("actor_global_id") or ""), origin_domain
    )
    snapshot = data.get("group") or data
    conv, grp, local_members = await _sync_group_snapshot_from_federation(
        db, snapshot, origin_domain
    )
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()

    sys_payload = data.get("system_message")
    sys_out_json: dict[str, Any] | None = None
    if isinstance(sys_payload, dict) and sys_payload.get("id"):
        s_id = str(sys_payload["id"])
        exists = (
            await db.execute(select(Message.id).where(Message.id == s_id))
        ).scalar_one_or_none()
        if not exists:
            actor_u = await resolve_user_by_identifier(
                db, str(data.get("actor_global_id") or "")
            )
            sys_msg = Message(
                id=s_id,
                conversation_id=conv.id,
                sender_id=actor_u.id,
                sender_global_id=actor_u.global_id,
                ciphertext=str(sys_payload.get("ciphertext") or ""),
                nonce=str(sys_payload.get("nonce") or SYSTEM_NONCE_B64),
                message_type="system",
                status="read",
                system_event=sys_payload.get("system_event"),
                mentions=[],
                federation_id=f"{s_id}@{origin_domain}",
                created_at=_parse_iso_dt(sys_payload.get("created_at")) or now,
                updated_at=now,
            )
            db.add(sys_msg)
            conv.last_message_at = now
            await db.flush()
            sys_out_json = (await _enrich_messages_batch(db, [sys_msg]))[0].model_dump(
                mode="json"
            )

    await db.commit()

    sub_event = str(data.get("sub_event") or "group.updated")
    for lu in local_members:
        detail = await get_group_detail(db, conv.id, lu)
        await ws_manager.send_to_user(
            lu.id,
            {
                "event": sub_event,
                "data": {
                    "group_id": conv.id,
                    "group": detail.model_dump(mode="json"),
                    "key_version": grp.key_version,
                },
                "ts": now_iso,
            },
        )
        if data.get("key_rotated"):
            await ws_manager.send_to_user(
                lu.id,
                {
                    "event": "group.key_rotated",
                    "data": {
                        "group_id": conv.id,
                        "key_version": grp.key_version,
                        "reason": str(data.get("reason") or "federation_sync"),
                    },
                    "ts": now_iso,
                },
            )
        if sys_out_json:
            await ws_manager.send_to_user(
                lu.id,
                {"event": "message.new", "data": sys_out_json, "ts": now_iso},
            )


async def _handle_incoming_group_member_removed(
    db: AsyncSession,
    origin_domain: str,
    data: dict[str, Any],
) -> None:
    await _resolve_verified_origin_actor(
        db, str(data.get("actor_global_id") or ""), origin_domain
    )
    group_id = str(data.get("group_id") or "")
    removed_gid = str(data.get("removed_global_id") or "")
    if not group_id or not removed_gid:
        return

    removed_u = await resolve_user_by_identifier(db, removed_gid)
    await db.execute(
        delete(ConversationMember).where(
            ConversationMember.conversation_id == group_id,
            ConversationMember.user_id == removed_u.id,
        )
    )
    await db.execute(
        delete(GroupKey).where(
            GroupKey.conversation_id == group_id,
            or_(
                GroupKey.recipient_id == removed_u.id,
                GroupKey.sender_id == removed_u.id,
            ),
        )
    )
    if data.get("group"):
        await _sync_group_snapshot_from_federation(db, data["group"], origin_domain)
    await db.commit()

    if removed_u.is_local:
        await ws_manager.send_to_user(
            removed_u.id,
            {
                "event": "group.removed",
                "data": {"group_id": group_id},
                "ts": datetime.now(timezone.utc).isoformat(),
            },
        )


async def _handle_incoming_group_sender_keys(
    db: AsyncSession,
    origin_domain: str,
    data: dict[str, Any],
) -> None:
    sender = await _resolve_verified_origin_actor(
        db, str(data.get("sender_global_id") or ""), origin_domain
    )
    group_id = str(data.get("group_id") or "")
    key_version = int(data.get("key_version") or 1)
    envelopes = data.get("envelopes") or []

    conv = (
        await db.execute(
            select(Conversation).where(
                Conversation.id == group_id, Conversation.type == "group"
            )
        )
    ).scalar_one_or_none()
    if not conv:
        return

    now = datetime.now(timezone.utc)
    recipient_local_ids: list[str] = []
    for env in envelopes:
        rcpt_gid = str(env.get("recipient_global_id") or "").strip()
        if not rcpt_gid:
            continue
        rcpt_u = await resolve_user_by_identifier(db, rcpt_gid)
        if not rcpt_u.is_local:
            continue
        existing = (
            await db.execute(
                select(GroupKey).where(
                    GroupKey.conversation_id == group_id,
                    GroupKey.sender_id == sender.id,
                    GroupKey.recipient_id == rcpt_u.id,
                    GroupKey.key_generation == key_version,
                )
            )
        ).scalar_one_or_none()
        if existing:
            existing.encrypted_sender_key = str(env["wrapped_key"])
            existing.nonce = str(env["nonce"])
            existing.key_version = key_version
        else:
            db.add(
                GroupKey(
                    conversation_id=group_id,
                    sender_id=sender.id,
                    recipient_id=rcpt_u.id,
                    key_generation=key_version,
                    key_version=key_version,
                    encrypted_sender_key=str(env["wrapped_key"]),
                    nonce=str(env["nonce"]),
                    created_at=now,
                )
            )
        recipient_local_ids.append(rcpt_u.id)

    await db.commit()
    if recipient_local_ids:
        await ws_manager.broadcast_to_users(
            recipient_local_ids,
            {
                "event": "group.sender_key_available",
                "data": {
                    "group_id": group_id,
                    "sender_id": sender.id,
                    "key_version": key_version,
                },
                "ts": now.isoformat(),
            },
        )


async def _handle_incoming_call_signal(
    db: AsyncSession,
    origin_domain: str,
    data: dict[str, Any],
) -> None:
    actor = await _resolve_verified_origin_actor(
        db, str(data.get("from_global_id") or ""), origin_domain
    )
    target_gid = str(data.get("to_global_id") or "")
    target = await resolve_user_by_identifier(db, target_gid)
    if not target.is_local:
        return
    await assert_not_blocked_for_messaging(db, actor.id, [target.id])

    now = datetime.now(timezone.utc)
    signal_type = str(data.get("signal_type") or "call.offer")
    call_id = str(data.get("call_id") or uuid.uuid4())
    call_type = "video" if str(data.get("call_type")) == "video" else "voice"

    conv = await _find_or_create_direct_conv(db, actor, target, now)

    if signal_type == "call.offer":
        existing_call = (
            await db.execute(select(CallLog).where(CallLog.id == call_id))
        ).scalar_one_or_none()
        if not existing_call:
            db.add(
                CallLog(
                    id=call_id,
                    conversation_id=conv.id,
                    caller_id=actor.id,
                    callee_id=target.id,
                    call_type=call_type,
                    status="ringing",
                    created_at=now,
                )
            )
            await db.commit()
    elif signal_type in ("call.hangup", "call.decline"):
        existing_call = (
            await db.execute(select(CallLog).where(CallLog.id == call_id))
        ).scalar_one_or_none()
        if existing_call:
            existing_call.status = "declined" if signal_type == "call.decline" else "ended"
            existing_call.ended_at = now
            await db.commit()

    await ws_manager.send_to_user(
        target.id,
        {
            "event": signal_type,
            "data": {
                "call_id": call_id,
                "conversation_id": conv.id,
                "call_type": call_type,
                "from_user_id": actor.id,
                "from_global_id": actor.global_id,
                "from_display_name": actor.display_name,
                "payload": data.get("payload") or {},
            },
            "ts": now.isoformat(),
        },
    )


async def _handle_incoming_live_location(
    db: AsyncSession,
    origin_domain: str,
    event_type: str,
    data: dict[str, Any],
) -> None:
    sender = await _resolve_verified_origin_actor(
        db, str(data.get("sender_global_id") or ""), origin_domain
    )
    msg_id = str(data.get("message_id") or "")
    fed_id = str(data.get("federation_id") or "")
    msg = (
        await db.execute(select(Message).where(or_(Message.id == msg_id, and_fed(fed_id))))
    ).scalar_one_or_none()
    if not msg or msg.sender_id != sender.id:
        return

    now = datetime.now(timezone.utc)
    sess = (
        await db.execute(
            select(LiveLocationSession).where(LiveLocationSession.message_id == msg.id)
        )
    ).scalar_one_or_none()

    if data.get("ciphertext") and data.get("nonce"):
        msg.ciphertext = str(data["ciphertext"])
        msg.nonce = str(data["nonce"])
        msg.updated_at = now

    if event_type == "location.live_stop":
        msg.expires_at = now
        if sess:
            sess.is_active = False
            sess.expires_at = now
            sess.updated_at = now
        ws_ev = "location.live_stopped"
    else:
        if sess:
            sess.ciphertext = msg.ciphertext
            sess.nonce = msg.nonce
            sess.updated_at = now
        ws_ev = "location.live_updated"

    await db.commit()
    await db.refresh(msg)
    enriched = (await _enrich_messages_batch(db, [msg]))[0]
    local_ids = await _get_local_member_ids(db, msg.conversation_id)
    await ws_manager.broadcast_to_users(
        local_ids,
        {"event": ws_ev, "data": enriched.model_dump(mode="json"), "ts": now.isoformat()},
    )


async def process_federation_inbox_envelope(
    db: AsyncSession,
    origin_domain: str,
    envelope: FederationInboxEnvelope,
) -> None:
    ev_type = envelope.event_type.strip().lower()
    data = envelope.data

    if ev_type in ("message", "message.send", "message.new"):
        await _handle_incoming_message(db, origin_domain, data)
    elif ev_type == "message.edit":
        await _handle_incoming_message_edit(db, origin_domain, data)
    elif ev_type == "message.delete":
        await _handle_incoming_message_delete(db, origin_domain, data)
    elif ev_type in ("receipt", "message.receipt"):
        await _handle_incoming_receipt(db, origin_domain, data)
    elif ev_type in ("typing", "typing.start", "typing.stop"):
        if ev_type in ("typing.start", "typing.stop") and "typing_event" not in data:
            data = {**data, "typing_event": ev_type}
        await _handle_incoming_typing(db, origin_domain, data)
    elif ev_type in ("presence", "presence.online", "presence.offline"):
        await _handle_incoming_presence(db, origin_domain, data)
    elif ev_type == "group.sync":
        await _handle_incoming_group_sync(db, origin_domain, data)
    elif ev_type == "group.member_removed":
        await _handle_incoming_group_member_removed(db, origin_domain, data)
    elif ev_type == "group.sender_keys":
        await _handle_incoming_group_sender_keys(db, origin_domain, data)
    elif ev_type == "call.signal":
        await _handle_incoming_call_signal(db, origin_domain, data)
    elif ev_type in ("location.live_update", "location.live_stop"):
        await _handle_incoming_live_location(db, origin_domain, ev_type, data)
    else:
        raise AppError(
            "UNSUPPORTED_FEDERATION_EVENT",
            f"Unsupported federation event_type '{envelope.event_type}'.",
            status_code=status.HTTP_400_BAD_REQUEST,
        )
