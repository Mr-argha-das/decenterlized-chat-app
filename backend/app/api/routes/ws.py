import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError
from sqlalchemy import select

from app.api.deps import verify_access_token_and_load_auth
from app.core.config import get_settings
from app.core.errors import AppError
from app.core.rate_limit import rate_limiter
from app.db.session import AsyncSessionLocal
from app.models.entities import Conversation, User
from app.schemas.chat import MessageCreateRequest
from app.services.chat_service import (
    acknowledge_messages,
    assert_conversation_member,
    create_encrypted_message,
    flush_offline_queue_and_resume,
    get_conversation_member_ids,
    get_peer_user_ids_for_presence,
    get_unmuted_mentioned_user_ids,
    stop_live_location_message,
    update_live_location_message,
)
from app.services.federation_hook import resolve_user_by_identifier
from app.services.federation_service import (
    enqueue_federation_event,
    enqueue_for_remote_users,
    trigger_outbox_wakeup,
)
from app.services.privacy_service import (
    assert_not_blocked_for_messaging,
    filter_presence_audience,
)
from app.services.push_service import dispatch_push_for_new_message
from app.services.realtime import ws_manager

logger = logging.getLogger("relaychat.ws")
router = APIRouter(tags=["realtime"])


def _extract_ws_token(websocket: WebSocket) -> str | None:
    q_token = websocket.query_params.get("token")
    if q_token:
        return q_token.strip()
    auth_hdr = websocket.headers.get("authorization")
    if auth_hdr and auth_hdr.lower().startswith("bearer "):
        return auth_hdr[7:].strip()
    custom_hdr = websocket.headers.get("x-relaychat-token")
    if custom_hdr:
        return custom_hdr.strip()
    cookie_token = websocket.cookies.get("relaychat_access")
    if cookie_token:
        return cookie_token.strip()
    return None


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    raw_token = _extract_ws_token(websocket)
    if not raw_token:
        await websocket.close(code=4401, reason="Missing JWT access token")
        return

    since_iso = websocket.query_params.get("since")

    async with AsyncSessionLocal() as db:
        try:
            user, device = await verify_access_token_and_load_auth(
                raw_token, db, touch_device=True
            )
            user_id = user.id
            device_id = device.id
            user_global_id = user.global_id
        except AppError as exc:
            await websocket.close(code=4401, reason=exc.message)
            return
        except Exception:
            await websocket.close(code=4401, reason="Authentication failed")
            return

    await websocket.accept()
    became_online = await ws_manager.connect(user_id, websocket, device_id=device_id)

    # Mark user online in DB, broadcast presence.online, and flush offline queue / missed events
    async with AsyncSessionLocal() as db:
        u_res = await db.execute(select(User).where(User.id == user_id))
        db_user = u_res.scalar_one()
        now = datetime.now(timezone.utc)
        db_user.is_online = True
        db_user.last_seen_at = now
        await db.commit()

        peer_ids = await get_peer_user_ids_for_presence(db, user_id)
        if became_online:
            allowed_peers = await filter_presence_audience(db, db_user, peer_ids)
            if allowed_peers:
                await ws_manager.broadcast_to_users(
                    allowed_peers,
                    {
                        "event": "presence.online",
                        "data": {
                            "user_id": user_id,
                            "global_id": user_global_id,
                            "is_online": True,
                            "last_seen_at": now.isoformat(),
                        },
                        "ts": now.isoformat(),
                    },
                )
                remote_peer_rows = (
                    await db.execute(
                        select(User).where(
                            User.id.in_(allowed_peers), User.is_local.is_(False)
                        )
                    )
                ).scalars().all()
                by_dom: dict[str, list[str]] = {}
                for rpu in remote_peer_rows:
                    by_dom.setdefault(rpu.domain.lower(), []).append(rpu.global_id)
                for dom, target_gids in by_dom.items():
                    await enqueue_federation_event(
                        db,
                        target_domain=dom,
                        event_type="presence",
                        data={
                            "actor_global_id": user_global_id,
                            "is_online": True,
                            "last_seen_at": now.isoformat(),
                            "target_global_ids": target_gids,
                        },
                        commit=False,
                    )
                if by_dom:
                    await db.commit()
                    trigger_outbox_wakeup()

        await websocket.send_json(
            {
                "event": "session.ready",
                "data": {
                    "user_id": user_id,
                    "global_id": user_global_id,
                    "server_time": now.isoformat(),
                },
                "ts": now.isoformat(),
            }
        )

        queued_events, sender_acks = await flush_offline_queue_and_resume(
            db, db_user, since_iso=since_iso
        )
        for ev in queued_events:
            await websocket.send_json(ev)
        for sender_id, ack_ev in sender_acks:
            await ws_manager.send_to_user(sender_id, ack_ev)

    try:
        while True:
            packet: dict[str, Any] = await websocket.receive_json()
            event_type = str(packet.get("event") or "")
            data = packet.get("data") or {}
            now_iso = datetime.now(timezone.utc).isoformat()

            if event_type == "ping":
                await websocket.send_json({"event": "pong", "data": {}, "ts": now_iso})
                continue

            if event_type in ("message.send", "message.new"):
                async with AsyncSessionLocal() as db:
                    try:
                        rate_limiter.check(
                            "ws_msg",
                            user_id,
                            get_settings().WS_MSG_RATE_LIMIT_PER_MINUTE,
                            60,
                        )
                        u_res = await db.execute(select(User).where(User.id == user_id))
                        sender = u_res.scalar_one()
                        req = MessageCreateRequest.model_validate(data)
                        msg_out, member_ids = await create_encrypted_message(
                            db, sender=sender, body=req
                        )
                        grp_name, mention_targets = (
                            await get_unmuted_mentioned_user_ids(
                                db, msg_out.conversation_id, sender.id, msg_out.mentions
                            )
                            if msg_out.mentions
                            else ("", [])
                        )
                        sender_disp = sender.display_name
                        await dispatch_push_for_new_message(
                            db,
                            sender=sender,
                            msg_out=msg_out,
                            recipient_ids=member_ids,
                            is_group=(msg_out.sender_key_version is not None),
                        )
                    except (ValidationError, AppError) as exc:
                        err_msg = exc.message if isinstance(exc, AppError) else "Invalid message payload."
                        err_code = exc.code if isinstance(exc, AppError) else "VALIDATION_ERROR"
                        await websocket.send_json(
                            {
                                "event": "error",
                                "data": {
                                    "code": err_code,
                                    "message": err_msg,
                                    "client_msg_id": data.get("client_msg_id"),
                                },
                                "ts": now_iso,
                            }
                        )
                        continue

                    msg_json = msg_out.model_dump(mode="json")
                    # 1. Acknowledge `sent` to sender immediately (resolves optimistic pending clock -> single check)
                    await websocket.send_json(
                        {
                            "event": "message.ack",
                            "data": {
                                "conversation_id": msg_out.conversation_id,
                                "message_id": msg_out.id,
                                "client_msg_id": msg_out.client_msg_id,
                                "status": msg_out.status,
                                "message": msg_json,
                            },
                            "ts": now_iso,
                        }
                    )
                    # Also sync other open tabs of the same sender
                    await ws_manager.send_to_user(
                        user_id,
                        {"event": "message.new", "data": msg_json, "ts": now_iso},
                        exclude_ws=websocket,
                    )

                    # 2. Deliver live to online recipients; if offline, message remains queued in DB!
                    for uid in member_ids:
                        if uid == user_id:
                            continue
                        await ws_manager.send_to_user(
                            uid,
                            {"event": "message.new", "data": msg_json, "ts": now_iso},
                        )

                    for m_uid in mention_targets:
                        await ws_manager.send_to_user(
                            m_uid,
                            {
                                "event": "group.mention",
                                "data": {
                                    "group_id": msg_out.conversation_id,
                                    "conversation_id": msg_out.conversation_id,
                                    "group_name": grp_name,
                                    "message_id": msg_out.id,
                                    "sender_id": user_id,
                                    "sender_display_name": sender_disp,
                                },
                                "ts": now_iso,
                            },
                        )

            elif event_type == "message.ack":
                conv_id = str(data.get("conversation_id") or "")
                ack_status = str(data.get("status") or "delivered")
                if ack_status not in ("delivered", "read") or not conv_id:
                    continue
                msg_ids = data.get("message_ids")
                if not msg_ids and data.get("message_id"):
                    msg_ids = [str(data["message_id"])]

                async with AsyncSessionLocal() as db:
                    try:
                        u_res = await db.execute(select(User).where(User.id == user_id))
                        actor = u_res.scalar_one()
                        updated = await acknowledge_messages(
                            db,
                            actor=actor,
                            conversation_id=conv_id,
                            target_status=ack_status,
                            message_ids=msg_ids,
                        )
                    except AppError:
                        continue

                for msg_out, sender_id in updated:
                    await ws_manager.send_to_user(
                        sender_id,
                        {
                            "event": "message.ack",
                            "data": {
                                "conversation_id": conv_id,
                                "message_id": msg_out.id,
                                "status": msg_out.status,
                                "delivered_at": msg_out.delivered_at.isoformat()
                                if msg_out.delivered_at
                                else None,
                                "read_at": msg_out.read_at.isoformat() if msg_out.read_at else None,
                                "read_by": [r.model_dump(mode="json") for r in msg_out.read_by],
                                "delivered_to": [
                                    d.model_dump(mode="json") for d in msg_out.delivered_to
                                ],
                            },
                            "ts": now_iso,
                        },
                    )

            elif event_type in ("typing.start", "typing.stop"):
                conv_id = str(data.get("conversation_id") or "")
                if not conv_id:
                    continue
                async with AsyncSessionLocal() as db:
                    try:
                        await assert_conversation_member(db, conv_id, user_id)
                        conv_row = (
                            await db.execute(
                                select(Conversation).where(Conversation.id == conv_id)
                            )
                        ).scalar_one_or_none()
                        member_ids = await get_conversation_member_ids(db, conv_id)
                        if conv_row and conv_row.type == "direct":
                            await assert_not_blocked_for_messaging(db, user_id, member_ids)
                        sender_u = (
                            await db.execute(select(User).where(User.id == user_id))
                        ).scalar_one_or_none()
                        typing_display_name = sender_u.display_name if sender_u else user_global_id
                        mem_users = list(
                            (
                                await db.execute(
                                    select(User).where(User.id.in_(member_ids))
                                )
                            )
                            .scalars()
                            .all()
                        )
                        remote_typing_targets = [
                            u for u in mem_users if not u.is_local and u.id != user_id
                        ]
                        if remote_typing_targets and conv_row:
                            if conv_row.type == "direct":
                                for rtu in remote_typing_targets:
                                    await enqueue_federation_event(
                                        db,
                                        target_domain=rtu.domain,
                                        event_type="typing",
                                        data={
                                            "actor_global_id": user_global_id,
                                            "typing_event": event_type,
                                            "conversation_id": conv_id,
                                            "conversation_type": "direct",
                                            "peer_global_id": rtu.global_id,
                                        },
                                        commit=False,
                                    )
                                await db.commit()
                                trigger_outbox_wakeup()
                            else:
                                await enqueue_for_remote_users(
                                    db,
                                    remote_typing_targets,
                                    event_type="typing",
                                    data={
                                        "actor_global_id": user_global_id,
                                        "typing_event": event_type,
                                        "conversation_id": conv_id,
                                        "conversation_type": "group",
                                    },
                                    commit=True,
                                )
                    except AppError:
                        continue

                for uid in member_ids:
                    if uid == user_id:
                        continue
                    await ws_manager.send_to_user(
                        uid,
                        {
                            "event": event_type,
                            "data": {
                                "conversation_id": conv_id,
                                "user_id": user_id,
                                "global_id": user_global_id,
                                "display_name": typing_display_name,
                            },
                            "ts": now_iso,
                        },
                    )

            elif event_type == "location.live_update":
                msg_id = str(data.get("message_id") or "")
                ciphertext = str(data.get("ciphertext") or "")
                nonce = str(data.get("nonce") or "")
                if not msg_id or not ciphertext or not nonce:
                    continue
                async with AsyncSessionLocal() as db:
                    try:
                        u_res = await db.execute(select(User).where(User.id == user_id))
                        actor = u_res.scalar_one()
                        msg_out, member_ids = await update_live_location_message(
                            db,
                            actor=actor,
                            message_id=msg_id,
                            ciphertext=ciphertext,
                            nonce=nonce,
                        )
                    except AppError as exc:
                        await websocket.send_json(
                            {
                                "event": "error",
                                "data": {
                                    "code": exc.code,
                                    "message": exc.message,
                                    "message_id": msg_id,
                                },
                                "ts": now_iso,
                            }
                        )
                        continue

                await ws_manager.broadcast_to_users(
                    member_ids,
                    {
                        "event": "location.live_updated",
                        "data": msg_out.model_dump(mode="json"),
                        "ts": now_iso,
                    },
                )

            elif event_type == "location.live_stop":
                msg_id = str(data.get("message_id") or "")
                if not msg_id:
                    continue
                ct_opt = str(data["ciphertext"]) if data.get("ciphertext") else None
                nonce_opt = str(data["nonce"]) if data.get("nonce") else None
                async with AsyncSessionLocal() as db:
                    try:
                        u_res = await db.execute(select(User).where(User.id == user_id))
                        actor = u_res.scalar_one()
                        msg_out, member_ids = await stop_live_location_message(
                            db,
                            actor=actor,
                            message_id=msg_id,
                            ciphertext=ct_opt,
                            nonce=nonce_opt,
                        )
                    except AppError:
                        continue

                await ws_manager.broadcast_to_users(
                    member_ids,
                    {
                        "event": "location.live_stopped",
                        "data": msg_out.model_dump(mode="json"),
                        "ts": now_iso,
                    },
                )

            elif event_type in (
                "call.offer",
                "call.answer",
                "call.ice_candidate",
                "call.hangup",
                "call.decline",
            ):
                to_uid = str(data.get("to_user_id") or "")
                to_gid = str(data.get("to_global_id") or "")
                call_id = str(data.get("call_id") or "")
                call_type = "video" if str(data.get("call_type")) == "video" else "voice"
                async with AsyncSessionLocal() as db:
                    try:
                        actor_u = (
                            await db.execute(select(User).where(User.id == user_id))
                        ).scalar_one()
                        target_u: User | None = None
                        if to_uid:
                            target_u = (
                                await db.execute(select(User).where(User.id == to_uid))
                            ).scalar_one_or_none()
                        elif to_gid:
                            target_u = await resolve_user_by_identifier(db, to_gid)
                        if not target_u or target_u.id == actor_u.id:
                            continue
                        await assert_not_blocked_for_messaging(db, actor_u.id, [target_u.id])
                        if target_u.is_local:
                            await ws_manager.send_to_user(
                                target_u.id,
                                {
                                    "event": event_type,
                                    "data": {
                                        "call_id": call_id,
                                        "conversation_id": data.get("conversation_id"),
                                        "call_type": call_type,
                                        "from_user_id": actor_u.id,
                                        "from_global_id": actor_u.global_id,
                                        "from_display_name": actor_u.display_name,
                                        "payload": data.get("payload") or {},
                                    },
                                    "ts": now_iso,
                                },
                            )
                        else:
                            await enqueue_federation_event(
                                db,
                                target_domain=target_u.domain,
                                event_type="call.signal",
                                data={
                                    "signal_type": event_type,
                                    "call_id": call_id,
                                    "call_type": call_type,
                                    "from_global_id": actor_u.global_id,
                                    "to_global_id": target_u.global_id,
                                    "payload": data.get("payload") or {},
                                },
                                commit=True,
                            )
                    except AppError:
                        continue

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("WebSocket loop ended for %s: %s", user_global_id, exc)
    finally:
        became_offline = ws_manager.disconnect(user_id, websocket)
        if became_offline:
            async with AsyncSessionLocal() as db:
                u_res = await db.execute(select(User).where(User.id == user_id))
                db_user = u_res.scalar_one_or_none()
                if db_user:
                    now = datetime.now(timezone.utc)
                    db_user.is_online = False
                    db_user.last_seen_at = now
                    await db.commit()
                    peer_ids = await get_peer_user_ids_for_presence(db, user_id)
                    allowed_peers = await filter_presence_audience(db, db_user, peer_ids)
                    if allowed_peers:
                        await ws_manager.broadcast_to_users(
                            allowed_peers,
                            {
                                "event": "presence.offline",
                                "data": {
                                    "user_id": user_id,
                                    "global_id": user_global_id,
                                    "is_online": False,
                                    "last_seen_at": now.isoformat(),
                                },
                                "ts": now.isoformat(),
                            },
                        )
                        remote_peer_rows = (
                            await db.execute(
                                select(User).where(
                                    User.id.in_(allowed_peers),
                                    User.is_local.is_(False),
                                )
                            )
                        ).scalars().all()
                        by_dom_off: dict[str, list[str]] = {}
                        for rpu in remote_peer_rows:
                            by_dom_off.setdefault(rpu.domain.lower(), []).append(
                                rpu.global_id
                            )
                        for dom, target_gids in by_dom_off.items():
                            await enqueue_federation_event(
                                db,
                                target_domain=dom,
                                event_type="presence",
                                data={
                                    "actor_global_id": user_global_id,
                                    "is_online": False,
                                    "last_seen_at": now.isoformat(),
                                    "target_global_ids": target_gids,
                                },
                                commit=False,
                            )
                        if by_dom_off:
                            await db.commit()
                            trigger_outbox_wakeup()
