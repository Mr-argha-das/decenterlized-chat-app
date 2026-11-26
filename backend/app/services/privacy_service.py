"""
Server-enforced Block & Privacy rules for RelayChat (Phase 4).
Never trusts client filtering — strips `last_seen_at`, `is_online`, `avatar_url`,
suppresses `read` receipts, and rejects messages/typing from blocked users on the server.
"""
from fastapi import status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.models.entities import Block, Contact, User
from app.schemas.chat import PeerSummaryOut
from app.schemas.contacts import PeerProfileViewOut


async def is_in_contacts(db: AsyncSession, owner_id: str, target_user_id: str) -> bool:
    res = await db.execute(
        select(Contact.id).where(
            Contact.owner_id == owner_id,
            Contact.contact_user_id == target_user_id,
        )
    )
    return res.scalar_one_or_none() is not None


async def get_contact_entry(
    db: AsyncSession, owner_id: str, target_user_id: str
) -> Contact | None:
    res = await db.execute(
        select(Contact).where(
            Contact.owner_id == owner_id,
            Contact.contact_user_id == target_user_id,
        )
    )
    return res.scalar_one_or_none()


async def get_block_flags(
    db: AsyncSession, viewer_id: str, peer_id: str
) -> tuple[bool, bool]:
    """Returns `(is_blocked_by_viewer, has_peer_blocked_viewer)`."""
    if viewer_id == peer_id:
        return False, False
    res = await db.execute(
        select(Block).where(
            or_(
                (Block.blocker_id == viewer_id) & (Block.blocked_id == peer_id),
                (Block.blocker_id == peer_id) & (Block.blocked_id == viewer_id),
            )
        )
    )
    rows = list(res.scalars().all())
    blocked_by_viewer = any(
        b.blocker_id == viewer_id and b.blocked_id == peer_id for b in rows
    )
    blocked_by_peer = any(
        b.blocker_id == peer_id and b.blocked_id == viewer_id for b in rows
    )
    return blocked_by_viewer, blocked_by_peer


async def assert_not_blocked_for_messaging(
    db: AsyncSession, sender_id: str, member_ids: list[str]
) -> None:
    others = [uid for uid in member_ids if uid != sender_id]
    if not others:
        return

    res = await db.execute(
        select(Block).where(
            or_(
                (Block.blocker_id.in_(others)) & (Block.blocked_id == sender_id),
                (Block.blocker_id == sender_id) & (Block.blocked_id.in_(others)),
            )
        )
    )
    blocks = list(res.scalars().all())
    for blk in blocks:
        if blk.blocked_id == sender_id:
            raise AppError(
                "USER_BLOCKED",
                "You cannot send messages to this user.",
                status_code=status.HTTP_403_FORBIDDEN,
            )
        if blk.blocker_id == sender_id and len(others) == 1:
            raise AppError(
                "CONTACT_IS_BLOCKED",
                "You have blocked this user. Unblock them to send messages.",
                status_code=status.HTTP_403_FORBIDDEN,
            )


async def can_viewer_see_last_seen(
    db: AsyncSession,
    target: User,
    viewer_id: str,
    blocked_flags: tuple[bool, bool] | None = None,
) -> bool:
    if target.id == viewer_id:
        return True
    is_blocked_by_viewer, has_peer_blocked_viewer = blocked_flags or await get_block_flags(
        db, viewer_id, target.id
    )
    # Blocked users cannot see my last seen / online status (and vice versa)
    if has_peer_blocked_viewer or is_blocked_by_viewer:
        return False

    scope = target.privacy_last_seen or "everyone"
    if scope == "nobody":
        return False
    if scope == "contacts":
        return await is_in_contacts(db, owner_id=target.id, target_user_id=viewer_id)
    return True


async def can_viewer_see_profile_photo(
    db: AsyncSession,
    target: User,
    viewer_id: str,
    blocked_flags: tuple[bool, bool] | None = None,
) -> bool:
    if target.id == viewer_id:
        return True
    _, has_peer_blocked_viewer = blocked_flags or await get_block_flags(
        db, viewer_id, target.id
    )
    if has_peer_blocked_viewer:
        return False

    scope = getattr(target, "privacy_profile_photo", "everyone") or "everyone"
    if scope == "nobody":
        return False
    if scope == "contacts":
        return await is_in_contacts(db, owner_id=target.id, target_user_id=viewer_id)
    return True


async def can_actor_emit_read_receipt(
    db: AsyncSession,
    actor: User,
    sender_id: str,
) -> bool:
    if actor.id == sender_id:
        return True
    is_blocked_by_actor, has_sender_blocked_actor = await get_block_flags(
        db, actor.id, sender_id
    )
    if is_blocked_by_actor or has_sender_blocked_actor:
        return False

    if not actor.privacy_read_receipts:
        return False

    scope = getattr(actor, "privacy_read_receipts_visibility", "everyone") or "everyone"
    if scope == "nobody":
        return False
    if scope == "contacts":
        return await is_in_contacts(db, owner_id=actor.id, target_user_id=sender_id)
    return True


async def build_peer_profile_view(
    db: AsyncSession,
    target: User,
    viewer: User,
) -> PeerProfileViewOut:
    blocked_flags = await get_block_flags(db, viewer.id, target.id)
    is_blocked_by_me, has_blocked_me = blocked_flags

    contact = await get_contact_entry(db, owner_id=viewer.id, target_user_id=target.id)
    nickname = (contact.nickname or contact.alias) if contact else None

    show_presence = await can_viewer_see_last_seen(db, target, viewer.id, blocked_flags)
    show_photo = await can_viewer_see_profile_photo(db, target, viewer.id, blocked_flags)

    return PeerProfileViewOut(
        id=target.id,
        username=target.username,
        domain=target.domain,
        global_id=target.global_id,
        display_name=target.display_name,
        nickname=nickname,
        effective_name=nickname or target.display_name,
        about="" if has_blocked_me else target.about,
        avatar_url=target.avatar_url if show_photo else None,
        public_key=target.public_key,
        is_local=target.is_local,
        is_online=target.is_online if show_presence else False,
        last_seen_at=target.last_seen_at if show_presence else None,
        is_contact=contact is not None,
        is_blocked_by_me=is_blocked_by_me,
        has_blocked_me=has_blocked_me,
    )


async def build_peer_summary_for_viewer(
    db: AsyncSession,
    target: User,
    viewer: User,
) -> PeerSummaryOut:
    view = await build_peer_profile_view(db, target, viewer)
    return PeerSummaryOut(
        id=view.id,
        username=view.username,
        domain=view.domain,
        global_id=view.global_id,
        display_name=view.effective_name,
        raw_display_name=view.display_name,
        nickname=view.nickname,
        about=view.about,
        avatar_url=view.avatar_url,
        public_key=view.public_key,
        is_online=view.is_online,
        last_seen_at=view.last_seen_at,
        is_contact=view.is_contact,
        is_blocked_by_me=view.is_blocked_by_me,
        has_blocked_me=view.has_blocked_me,
    )


async def filter_presence_audience(
    db: AsyncSession,
    subject_user: User,
    candidate_viewer_ids: set[str],
) -> set[str]:
    allowed: set[str] = set()
    for vid in candidate_viewer_ids:
        if await can_viewer_see_last_seen(db, subject_user, vid):
            allowed.add(vid)
    return allowed
