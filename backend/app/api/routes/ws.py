import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError
from sqlalchemy import select

from app.api.deps import verify_access_token_and_load_auth
from app.core.errors import AppError
from app.db.session import AsyncSessionLocal
from app.models.entities import User
from app.schemas.chat import MessageCreateRequest
from app.services.chat_service import (
    acknowledge_messages,
    assert_conversation_member,
    create_encrypted_message,
    flush_offline_queue_and_resume,
    get_conversation_member_ids,
    get_peer_user_ids_for_presence,
)
from app.services.privacy_service import (
    assert_not_blocked_for_messaging,
    filter_presence_audience,
)
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
                        u_res = await db.execute(select(User).where(User.id == user_id))
                        sender = u_res.scalar_one()
                        req = MessageCreateRequest.model_validate(data)
                        msg_out, member_ids = await create_encrypted_message(
                            db, sender=sender, body=req
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
                        member_ids = await get_conversation_member_ids(db, conv_id)
                        await assert_not_blocked_for_messaging(db, user_id, member_ids)
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
                            },
                            "ts": now_iso,
                        },
                    )

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
