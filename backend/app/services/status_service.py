import asyncio
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import status
from sqlalchemy import and_, delete, desc, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import AppError
from app.core.metrics import metrics_registry
from app.db.session import AsyncSessionLocal
from app.models.entities import (
    Attachment,
    Block,
    Contact,
    ConversationMember,
    Message,
    StatusMute,
    StatusPost,
    StatusView,
    User,
)
from app.schemas.status import (
    StatusCreateRequest,
    StatusFeedOut,
    StatusItemOut,
    StatusPrivacyOut,
    StatusPrivacyUpdateRequest,
    StatusRecipientCandidateOut,
    StatusViewerOut,
    UserStatusBundleOut,
)
from app.services.realtime import ws_manager

logger = logging.getLogger("relaychat.statuses")


def _ensure_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def get_user_status_privacy(user: User) -> StatusPrivacyOut:
    mode = user.status_privacy_mode or "contacts"
    if mode not in ("contacts", "except", "only"):
        mode = "contacts"
    return StatusPrivacyOut(
        mode=mode,  # type: ignore[arg-type]
        except_user_ids=list(user.status_privacy_exceptions or []),
        only_user_ids=list(user.status_privacy_only_ids or []),
    )


async def update_user_status_privacy(
    db: AsyncSession,
    user: User,
    body: StatusPrivacyUpdateRequest,
) -> StatusPrivacyOut:
    user.status_privacy_mode = body.mode
    user.status_privacy_exceptions = list(dict.fromkeys(body.except_user_ids))
    user.status_privacy_only_ids = list(dict.fromkeys(body.only_user_ids))
    await db.commit()
    await db.refresh(user)
    return get_user_status_privacy(user)


async def _get_blocked_ids(db: AsyncSession, user_id: str) -> set[str]:
    res = await db.execute(
        select(Block.blocker_id, Block.blocked_id).where(
            or_(Block.blocker_id == user_id, Block.blocked_id == user_id)
        )
    )
    out: set[str] = set()
    for blocker_id, blocked_id in res.all():
        out.add(blocked_id if blocker_id == user_id else blocker_id)
    return out


async def list_status_recipient_candidates(
    db: AsyncSession,
    user: User,
) -> list[StatusRecipientCandidateOut]:
    blocked_ids = await _get_blocked_ids(db, user.id)
    res = await db.execute(
        select(Contact, User)
        .join(User, User.id == Contact.contact_user_id)
        .where(Contact.owner_id == user.id)
        .order_by(User.display_name.asc())
    )
    out: list[StatusRecipientCandidateOut] = []
    for contact, peer in res.all():
        if peer.id in blocked_ids or peer.id == user.id:
            continue
        label = (contact.nickname or contact.alias or peer.display_name).strip()
        out.append(
            StatusRecipientCandidateOut(
                user_id=peer.id,
                global_id=peer.global_id,
                display_name=label,
                avatar_url=peer.avatar_url,
                public_key=peer.public_key,
            )
        )
    return out


def is_viewer_allowed_for_status(
    post: StatusPost,
    viewer_id: str,
    author_contact_ids: set[str],
    blocked_ids: set[str],
) -> bool:
    if viewer_id == post.user_id:
        return True
    if viewer_id in blocked_ids:
        return False
    mode = post.privacy_mode or "contacts"
    targets = set(post.target_user_ids or [])
    if mode == "only":
        if viewer_id not in targets:
            return False
    elif mode == "except":
        if viewer_id not in author_contact_ids or viewer_id in targets:
            return False
    else:
        if viewer_id not in author_contact_ids:
            return False

    envelopes = post.key_envelopes or {}
    if envelopes and viewer_id not in envelopes:
        return False
    return True


async def create_status_post(
    db: AsyncSession,
    author: User,
    body: StatusCreateRequest,
) -> StatusItemOut:
    settings = get_settings()
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(hours=max(1, settings.STATUS_TTL_HOURS))

    if body.attachment_id:
        att_res = await db.execute(
            select(Attachment).where(Attachment.id == body.attachment_id)
        )
        att = att_res.scalar_one_or_none()
        if not att or att.uploader_id != author.id or not att.is_complete:
            raise AppError(
                "INVALID_STATUS_ATTACHMENT",
                "Referenced encrypted status media was not found or incomplete.",
                status_code=status.HTTP_400_BAD_REQUEST,
            )

    default_priv = get_user_status_privacy(author)
    privacy_mode = body.privacy_mode or default_priv.mode
    if body.target_user_ids is not None:
        target_ids = list(dict.fromkeys(body.target_user_ids))
    elif privacy_mode == "except":
        target_ids = list(default_priv.except_user_ids)
    elif privacy_mode == "only":
        target_ids = list(default_priv.only_user_ids)
    else:
        target_ids = []

    post = StatusPost(
        user_id=author.id,
        media_type=body.media_type,
        ciphertext=body.ciphertext,
        nonce=body.nonce,
        key_envelopes=body.key_envelopes or {},
        background_style=body.background_style,
        font_family=body.font_family or "sans",
        attachment_id=body.attachment_id,
        privacy_mode=privacy_mode,
        target_user_ids=target_ids,
        viewer_list=[],
        created_at=now,
        expires_at=expires_at,
    )
    db.add(post)
    await db.commit()
    await db.refresh(post)
    metrics_registry.inc_counter("statuses_posted_total", 1)

    # Notify eligible local contacts over WebSocket
    c_res = await db.execute(
        select(Contact.contact_user_id).where(Contact.owner_id == author.id)
    )
    contact_ids = set(c_res.scalars().all())
    blocked_ids = await _get_blocked_ids(db, author.id)
    eligible_audience = {
        uid
        for uid in (contact_ids | set(target_ids))
        if uid != author.id
        and is_viewer_allowed_for_status(post, uid, contact_ids, blocked_ids)
    }
    if eligible_audience:
        await ws_manager.broadcast_to_users(
            eligible_audience,
            {
                "event": "status.new",
                "data": {
                    "status_id": post.id,
                    "author_id": author.id,
                    "author_global_id": author.global_id,
                    "author_display_name": author.display_name,
                    "media_type": post.media_type,
                    "created_at": post.created_at.isoformat(),
                    "expires_at": post.expires_at.isoformat(),
                },
                "ts": now.isoformat(),
            },
        )

    return StatusItemOut(
        id=post.id,
        user_id=author.id,
        author_global_id=author.global_id,
        author_display_name=author.display_name,
        author_avatar_url=author.avatar_url,
        author_public_key=author.public_key,
        media_type=post.media_type,
        ciphertext=post.ciphertext,
        nonce=post.nonce,
        my_key_envelope=(post.key_envelopes or {}).get(author.id),
        background_style=post.background_style,
        font_family=post.font_family or "sans",
        attachment_id=post.attachment_id,
        privacy_mode=post.privacy_mode or "contacts",
        is_viewed=True,
        view_count=0,
        viewers=[],
        created_at=post.created_at,
        expires_at=post.expires_at,
    )


async def get_status_feed(db: AsyncSession, viewer: User) -> StatusFeedOut:
    now = datetime.now(timezone.utc)
    blocked_ids = await _get_blocked_ids(db, viewer.id)

    mute_res = await db.execute(
        select(StatusMute.muted_user_id).where(StatusMute.muter_id == viewer.id)
    )
    muted_author_ids = set(mute_res.scalars().all())

    # Active posts (author's own + anyone who hasn't expired)
    posts_res = await db.execute(
        select(StatusPost, User)
        .join(User, User.id == StatusPost.user_id)
        .where(StatusPost.expires_at > now)
        .order_by(StatusPost.created_at.asc())
    )
    rows = posts_res.all()
    if not rows:
        return StatusFeedOut(
            my_statuses=[],
            recent_updates=[],
            muted_updates=[],
            privacy=get_user_status_privacy(viewer),
        )

    author_ids = {u.id for _, u in rows if u.id != viewer.id}
    author_contacts_map: dict[str, set[str]] = {}
    if author_ids:
        ac_res = await db.execute(
            select(Contact.owner_id, Contact.contact_user_id).where(
                Contact.owner_id.in_(author_ids)
            )
        )
        for owner_id, contact_uid in ac_res.all():
            author_contacts_map.setdefault(owner_id, set()).add(contact_uid)

    # Nicknames from viewer's address book
    nick_map: dict[str, str] = {}
    if author_ids:
        n_res = await db.execute(
            select(Contact).where(
                Contact.owner_id == viewer.id,
                Contact.contact_user_id.in_(author_ids),
            )
        )
        for c in n_res.scalars().all():
            label = (c.nickname or c.alias or "").strip()
            if label:
                nick_map[c.contact_user_id] = label

    status_ids = [p.id for p, _ in rows]
    views_res = await db.execute(
        select(StatusView, User)
        .join(User, User.id == StatusView.viewer_id)
        .where(StatusView.status_id.in_(status_ids))
        .order_by(desc(StatusView.viewed_at))
    )
    views_by_status: dict[str, list[StatusViewerOut]] = {}
    viewed_by_me: set[str] = set()
    for sv, v_user in views_res.all():
        if sv.viewer_id == viewer.id:
            viewed_by_me.add(sv.status_id)
        views_by_status.setdefault(sv.status_id, []).append(
            StatusViewerOut(
                user_id=v_user.id,
                global_id=v_user.global_id,
                display_name=v_user.display_name,
                avatar_url=v_user.avatar_url,
                viewed_at=sv.viewed_at,
            )
        )

    my_statuses: list[StatusItemOut] = []
    by_author: dict[str, list[StatusItemOut]] = {}
    author_meta: dict[str, User] = {}

    for post, author in rows:
        if author.id == viewer.id:
            v_list = views_by_status.get(post.id, [])
            my_statuses.append(
                StatusItemOut(
                    id=post.id,
                    user_id=author.id,
                    author_global_id=author.global_id,
                    author_display_name=author.display_name,
                    author_avatar_url=author.avatar_url,
                    author_public_key=author.public_key,
                    media_type=post.media_type,
                    ciphertext=post.ciphertext,
                    nonce=post.nonce,
                    my_key_envelope=(post.key_envelopes or {}).get(viewer.id),
                    background_style=post.background_style,
                    font_family=post.font_family or "sans",
                    attachment_id=post.attachment_id,
                    privacy_mode=post.privacy_mode or "contacts",
                    is_viewed=True,
                    view_count=len(v_list),
                    viewers=v_list,
                    created_at=post.created_at,
                    expires_at=post.expires_at,
                )
            )
            continue

        if not is_viewer_allowed_for_status(
            post,
            viewer.id,
            author_contacts_map.get(author.id, set()),
            blocked_ids,
        ):
            continue

        display_label = nick_map.get(author.id, author.display_name)
        item = StatusItemOut(
            id=post.id,
            user_id=author.id,
            author_global_id=author.global_id,
            author_display_name=display_label,
            author_avatar_url=author.avatar_url,
            author_public_key=author.public_key,
            media_type=post.media_type,
            ciphertext=post.ciphertext,
            nonce=post.nonce,
            my_key_envelope=(post.key_envelopes or {}).get(viewer.id),
            background_style=post.background_style,
            font_family=post.font_family or "sans",
            attachment_id=post.attachment_id,
            privacy_mode=post.privacy_mode or "contacts",
            is_viewed=post.id in viewed_by_me,
            view_count=0,
            viewers=[],
            created_at=post.created_at,
            expires_at=post.expires_at,
        )
        by_author.setdefault(author.id, []).append(item)
        author_meta[author.id] = author

    recent_updates: list[UserStatusBundleOut] = []
    muted_updates: list[UserStatusBundleOut] = []

    for aid, items in by_author.items():
        author = author_meta[aid]
        is_muted = aid in muted_author_ids
        all_viewed = all(it.is_viewed for it in items)
        latest_at = max(it.created_at for it in items)
        bundle = UserStatusBundleOut(
            user_id=author.id,
            global_id=author.global_id,
            display_name=nick_map.get(author.id, author.display_name),
            avatar_url=author.avatar_url,
            public_key=author.public_key,
            is_muted=is_muted,
            all_viewed=all_viewed,
            latest_at=latest_at,
            statuses=items,
        )
        if is_muted:
            muted_updates.append(bundle)
        else:
            recent_updates.append(bundle)

    recent_updates.sort(key=lambda b: (b.all_viewed, -b.latest_at.timestamp()))
    muted_updates.sort(key=lambda b: -b.latest_at.timestamp())

    return StatusFeedOut(
        my_statuses=my_statuses,
        recent_updates=recent_updates,
        muted_updates=muted_updates,
        privacy=get_user_status_privacy(viewer),
    )


async def record_status_view(
    db: AsyncSession,
    viewer: User,
    status_id: str,
) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    res = await db.execute(
        select(StatusPost).where(StatusPost.id == status_id, StatusPost.expires_at > now)
    )
    post = res.scalar_one_or_none()
    if not post:
        raise AppError(
            "STATUS_NOT_FOUND",
            "Status does not exist or has expired.",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    if post.user_id == viewer.id:
        return {"status_id": post.id, "viewed": True}

    blocked_ids = await _get_blocked_ids(db, viewer.id)
    ac_res = await db.execute(
        select(Contact.contact_user_id).where(Contact.owner_id == post.user_id)
    )
    author_contacts = set(ac_res.scalars().all())
    if not is_viewer_allowed_for_status(post, viewer.id, author_contacts, blocked_ids):
        raise AppError(
            "FORBIDDEN_STATUS",
            "You do not have permission to view this status.",
            status_code=status.HTTP_403_FORBIDDEN,
        )

    existing_res = await db.execute(
        select(StatusView).where(
            StatusView.status_id == post.id,
            StatusView.viewer_id == viewer.id,
        )
    )
    existing = existing_res.scalar_one_or_none()
    if not existing:
        sv = StatusView(status_id=post.id, viewer_id=viewer.id, viewed_at=now)
        db.add(sv)
        await db.commit()
        await ws_manager.send_to_user(
            post.user_id,
            {
                "event": "status.viewed",
                "data": {
                    "status_id": post.id,
                    "viewer": {
                        "user_id": viewer.id,
                        "global_id": viewer.global_id,
                        "display_name": viewer.display_name,
                        "avatar_url": viewer.avatar_url,
                        "viewed_at": now.isoformat(),
                    },
                },
                "ts": now.isoformat(),
            },
        )

    return {"status_id": post.id, "viewed": True}


async def list_status_viewers(
    db: AsyncSession,
    author: User,
    status_id: str,
) -> list[StatusViewerOut]:
    res = await db.execute(select(StatusPost).where(StatusPost.id == status_id))
    post = res.scalar_one_or_none()
    if not post or post.user_id != author.id:
        raise AppError(
            "STATUS_NOT_FOUND",
            "Status not found.",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    v_res = await db.execute(
        select(StatusView, User)
        .join(User, User.id == StatusView.viewer_id)
        .where(StatusView.status_id == status_id)
        .order_by(desc(StatusView.viewed_at))
    )
    return [
        StatusViewerOut(
            user_id=u.id,
            global_id=u.global_id,
            display_name=u.display_name,
            avatar_url=u.avatar_url,
            viewed_at=sv.viewed_at,
        )
        for sv, u in v_res.all()
    ]


async def delete_status_post(
    db: AsyncSession,
    author: User,
    status_id: str,
) -> dict[str, str]:
    res = await db.execute(select(StatusPost).where(StatusPost.id == status_id))
    post = res.scalar_one_or_none()
    if not post or post.user_id != author.id:
        raise AppError(
            "STATUS_NOT_FOUND",
            "Status not found.",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    att_id = post.attachment_id
    await db.delete(post)
    await db.commit()

    if att_id:
        await _cleanup_unreferenced_attachment(db, att_id)

    c_res = await db.execute(
        select(Contact.contact_user_id).where(Contact.owner_id == author.id)
    )
    contact_ids = set(c_res.scalars().all())
    if contact_ids:
        now_iso = datetime.now(timezone.utc).isoformat()
        await ws_manager.broadcast_to_users(
            contact_ids,
            {
                "event": "status.deleted",
                "data": {"status_id": status_id, "author_id": author.id},
                "ts": now_iso,
            },
        )
    return {"status": "deleted", "id": status_id}


async def set_status_mute(
    db: AsyncSession,
    muter: User,
    target_user_id: str,
    *,
    muted: bool,
) -> dict[str, Any]:
    if muter.id == target_user_id:
        raise AppError("INVALID_TARGET", "Cannot mute your own status.", status_code=400)

    existing = (
        await db.execute(
            select(StatusMute).where(
                StatusMute.muter_id == muter.id,
                StatusMute.muted_user_id == target_user_id,
            )
        )
    ).scalar_one_or_none()

    if muted and not existing:
        db.add(
            StatusMute(
                muter_id=muter.id,
                muted_user_id=target_user_id,
                created_at=datetime.now(timezone.utc),
            )
        )
        await db.commit()
    elif not muted and existing:
        await db.delete(existing)
        await db.commit()

    return {"target_user_id": target_user_id, "is_muted": muted}


async def _cleanup_unreferenced_attachment(db: AsyncSession, attachment_id: str) -> None:
    att = (
        await db.execute(select(Attachment).where(Attachment.id == attachment_id))
    ).scalar_one_or_none()
    if not att or att.message_id is not None:
        return
    settings = get_settings()
    blob_path = Path(settings.STORAGE_DIR) / "encrypted_blobs" / f"{att.storage_key}.enc"
    blob_path.unlink(missing_ok=True)
    await db.delete(att)
    await db.commit()


async def run_expiry_cleanup_once(db: AsyncSession) -> dict[str, int]:
    """Purges expired 24hr statuses and expired disappearing messages (`expires_at <= now`)."""
    now = datetime.now(timezone.utc)

    # 1. Expired statuses
    exp_statuses = list(
        (
            await db.execute(select(StatusPost).where(StatusPost.expires_at <= now))
        ).scalars().all()
    )
    status_att_ids = [s.attachment_id for s in exp_statuses if s.attachment_id]
    deleted_statuses = len(exp_statuses)
    if exp_statuses:
        await db.execute(delete(StatusPost).where(StatusPost.expires_at <= now))
        await db.commit()
        for aid in status_att_ids:
            await _cleanup_unreferenced_attachment(db, aid)

    # 2. Expired disappearing messages (exclude live_location which uses expires_at for live sharing duration)
    exp_msgs = list(
        (
            await db.execute(
                select(Message).where(
                    and_(
                        Message.expires_at.is_not(None),
                        Message.expires_at <= now,
                        Message.message_type != "live_location",
                    )
                )
            )
        ).scalars().all()
    )
    deleted_messages = len(exp_msgs)
    if exp_msgs:
        conv_to_msg_ids: dict[str, list[str]] = {}
        msg_ids = [m.id for m in exp_msgs]
        for m in exp_msgs:
            conv_to_msg_ids.setdefault(m.conversation_id, []).append(m.id)

        # Clean up encrypted attachment blobs belonging to expired disappearing messages
        att_rows = list(
            (
                await db.execute(
                    select(Attachment).where(Attachment.message_id.in_(msg_ids))
                )
            ).scalars().all()
        )
        settings = get_settings()
        for att in att_rows:
            blob_path = (
                Path(settings.STORAGE_DIR) / "encrypted_blobs" / f"{att.storage_key}.enc"
            )
            blob_path.unlink(missing_ok=True)

        await db.execute(delete(Message).where(Message.id.in_(msg_ids)))
        await db.commit()

        now_iso = now.isoformat()
        for conv_id, expired_ids in conv_to_msg_ids.items():
            mem_ids = list(
                (
                    await db.execute(
                        select(ConversationMember.user_id).where(
                            ConversationMember.conversation_id == conv_id
                        )
                    )
                ).scalars().all()
            )
            if mem_ids:
                await ws_manager.broadcast_to_users(
                    set(mem_ids),
                    {
                        "event": "message.expired",
                        "data": {
                            "conversation_id": conv_id,
                            "message_ids": expired_ids,
                        },
                        "ts": now_iso,
                    },
                )

    return {
        "expired_statuses_removed": deleted_statuses,
        "expired_messages_removed": deleted_messages,
    }


async def expiry_cleanup_worker_loop(stop_event: asyncio.Event) -> None:
    settings = get_settings()
    interval = max(5.0, float(settings.EXPIRY_CLEANUP_INTERVAL_SECONDS))
    while not stop_event.is_set():
        try:
            async with AsyncSessionLocal() as db:
                stats = await run_expiry_cleanup_once(db)
                if stats["expired_statuses_removed"] or stats["expired_messages_removed"]:
                    logger.info("Expiry cleanup swept %s", stats)
        except Exception as exc:
            logger.warning("Expiry cleanup loop error: %s", exc)
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=interval)
        except asyncio.TimeoutError:
            continue
