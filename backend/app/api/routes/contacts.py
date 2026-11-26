from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.errors import AppError
from app.core.rate_limit import api_rate_limit
from app.db.session import get_db_session
from app.models.entities import Block, Contact, User
from app.schemas.contacts import (
    BlockCreateRequest,
    BlockOut,
    ContactCreateRequest,
    ContactOut,
    ContactUpdateRequest,
)
from app.services.federation_hook import resolve_user_by_identifier
from app.services.privacy_service import build_peer_profile_view
from app.services.realtime import ws_manager

router = APIRouter(tags=["contacts-and-blocks"], dependencies=[Depends(api_rate_limit())])


async def _serialize_contact(
    db: AsyncSession, contact: Contact, owner: User, target: User
) -> ContactOut:
    peer_view = await build_peer_profile_view(db, target, owner)
    nickname = contact.nickname if contact.nickname is not None else contact.alias
    return ContactOut(
        id=contact.id,
        owner_id=contact.owner_id,
        contact_user_id=contact.contact_user_id,
        nickname=nickname,
        created_at=contact.created_at,
        user=peer_view,
    )


@router.get("/contacts", response_model=list[ContactOut])
async def list_contacts(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
    q: Annotated[str, Query(max_length=120)] = "",
) -> list[ContactOut]:
    cleaned = q.strip().lower()
    stmt = (
        select(Contact, User)
        .join(User, User.id == Contact.contact_user_id)
        .where(Contact.owner_id == current_user.id)
    )
    if cleaned:
        pattern = f"%{cleaned}%"
        stmt = stmt.where(
            or_(
                Contact.nickname.ilike(pattern),
                Contact.alias.ilike(pattern),
                User.display_name.ilike(pattern),
                User.username.ilike(pattern),
                User.global_id.ilike(pattern),
            )
        )
    stmt = stmt.order_by(User.display_name.asc())
    rows = (await db.execute(stmt)).all()

    out: list[ContactOut] = []
    for contact, target in rows:
        out.append(await _serialize_contact(db, contact, current_user, target))
    return out


@router.post("/contacts", response_model=ContactOut, status_code=status.HTTP_201_CREATED)
async def add_contact_by_id(
    body: ContactCreateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> ContactOut:
    target = await resolve_user_by_identifier(db, body.identifier)
    if target.id == current_user.id:
        raise AppError(
            "CANNOT_ADD_SELF",
            "You cannot add your own ID as a contact.",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    existing_res = await db.execute(
        select(Contact).where(
            Contact.owner_id == current_user.id,
            Contact.contact_user_id == target.id,
        )
    )
    contact = existing_res.scalar_one_or_none()
    cleaned_nick = body.nickname.strip() if body.nickname else None

    if contact:
        if body.nickname is not None:
            contact.nickname = cleaned_nick or None
            contact.alias = cleaned_nick or None
            contact.updated_at = datetime.now(timezone.utc)
            await db.commit()
            await db.refresh(contact)
    else:
        now = datetime.now(timezone.utc)
        contact = Contact(
            owner_id=current_user.id,
            contact_user_id=target.id,
            nickname=cleaned_nick or None,
            alias=cleaned_nick or None,
            created_at=now,
            updated_at=now,
        )
        db.add(contact)
        await db.commit()
        await db.refresh(contact)

    return await _serialize_contact(db, contact, current_user, target)


@router.patch("/contacts/{contact_user_id}", response_model=ContactOut)
async def update_contact_nickname(
    contact_user_id: str,
    body: ContactUpdateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> ContactOut:
    res = await db.execute(
        select(Contact, User)
        .join(User, User.id == Contact.contact_user_id)
        .where(
            Contact.owner_id == current_user.id,
            Contact.contact_user_id == contact_user_id,
        )
    )
    row = res.one_or_none()
    if not row:
        raise AppError("CONTACT_NOT_FOUND", "Contact entry not found.", status_code=404)

    contact, target = row
    cleaned_nick = body.nickname.strip() if body.nickname else None
    contact.nickname = cleaned_nick or None
    contact.alias = cleaned_nick or None
    contact.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(contact)
    return await _serialize_contact(db, contact, current_user, target)


@router.delete("/contacts/{contact_user_id}")
async def remove_contact(
    contact_user_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> dict[str, str]:
    res = await db.execute(
        select(Contact).where(
            Contact.owner_id == current_user.id,
            Contact.contact_user_id == contact_user_id,
        )
    )
    contact = res.scalar_one_or_none()
    if not contact:
        raise AppError("CONTACT_NOT_FOUND", "Contact entry not found.", status_code=404)

    await db.delete(contact)
    await db.commit()
    return {"status": "removed", "contact_user_id": contact_user_id}


@router.get("/blocks", response_model=list[BlockOut])
async def list_blocked_users(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> list[BlockOut]:
    rows = (
        await db.execute(
            select(Block, User)
            .join(User, User.id == Block.blocked_id)
            .where(Block.blocker_id == current_user.id)
            .order_by(Block.created_at.desc())
        )
    ).all()

    out: list[BlockOut] = []
    for blk, target in rows:
        peer_view = await build_peer_profile_view(db, target, current_user)
        out.append(
            BlockOut(
                id=blk.id,
                blocker_id=blk.blocker_id,
                blocked_user_id=blk.blocked_id,
                reason=blk.reason,
                created_at=blk.created_at,
                user=peer_view,
            )
        )
    return out


@router.post("/blocks", response_model=BlockOut, status_code=status.HTTP_201_CREATED)
async def block_user(
    body: BlockCreateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> BlockOut:
    target: User | None = None
    if body.target_user_id:
        target = (
            await db.execute(select(User).where(User.id == body.target_user_id))
        ).scalar_one_or_none()
    elif body.identifier:
        target = await resolve_user_by_identifier(db, body.identifier)

    if not target:
        raise AppError("USER_NOT_FOUND", "Target user to block was not found.", status_code=404)
    if target.id == current_user.id:
        raise AppError("CANNOT_BLOCK_SELF", "You cannot block yourself.", status_code=400)

    existing = (
        await db.execute(
            select(Block).where(
                Block.blocker_id == current_user.id,
                Block.blocked_id == target.id,
            )
        )
    ).scalar_one_or_none()

    if not existing:
        existing = Block(
            blocker_id=current_user.id,
            blocked_id=target.id,
            reason=body.reason.strip() if body.reason else None,
        )
        db.add(existing)
        await db.commit()
        await db.refresh(existing)

    # Immediately mask current_user's online/last_seen on the blocked user's live WS session
    now_iso = datetime.now(timezone.utc).isoformat()
    await ws_manager.send_to_user(
        target.id,
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

    peer_view = await build_peer_profile_view(db, target, current_user)
    return BlockOut(
        id=existing.id,
        blocker_id=existing.blocker_id,
        blocked_user_id=existing.blocked_id,
        reason=existing.reason,
        created_at=existing.created_at,
        user=peer_view,
    )


@router.delete("/blocks/{blocked_user_id}")
async def unblock_user(
    blocked_user_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> dict[str, str]:
    blk = (
        await db.execute(
            select(Block).where(
                Block.blocker_id == current_user.id,
                Block.blocked_id == blocked_user_id,
            )
        )
    ).scalar_one_or_none()
    if not blk:
        raise AppError("BLOCK_NOT_FOUND", "User is not blocked.", status_code=404)

    await db.delete(blk)
    await db.commit()
    return {"status": "unblocked", "blocked_user_id": blocked_user_id}
