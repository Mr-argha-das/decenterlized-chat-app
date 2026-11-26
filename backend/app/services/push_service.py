"""Web Push (VAPID RFC 8292) key management, subscription persistence, and E2EE-safe dispatch.

Plaintext message contents NEVER exist on the server:
- When `local_decrypt_enabled=False` (default): push payload carries `"New message"` only.
- When `local_decrypt_enabled=True`: push payload carries ciphertext + nonce + sender public key
  so the browser Service Worker (`sw.js`) can decrypt locally via IndexedDB + Web Crypto.
"""
import asyncio
import base64
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import status
from pywebpush import WebPushException, webpush
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import AppError
from app.core.metrics import metrics_registry
from app.models.entities import ConversationMember, PushSubscription, User
from app.schemas.chat import MessageOut
from app.schemas.push import (
    PushSubscribeRequest,
    PushSubscriptionOut,
    PushSubscriptionUpdateRequest,
    VapidPublicKeyOut,
)

logger = logging.getLogger("relaychat.push")

_VAPID_CACHE: dict[str, tuple[str, str]] = {}
PushTransportFn = Callable[[PushSubscription, dict[str, Any]], None]
_push_transport_override: PushTransportFn | None = None


def set_push_transport_override(fn: PushTransportFn | None) -> None:
    """Used by automated tests to inspect outgoing Web Push envelopes deterministically."""
    global _push_transport_override
    _push_transport_override = fn


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def get_or_create_vapid_keys() -> tuple[str, str]:
    """Returns `(public_key_b64url, private_key_b64url)` for P-256 VAPID."""
    settings = get_settings()
    if settings.VAPID_PUBLIC_KEY.strip() and settings.VAPID_PRIVATE_KEY.strip():
        return settings.VAPID_PUBLIC_KEY.strip(), settings.VAPID_PRIVATE_KEY.strip()

    key_path = Path(settings.VAPID_KEY_PATH)
    cache_key = str(key_path.resolve())
    if cache_key in _VAPID_CACHE:
        return _VAPID_CACHE[cache_key]

    if key_path.exists():
        try:
            stored = json.loads(key_path.read_text(encoding="utf-8"))
            pub = str(stored["public_key"])
            priv = str(stored["private_key"])
            _VAPID_CACHE[cache_key] = (pub, priv)
            return pub, priv
        except Exception:
            pass

    ec_priv = ec.generate_private_key(ec.SECP256R1())
    pub_bytes = ec_priv.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    priv_int = ec_priv.private_numbers().private_value
    priv_bytes = priv_int.to_bytes(32, "big")

    pub_b64 = _b64url_encode(pub_bytes)
    priv_b64 = _b64url_encode(priv_bytes)

    key_path.parent.mkdir(parents=True, exist_ok=True)
    key_path.write_text(
        json.dumps({"public_key": pub_b64, "private_key": priv_b64}, indent=2),
        encoding="utf-8",
    )
    _VAPID_CACHE[cache_key] = (pub_b64, priv_b64)
    return pub_b64, priv_b64


def get_vapid_public_key_info() -> VapidPublicKeyOut:
    pub, _ = get_or_create_vapid_keys()
    return VapidPublicKeyOut(public_key=pub, enabled=True)


async def list_user_push_subscriptions(
    db: AsyncSession,
    user: User,
) -> list[PushSubscriptionOut]:
    res = await db.execute(
        select(PushSubscription)
        .where(PushSubscription.user_id == user.id)
        .order_by(PushSubscription.created_at.desc())
    )
    return [PushSubscriptionOut.model_validate(s) for s in res.scalars().all()]


async def upsert_push_subscription(
    db: AsyncSession,
    *,
    user: User,
    device_id: str | None,
    user_agent: str | None,
    body: PushSubscribeRequest,
) -> PushSubscriptionOut:
    endpoint = body.endpoint.strip()
    if not endpoint.startswith(("https://", "http://localhost", "http://127.0.0.1")):
        raise AppError(
            "INVALID_PUSH_ENDPOINT",
            "Web Push endpoint must use HTTPS (or localhost in dev).",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    now = datetime.now(timezone.utc)
    existing = (
        await db.execute(
            select(PushSubscription).where(PushSubscription.endpoint == endpoint)
        )
    ).scalar_one_or_none()

    if existing:
        existing.user_id = user.id
        existing.device_id = device_id
        existing.p256dh = body.keys.p256dh.strip()
        existing.auth_secret = body.keys.auth.strip()
        existing.local_decrypt_enabled = body.local_decrypt_enabled
        existing.user_agent = (user_agent or "")[:255] or existing.user_agent
        existing.updated_at = now
        await db.commit()
        await db.refresh(existing)
        return PushSubscriptionOut.model_validate(existing)

    sub = PushSubscription(
        user_id=user.id,
        device_id=device_id,
        endpoint=endpoint,
        p256dh=body.keys.p256dh.strip(),
        auth_secret=body.keys.auth.strip(),
        local_decrypt_enabled=body.local_decrypt_enabled,
        user_agent=(user_agent or "")[:255] or None,
        created_at=now,
        updated_at=now,
    )
    db.add(sub)
    await db.commit()
    await db.refresh(sub)
    return PushSubscriptionOut.model_validate(sub)


async def update_push_subscription_preferences(
    db: AsyncSession,
    *,
    user: User,
    subscription_id: str,
    body: PushSubscriptionUpdateRequest,
) -> PushSubscriptionOut:
    sub = (
        await db.execute(
            select(PushSubscription).where(
                PushSubscription.id == subscription_id,
                PushSubscription.user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    if not sub:
        raise AppError(
            "SUBSCRIPTION_NOT_FOUND",
            "Push subscription not found.",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    sub.local_decrypt_enabled = body.local_decrypt_enabled
    sub.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(sub)
    return PushSubscriptionOut.model_validate(sub)


async def remove_push_subscription(
    db: AsyncSession,
    *,
    user: User,
    endpoint: str | None = None,
    subscription_id: str | None = None,
) -> dict[str, str]:
    stmt = select(PushSubscription).where(PushSubscription.user_id == user.id)
    if subscription_id:
        stmt = stmt.where(PushSubscription.id == subscription_id)
    elif endpoint:
        stmt = stmt.where(PushSubscription.endpoint == endpoint.strip())
    else:
        raise AppError("MISSING_TARGET", "Provide subscription_id or endpoint.", status_code=400)

    rows = list((await db.execute(stmt)).scalars().all())
    for row in rows:
        await db.delete(row)
    await db.commit()
    return {"status": "unsubscribed", "removed": str(len(rows))}


def _send_webpush_sync(
    sub: PushSubscription,
    payload: dict[str, Any],
    vapid_private_key: str,
    vapid_subject: str,
) -> None:
    if _push_transport_override is not None:
        _push_transport_override(sub, payload)
        return

    webpush(
        subscription_info={
            "endpoint": sub.endpoint,
            "keys": {
                "p256dh": sub.p256dh,
                "auth": sub.auth_secret,
            },
        },
        data=json.dumps(payload, separators=(",", ":")),
        vapid_private_key=vapid_private_key,
        vapid_claims={"sub": vapid_subject},
        timeout=5,
    )


async def _deliver_payload_to_subscription(
    db: AsyncSession,
    sub: PushSubscription,
    payload: dict[str, Any],
) -> bool:
    settings = get_settings()
    _, priv_key = get_or_create_vapid_keys()
    try:
        await asyncio.to_thread(
            _send_webpush_sync,
            sub,
            payload,
            priv_key,
            settings.VAPID_SUBJECT,
        )
        metrics_registry.inc_counter("push_notifications_sent_total", 1)
        return True
    except WebPushException as exc:
        resp_code = getattr(getattr(exc, "response", None), "status_code", None)
        if resp_code in (404, 410):
            await db.delete(sub)
            await db.commit()
        logger.debug("WebPush delivery failed (%s): %s", resp_code, exc)
        return False
    except Exception as exc:
        logger.debug("WebPush delivery error: %s", exc)
        return False


def build_e2ee_safe_push_payload(
    *,
    local_decrypt_enabled: bool,
    conversation_id: str,
    message_out: MessageOut,
    sender_public_key: str,
    is_group: bool = False,
) -> dict[str, Any]:
    """Constructs an E2EE-preserving push notification payload (zero plaintext on server)."""
    base: dict[str, Any] = {
        "type": "new_message",
        "title": "RelayChat",
        "body": "New message",
        "conversation_id": conversation_id,
        "message_id": message_out.id,
        "created_at": message_out.created_at.isoformat(),
        "local_decrypt": bool(local_decrypt_enabled),
    }
    if local_decrypt_enabled:
        base.update(
            {
                "is_group": is_group,
                "sender_id": message_out.sender_id,
                "sender_global_id": message_out.sender_global_id,
                "sender_display_name": message_out.sender_display_name,
                "sender_public_key": sender_public_key,
                "ciphertext": message_out.ciphertext,
                "nonce": message_out.nonce,
                "message_type": message_out.type,
                "sender_key_version": message_out.sender_key_version,
            }
        )
    return base


async def dispatch_push_for_new_message(
    db: AsyncSession,
    *,
    sender: User,
    msg_out: MessageOut,
    recipient_ids: list[str],
    is_group: bool = False,
) -> int:
    targets = [uid for uid in recipient_ids if uid != sender.id]
    if not targets:
        return 0

    now = datetime.now(timezone.utc)
    # Load recipient ConversationMember mute flags + User global notification prefs
    mem_res = await db.execute(
        select(ConversationMember, User)
        .join(User, User.id == ConversationMember.user_id)
        .where(
            ConversationMember.conversation_id == msg_out.conversation_id,
            ConversationMember.user_id.in_(targets),
            User.is_local.is_(True),
        )
    )
    eligible_user_ids: set[str] = set()
    for mem, u in mem_res.all():
        if not u.notifications_enabled:
            continue
        if mem.is_muted:
            continue
        if mem.muted_until and mem.muted_until > now:
            continue
        eligible_user_ids.add(u.id)

    if not eligible_user_ids:
        return 0

    subs = list(
        (
            await db.execute(
                select(PushSubscription).where(
                    PushSubscription.user_id.in_(eligible_user_ids)
                )
            )
        ).scalars().all()
    )
    if not subs:
        return 0

    sent_count = 0
    for sub in subs:
        payload = build_e2ee_safe_push_payload(
            local_decrypt_enabled=sub.local_decrypt_enabled,
            conversation_id=msg_out.conversation_id,
            message_out=msg_out,
            sender_public_key=sender.public_key,
            is_group=is_group,
        )
        if await _deliver_payload_to_subscription(db, sub, payload):
            sent_count += 1
    return sent_count


async def send_test_push_notification(db: AsyncSession, user: User) -> dict[str, int]:
    subs = list(
        (
            await db.execute(
                select(PushSubscription).where(PushSubscription.user_id == user.id)
            )
        ).scalars().all()
    )
    delivered = 0
    for sub in subs:
        payload = {
            "type": "test",
            "title": "RelayChat",
            "body": "New message",
            "local_decrypt": False,
        }
        if await _deliver_payload_to_subscription(db, sub, payload):
            delivered += 1
    return {"subscriptions": len(subs), "delivered": delivered}
