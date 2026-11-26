from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.rate_limit import api_rate_limit
from app.db.session import get_db_session
from app.models.entities import User
from app.schemas.chat import (
    ConversationCreateRequest,
    ConversationOut,
    ConversationUpdateRequest,
    CursorMessagesOut,
    MessageAckRequest,
    MessageCreateRequest,
    MessageEditRequest,
    MessageOut,
)
from app.services.chat_service import (
    acknowledge_messages,
    create_encrypted_message,
    delete_encrypted_message,
    edit_encrypted_message,
    get_or_create_direct_conversation,
    list_conversation_messages,
    list_user_conversations,
    update_conversation_preferences,
)
from app.services.realtime import ws_manager

router = APIRouter(tags=["chat"], dependencies=[Depends(api_rate_limit())])


@router.get("/conversations", response_model=list[ConversationOut])
async def get_conversations(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> list[ConversationOut]:
    return await list_user_conversations(db, current_user)


@router.post(
    "/conversations",
    response_model=ConversationOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_or_open_conversation(
    body: ConversationCreateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> ConversationOut:
    return await get_or_create_direct_conversation(
        db,
        current_user=current_user,
        peer_id=body.peer_id,
        peer_username=body.peer_username,
    )


@router.patch("/conversations/{conversation_id}", response_model=ConversationOut)
async def patch_conversation(
    conversation_id: str,
    body: ConversationUpdateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> ConversationOut:
    return await update_conversation_preferences(
        db,
        current_user=current_user,
        conversation_id=conversation_id,
        is_pinned=body.is_pinned,
        is_muted=body.is_muted,
    )


@router.get("/conversations/{conversation_id}/messages", response_model=CursorMessagesOut)
async def get_conversation_messages(
    conversation_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
    cursor: Annotated[str | None, Query(description="Opaque pagination cursor (`created_at|id`)")] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 40,
) -> CursorMessagesOut:
    return await list_conversation_messages(
        db,
        current_user=current_user,
        conversation_id=conversation_id,
        before=cursor,
        limit=limit,
    )


@router.post("/conversations/{conversation_id}/ack")
async def ack_conversation_messages(
    conversation_id: str,
    body: MessageAckRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> dict[str, int]:
    updated = await acknowledge_messages(
        db,
        actor=current_user,
        conversation_id=conversation_id,
        target_status=body.status,
        message_ids=body.message_ids,
    )
    now_iso = datetime.now(timezone.utc).isoformat()
    for msg_out, sender_id in updated:
        await ws_manager.send_to_user(
            sender_id,
            {
                "event": "message.ack",
                "data": {
                    "conversation_id": conversation_id,
                    "message_id": msg_out.id,
                    "status": msg_out.status,
                    "delivered_at": msg_out.delivered_at.isoformat() if msg_out.delivered_at else None,
                    "read_at": msg_out.read_at.isoformat() if msg_out.read_at else None,
                },
                "ts": now_iso,
            },
        )
    return {"acknowledged": len(updated)}


@router.post(
    "/messages",
    response_model=MessageOut,
    status_code=status.HTTP_201_CREATED,
)
async def post_message_fallback(
    body: MessageCreateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> MessageOut:
    msg_out, member_ids = await create_encrypted_message(db, sender=current_user, body=body)
    now_iso = datetime.now(timezone.utc).isoformat()
    msg_json = msg_out.model_dump(mode="json")

    # Push live event to all online conversation members (including other tabs of sender)
    for uid in member_ids:
        await ws_manager.send_to_user(
            uid,
            {
                "event": "message.new",
                "data": msg_json,
                "ts": now_iso,
            },
        )
    return msg_out


@router.patch("/messages/{message_id}", response_model=MessageOut)
async def patch_message(
    message_id: str,
    body: MessageEditRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> MessageOut:
    msg_out, member_ids = await edit_encrypted_message(
        db,
        actor=current_user,
        message_id=message_id,
        ciphertext=body.ciphertext,
        nonce=body.nonce,
    )
    now_iso = datetime.now(timezone.utc).isoformat()
    await ws_manager.broadcast_to_users(
        member_ids,
        {
            "event": "message.updated",
            "data": msg_out.model_dump(mode="json"),
            "ts": now_iso,
        },
    )
    return msg_out


@router.delete("/messages/{message_id}", response_model=MessageOut)
async def delete_message(
    message_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
    scope: Annotated[Literal["me", "everyone"], Query()] = "me",
) -> MessageOut:
    msg_out, notify_user_ids, applied_scope = await delete_encrypted_message(
        db,
        actor=current_user,
        message_id=message_id,
        scope=scope,
    )
    now_iso = datetime.now(timezone.utc).isoformat()
    payload = msg_out.model_dump(mode="json")
    payload["delete_scope"] = applied_scope
    await ws_manager.broadcast_to_users(
        notify_user_ids,
        {
            "event": "message.deleted",
            "data": payload,
            "ts": now_iso,
        },
    )
    return msg_out
