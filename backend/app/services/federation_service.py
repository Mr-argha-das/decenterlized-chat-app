"""
Phase 8 Federation Core Service:
- Domain allow-list / block-list policy enforcement
- Remote node discovery (`/.well-known/node-info`, `/.well-known/node-key`)
- Remote user resolution (`/.well-known/user/{username}`) with DB TTL cache (`remote_users`)
- Outbox queue (`federation_outbox`) with retries, exponential backoff, and dead-lettering
- S2S encrypted attachment blob streaming & verification
"""
import asyncio
import base64
import hashlib
import json
import logging
import uuid
from collections.abc import Iterable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import AppError
from app.core.security import get_node_public_key_b64
from app.db.session import AsyncSessionLocal
from app.models.entities import (
    Attachment,
    FederationDomainRule,
    FederationOutbox,
    FederationPeer,
    FederationPolicySetting,
    RemoteUserCache,
    User,
)
from app.schemas.federation import (
    FederationDomainRuleOut,
    FederationOutboxItemOut,
    FederationOutboxStatsOut,
    FederationPeerOut,
    FederationStatusOut,
    PolicyMode,
)
from app.schemas.user import validate_p256_public_key
from app.services.federation_security import (
    resolve_domain_base_url,
    sign_federation_request,
    validate_federation_url,
)

logger = logging.getLogger("relaychat.federation")

import weakref

POLICY_MODE_KEY = "policy_mode"
_outbox_wakeup_events: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Event]" = (
    weakref.WeakKeyDictionary()
)


def _ensure_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def get_outbox_wakeup_event() -> asyncio.Event:
    loop = asyncio.get_running_loop()
    ev = _outbox_wakeup_events.get(loop)
    if ev is None:
        ev = asyncio.Event()
        _outbox_wakeup_events[loop] = ev
    return ev


def trigger_outbox_wakeup() -> None:
    try:
        ev = get_outbox_wakeup_event()
        ev.set()
    except RuntimeError:
        pass


def _validate_ed25519_pubkey_b64(pub_b64: str) -> str:
    cleaned = pub_b64.strip()
    try:
        raw = base64.b64decode(cleaned)
    except Exception as exc:
        raise AppError(
            "FEDERATION_INVALID_PEER_KEY",
            "Remote node Ed25519 public key is not valid base64.",
            status_code=status.HTTP_502_BAD_GATEWAY,
        ) from exc
    if len(raw) != 32:
        raise AppError(
            "FEDERATION_INVALID_PEER_KEY",
            "Remote node Ed25519 public key must be 32 raw bytes.",
            status_code=status.HTTP_502_BAD_GATEWAY,
        )
    return cleaned


# ---------------------------------------------------------------------------
# 1. Domain Policy (open / allowlist / denylist) & Rules
# ---------------------------------------------------------------------------
async def get_federation_policy_mode(db: AsyncSession) -> PolicyMode:
    row = (
        await db.execute(
            select(FederationPolicySetting).where(
                FederationPolicySetting.key == POLICY_MODE_KEY
            )
        )
    ).scalar_one_or_none()
    raw = (row.value if row else get_settings().FEDERATION_DEFAULT_POLICY_MODE).strip().lower()
    if raw in ("open", "allowlist", "denylist"):
        return raw  # type: ignore[return-value]
    return "open"


async def is_domain_allowed(db: AsyncSession, domain: str) -> tuple[bool, str | None]:
    settings = get_settings()
    norm = domain.strip().lower()
    if not settings.FEDERATION_ENABLED:
        return False, "Federation is disabled on this node."
    if norm == settings.APP_DOMAIN.lower():
        return True, None

    # Check explicit peer block flag
    peer = (
        await db.execute(select(FederationPeer).where(FederationPeer.domain == norm))
    ).scalar_one_or_none()
    if peer and peer.is_blocked:
        return False, f"Domain '{norm}' is blocked by node policy."

    # Check DB domain rules + initial env rules
    rules_rows = (await db.execute(select(FederationDomainRule))).scalars().all()
    allow_set = set(settings.initial_allow_domains)
    block_set = set(settings.initial_block_domains)
    for r in rules_rows:
        d = r.domain.strip().lower()
        if r.rule == "allow":
            allow_set.add(d)
            block_set.discard(d)
        elif r.rule == "block":
            block_set.add(d)
            allow_set.discard(d)

    if norm in block_set:
        return False, f"Domain '{norm}' is on this node's block-list."

    mode = await get_federation_policy_mode(db)
    if mode == "allowlist" and norm not in allow_set:
        return False, f"Domain '{norm}' is not on this node's federation allow-list."

    return True, None


async def assert_domain_allowed(db: AsyncSession, domain: str) -> None:
    allowed, reason = await is_domain_allowed(db, domain)
    if not allowed:
        raise AppError(
            "FEDERATION_DOMAIN_BLOCKED",
            reason or f"Federation with '{domain}' is not permitted.",
            status_code=status.HTTP_403_FORBIDDEN,
        )


async def set_federation_policy(
    db: AsyncSession,
    *,
    actor: User,
    mode: PolicyMode,
    allow_domains: list[str] | None = None,
    block_domains: list[str] | None = None,
) -> None:
    now = datetime.now(timezone.utc)
    setting = (
        await db.execute(
            select(FederationPolicySetting).where(
                FederationPolicySetting.key == POLICY_MODE_KEY
            )
        )
    ).scalar_one_or_none()
    if setting:
        setting.value = mode
        setting.updated_at = now
    else:
        db.add(FederationPolicySetting(key=POLICY_MODE_KEY, value=mode, updated_at=now))

    if allow_domains is not None:
        existing_allows = (
            await db.execute(
                select(FederationDomainRule).where(FederationDomainRule.rule == "allow")
            )
        ).scalars().all()
        desired_allows = {d.strip().lower() for d in allow_domains if d.strip()}
        for row in existing_allows:
            if row.domain not in desired_allows:
                await db.delete(row)
        for dom in desired_allows:
            await upsert_domain_rule(db, actor=actor, domain=dom, rule="allow", commit=False)

    if block_domains is not None:
        existing_blocks = (
            await db.execute(
                select(FederationDomainRule).where(FederationDomainRule.rule == "block")
            )
        ).scalars().all()
        desired_blocks = {d.strip().lower() for d in block_domains if d.strip()}
        for row in existing_blocks:
            if row.domain not in desired_blocks:
                peer = (
                    await db.execute(
                        select(FederationPeer).where(FederationPeer.domain == row.domain)
                    )
                ).scalar_one_or_none()
                if peer:
                    peer.is_blocked = False
                    if peer.status == "blocked":
                        peer.status = "online"
                await db.delete(row)
        for dom in desired_blocks:
            await upsert_domain_rule(db, actor=actor, domain=dom, rule="block", commit=False)

    await db.commit()


async def upsert_domain_rule(
    db: AsyncSession,
    *,
    actor: User,
    domain: str,
    rule: str,
    note: str | None = None,
    commit: bool = True,
) -> FederationDomainRule:
    norm = domain.strip().lower()
    if norm == get_settings().APP_DOMAIN.lower():
        raise AppError(
            "INVALID_FEDERATION_DOMAIN",
            "Cannot add local node domain to remote domain policy rules.",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    existing = (
        await db.execute(
            select(FederationDomainRule).where(FederationDomainRule.domain == norm)
        )
    ).scalar_one_or_none()
    now = datetime.now(timezone.utc)
    if existing:
        existing.rule = rule
        if note is not None:
            existing.note = note
    else:
        existing = FederationDomainRule(
            domain=norm,
            rule=rule,
            note=note,
            created_by_id=actor.id,
            created_at=now,
        )
        db.add(existing)

    peer = (
        await db.execute(select(FederationPeer).where(FederationPeer.domain == norm))
    ).scalar_one_or_none()
    if peer:
        if rule == "block":
            peer.is_blocked = True
            peer.status = "blocked"
        elif rule == "allow":
            peer.is_blocked = False
            peer.is_trusted = True
            if peer.status == "blocked":
                peer.status = "online"
        peer.updated_at = now

    if commit:
        await db.commit()
        await db.refresh(existing)
    else:
        await db.flush()
    return existing


async def delete_domain_rule(db: AsyncSession, domain: str) -> bool:
    norm = domain.strip().lower()
    existing = (
        await db.execute(
            select(FederationDomainRule).where(FederationDomainRule.domain == norm)
        )
    ).scalar_one_or_none()
    peer = (
        await db.execute(select(FederationPeer).where(FederationPeer.domain == norm))
    ).scalar_one_or_none()
    if peer and peer.is_blocked:
        peer.is_blocked = False
        if peer.status == "blocked":
            peer.status = "online"

    if not existing:
        await db.commit()
        return False

    await db.delete(existing)
    await db.commit()
    return True


# ---------------------------------------------------------------------------
# 2. Remote Node Discovery (`/.well-known/node-info` & `/.well-known/node-key`)
# ---------------------------------------------------------------------------
async def discover_and_cache_peer(
    db: AsyncSession,
    domain: str,
    *,
    force_refresh: bool = False,
) -> FederationPeer:
    settings = get_settings()
    norm = domain.strip().lower()
    await assert_domain_allowed(db, norm)

    existing = (
        await db.execute(select(FederationPeer).where(FederationPeer.domain == norm))
    ).scalar_one_or_none()
    now = datetime.now(timezone.utc)

    if existing and not force_refresh and existing.public_key_ed25519:
        return existing

    base_url = resolve_domain_base_url(norm)
    node_info_url = f"{base_url}/.well-known/node-info"
    node_key_url = f"{base_url}/.well-known/node-key"

    await validate_federation_url(node_info_url)
    timeout = httpx.Timeout(
        settings.FEDERATION_HTTP_TIMEOUT_SECONDS,
        connect=min(3.0, settings.FEDERATION_HTTP_TIMEOUT_SECONDS),
    )

    payload: dict[str, Any] | None = None
    last_err = ""
    async with httpx.AsyncClient(follow_redirects=False, timeout=timeout) as client:
        for candidate_url in (node_info_url, node_key_url):
            try:
                await validate_federation_url(candidate_url)
                resp = await client.get(candidate_url, headers={"Accept": "application/json"})
                if resp.status_code == 200:
                    payload = resp.json()
                    break
                last_err = f"HTTP {resp.status_code} from {candidate_url}"
            except AppError:
                raise
            except Exception as exc:
                last_err = str(exc)

    if not payload:
        if existing:
            existing.failure_count = (existing.failure_count or 0) + 1
            existing.status = "unreachable"
            existing.last_error = last_err or "Node discovery failed"
            existing.updated_at = now
            await db.commit()
        raise AppError(
            "FEDERATION_UNREACHABLE",
            f"Could not reach federated node '{norm}': {last_err or 'unreachable'}",
            status_code=status.HTTP_502_BAD_GATEWAY,
        )

    reported_domain = str(payload.get("domain") or "").strip().lower()
    if reported_domain and reported_domain != norm:
        raise AppError(
            "FEDERATION_DOMAIN_MISMATCH",
            f"Remote node at '{norm}' claimed mismatched domain '{reported_domain}'.",
            status_code=status.HTTP_502_BAD_GATEWAY,
        )

    pub_key = _validate_ed25519_pubkey_b64(
        str(payload.get("public_key_ed25519") or payload.get("public_key") or "")
    )
    # Use mapped base_url if configured so internal Docker/test network URLs remain routable
    mapped_override = settings.federation_domain_map.get(norm)
    effective_node_url = (
        mapped_override.rstrip("/")
        if mapped_override
        else str(payload.get("node_url") or base_url).rstrip("/")
    )
    effective_inbox_url = (
        f"{mapped_override.rstrip('/')}/federation/inbox"
        if mapped_override
        else str(payload.get("federation_inbox_url") or f"{effective_node_url}/federation/inbox")
    )

    if existing:
        existing.node_url = effective_node_url
        existing.inbox_url = effective_inbox_url
        existing.public_key_ed25519 = pub_key
        existing.status = "blocked" if existing.is_blocked else "online"
        existing.failure_count = 0
        existing.last_error = None
        existing.last_seen_at = now
        existing.updated_at = now
        peer = existing
    else:
        peer = FederationPeer(
            domain=norm,
            node_url=effective_node_url,
            inbox_url=effective_inbox_url,
            public_key_ed25519=pub_key,
            status="online",
            is_trusted=True,
            is_blocked=False,
            last_seen_at=now,
            failure_count=0,
            created_at=now,
            updated_at=now,
        )
        db.add(peer)

    await db.commit()
    await db.refresh(peer)
    return peer


# ---------------------------------------------------------------------------
# 3. Remote User Discovery with TTL Cache (`GET /.well-known/user/{username}`)
# ---------------------------------------------------------------------------
async def resolve_remote_user(
    db: AsyncSession,
    username: str,
    domain: str,
    *,
    force_refresh: bool = False,
) -> User:
    settings = get_settings()
    norm_user = username.strip().lower()
    norm_domain = domain.strip().lower()
    global_id = f"{norm_user}@{norm_domain}"

    await assert_domain_allowed(db, norm_domain)

    now = datetime.now(timezone.utc)
    cache_row = (
        await db.execute(
            select(RemoteUserCache).where(RemoteUserCache.global_id == global_id)
        )
    ).scalar_one_or_none()

    if cache_row and not force_refresh and _ensure_utc(cache_row.expires_at) > now:
        cached_u = (
            await db.execute(select(User).where(User.id == cache_row.user_id))
        ).scalar_one_or_none()
        if cached_u:
            return cached_u

    # Ensure peer node Ed25519 identity is discovered & cached
    peer = await discover_and_cache_peer(db, norm_domain, force_refresh=force_refresh)

    base_url = resolve_domain_base_url(norm_domain)
    user_url = f"{base_url}/.well-known/user/{norm_user}"
    await validate_federation_url(user_url)

    timeout = httpx.Timeout(
        settings.FEDERATION_HTTP_TIMEOUT_SECONDS,
        connect=min(3.0, settings.FEDERATION_HTTP_TIMEOUT_SECONDS),
    )

    try:
        async with httpx.AsyncClient(follow_redirects=False, timeout=timeout) as client:
            resp = await client.get(user_url, headers={"Accept": "application/json"})
    except Exception as exc:
        # Graceful stale-cache fallback if remote node is temporarily offline
        if cache_row:
            stale_u = (
                await db.execute(select(User).where(User.id == cache_row.user_id))
            ).scalar_one_or_none()
            if stale_u:
                return stale_u
        raise AppError(
            "FEDERATION_UNREACHABLE",
            f"Failed to query remote user '{global_id}': {exc}",
            status_code=status.HTTP_502_BAD_GATEWAY,
        ) from exc

    if resp.status_code == 404:
        raise AppError(
            "USER_NOT_FOUND",
            f"Remote user '{global_id}' does not exist on '{norm_domain}'.",
            status_code=status.HTTP_404_NOT_FOUND,
        )
    if resp.status_code != 200:
        raise AppError(
            "FEDERATION_LOOKUP_FAILED",
            f"Remote node '{norm_domain}' returned HTTP {resp.status_code} for '{global_id}'.",
            status_code=status.HTTP_502_BAD_GATEWAY,
        )

    data = resp.json()
    resp_global_id = str(data.get("global_id") or data.get("id") or "").strip().lower()
    if resp_global_id != global_id:
        raise AppError(
            "FEDERATION_IDENTITY_MISMATCH",
            f"Remote node returned mismatched identity '{resp_global_id}' for '{global_id}'.",
            status_code=status.HTTP_502_BAD_GATEWAY,
        )

    try:
        validated_pubkey = validate_p256_public_key(str(data.get("public_key") or ""))
    except ValueError as exc:
        raise AppError(
            "FEDERATION_INVALID_USER_KEY",
            f"Remote user '{global_id}' published an invalid P-256 public key: {exc}",
            status_code=status.HTTP_502_BAD_GATEWAY,
        ) from exc

    display_name = str(data.get("display_name") or norm_user).strip()[:80] or norm_user
    about = str(data.get("about") or "")[:255]
    avatar_url_raw = data.get("avatar_url")
    avatar_url = str(avatar_url_raw)[:512] if avatar_url_raw else None

    mapped_override = settings.federation_domain_map.get(norm_domain)
    effective_node_url = (
        mapped_override.rstrip("/")
        if mapped_override
        else str(data.get("node_url") or data.get("node") or peer.node_url).rstrip("/")
    )
    effective_inbox_url = (
        f"{mapped_override.rstrip('/')}/federation/inbox"
        if mapped_override
        else str(data.get("federation_inbox_url") or peer.inbox_url or f"{effective_node_url}/federation/inbox")
    )

    user_row = (
        await db.execute(select(User).where(User.global_id == global_id))
    ).scalar_one_or_none()

    if user_row:
        user_row.public_key = validated_pubkey
        user_row.display_name = display_name
        user_row.about = about
        user_row.avatar_url = avatar_url
        user_row.node_url = effective_node_url
        user_row.is_local = False
        user_row.updated_at = now
    else:
        preferred_id: str | None = None
        raw_uuid = str(data.get("user_uuid") or "").strip()
        if raw_uuid:
            try:
                uuid.UUID(raw_uuid)
                collision = (
                    await db.execute(select(User.id).where(User.id == raw_uuid))
                ).scalar_one_or_none()
                if not collision:
                    preferred_id = raw_uuid
            except ValueError:
                preferred_id = None

        if not preferred_id:
            det_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"relaychat:{global_id}"))
            collision = (
                await db.execute(select(User.id).where(User.id == det_id))
            ).scalar_one_or_none()
            preferred_id = det_id if not collision else str(uuid.uuid4())

        user_row = User(
            id=preferred_id,
            username=norm_user,
            domain=norm_domain,
            global_id=global_id,
            password_hash=None,
            public_key=validated_pubkey,
            display_name=display_name,
            about=about,
            avatar_url=avatar_url,
            is_local=False,
            is_admin=False,
            node_url=effective_node_url,
            is_online=False,
            created_at=now,
            updated_at=now,
        )
        db.add(user_row)
        await db.flush()

    expires_at = now + timedelta(seconds=settings.FEDERATION_USER_CACHE_TTL_SECONDS)
    if cache_row:
        cache_row.user_id = user_row.id
        cache_row.display_name = display_name
        cache_row.about = about
        cache_row.avatar_url = avatar_url
        cache_row.public_key = validated_pubkey
        cache_row.node_url = effective_node_url
        cache_row.inbox_url = effective_inbox_url
        cache_row.fetched_at = now
        cache_row.expires_at = expires_at
    else:
        db.add(
            RemoteUserCache(
                user_id=user_row.id,
                global_id=global_id,
                username=norm_user,
                domain=norm_domain,
                display_name=display_name,
                about=about,
                avatar_url=avatar_url,
                public_key=validated_pubkey,
                node_url=effective_node_url,
                inbox_url=effective_inbox_url,
                fetched_at=now,
                expires_at=expires_at,
            )
        )

    await db.commit()
    await db.refresh(user_row)
    return user_row


# ---------------------------------------------------------------------------
# 4. Outbox Enqueueing, Exponential Backoff Delivery & Dead-Letter Worker
# ---------------------------------------------------------------------------
async def _resolve_inbox_url_for_domain(db: AsyncSession, target_domain: str) -> str:
    settings = get_settings()
    norm = target_domain.strip().lower()
    mapped = settings.federation_domain_map.get(norm)
    if mapped:
        return f"{mapped.rstrip('/')}/federation/inbox"

    peer = (
        await db.execute(select(FederationPeer).where(FederationPeer.domain == norm))
    ).scalar_one_or_none()
    if peer and peer.inbox_url:
        return peer.inbox_url
    if peer and peer.node_url:
        return f"{peer.node_url.rstrip('/')}/federation/inbox"

    base = resolve_domain_base_url(norm)
    return f"{base}/federation/inbox"


async def enqueue_federation_event(
    db: AsyncSession,
    *,
    target_domain: str,
    event_type: str,
    data: dict[str, Any],
    target_inbox_url: str | None = None,
    event_id: str | None = None,
    commit: bool = True,
) -> FederationOutbox | None:
    settings = get_settings()
    norm_domain = target_domain.strip().lower()
    if not settings.FEDERATION_ENABLED or norm_domain == settings.APP_DOMAIN.lower():
        return None

    allowed, _ = await is_domain_allowed(db, norm_domain)
    if not allowed:
        logger.warning("Skipping outbound federation event '%s' to blocked domain '%s'", event_type, norm_domain)
        return None

    now = datetime.now(timezone.utc)
    ev_id = event_id or f"fed_{uuid.uuid4().hex}"
    inbox_url = target_inbox_url or await _resolve_inbox_url_for_domain(db, norm_domain)

    envelope = {
        "event_id": ev_id,
        "event_type": event_type,
        "origin_domain": settings.APP_DOMAIN.lower(),
        "timestamp": now.isoformat(),
        "data": data,
    }

    item = FederationOutbox(
        event_id=ev_id,
        target_domain=norm_domain,
        target_inbox_url=inbox_url,
        event_type=event_type,
        payload_json=json.dumps(envelope, separators=(",", ":"), default=str),
        status="pending",
        attempts=0,
        max_attempts=settings.FEDERATION_OUTBOX_MAX_ATTEMPTS,
        next_retry_at=now,
        created_at=now,
    )
    db.add(item)
    if commit:
        await db.commit()
        await db.refresh(item)
        trigger_outbox_wakeup()
    else:
        await db.flush()
    return item


async def enqueue_for_remote_users(
    db: AsyncSession,
    users: Iterable[User],
    *,
    event_type: str,
    data: dict[str, Any],
    exclude_domain: str | None = None,
    commit: bool = True,
) -> list[FederationOutbox]:
    settings = get_settings()
    local_dom = settings.APP_DOMAIN.lower()
    excl = exclude_domain.strip().lower() if exclude_domain else None

    target_domains: set[str] = set()
    for u in users:
        dom = u.domain.strip().lower()
        if not u.is_local and dom != local_dom and dom != excl:
            target_domains.add(dom)

    items: list[FederationOutbox] = []
    for dom in sorted(target_domains):
        queued = await enqueue_federation_event(
            db,
            target_domain=dom,
            event_type=event_type,
            data=data,
            commit=False,
        )
        if queued is not None:
            items.append(queued)

    if items and commit:
        await db.commit()
        trigger_outbox_wakeup()
    return items


async def deliver_single_outbox_item(db: AsyncSession, item: FederationOutbox) -> bool:
    settings = get_settings()
    now = datetime.now(timezone.utc)
    norm_domain = item.target_domain.strip().lower()

    allowed, block_reason = await is_domain_allowed(db, norm_domain)
    if not allowed:
        item.status = "dead_letter"
        item.dead_lettered_at = now
        item.last_error = block_reason or "Domain blocked by policy"
        await db.commit()
        return False

    # Refresh inbox URL from domain map if present
    mapped = settings.federation_domain_map.get(norm_domain)
    inbox_url = (
        f"{mapped.rstrip('/')}/federation/inbox" if mapped else item.target_inbox_url
    )
    item.target_inbox_url = inbox_url
    item.status = "processing"
    await db.flush()

    raw_body = item.payload_json.encode("utf-8")
    err_detail = ""
    delivered_ok = False

    try:
        await validate_federation_url(inbox_url)
        headers = sign_federation_request(
            "POST",
            inbox_url,
            raw_body,
            target_domain=norm_domain,
        )
        timeout = httpx.Timeout(
            settings.FEDERATION_HTTP_TIMEOUT_SECONDS,
            connect=min(3.0, settings.FEDERATION_HTTP_TIMEOUT_SECONDS),
        )
        async with httpx.AsyncClient(follow_redirects=False, timeout=timeout) as client:
            resp = await client.post(inbox_url, content=raw_body, headers=headers)

        if 200 <= resp.status_code < 300:
            delivered_ok = True
        else:
            err_detail = f"HTTP {resp.status_code}: {resp.text[:300]}"
    except Exception as exc:
        err_detail = str(exc)[:500]

    peer = (
        await db.execute(
            select(FederationPeer).where(FederationPeer.domain == norm_domain)
        )
    ).scalar_one_or_none()

    if delivered_ok:
        item.status = "delivered"
        item.delivered_at = now
        item.last_error = None
        if peer:
            peer.status = "online"
            peer.failure_count = 0
            peer.last_error = None
            peer.last_seen_at = now
            peer.updated_at = now
        await db.commit()
        return True

    # Failure -> increment attempts, compute exponential backoff or dead-letter
    item.attempts = (item.attempts or 0) + 1
    item.last_error = err_detail or "Delivery failed"
    max_tries = item.max_attempts or settings.FEDERATION_OUTBOX_MAX_ATTEMPTS

    if item.attempts >= max_tries:
        item.status = "dead_letter"
        item.dead_lettered_at = now
        if peer:
            peer.failure_count = (peer.failure_count or 0) + 1
            peer.status = "unreachable"
            peer.last_error = item.last_error
            peer.updated_at = now
    else:
        backoff = min(
            settings.FEDERATION_OUTBOX_MAX_DELAY_SECONDS,
            settings.FEDERATION_OUTBOX_BASE_DELAY_SECONDS * (2 ** (item.attempts - 1)),
        )
        item.status = "pending"
        item.next_retry_at = now + timedelta(seconds=backoff)
        if peer:
            peer.failure_count = (peer.failure_count or 0) + 1
            peer.status = "degraded"
            peer.last_error = item.last_error
            peer.updated_at = now

    await db.commit()
    return False


async def process_outbox_batch(batch_size: int = 30) -> dict[str, int]:
    now = datetime.now(timezone.utc)
    delivered = 0
    failed = 0
    dead_lettered = 0

    async with AsyncSessionLocal() as db:
        rows = list(
            (
                await db.execute(
                    select(FederationOutbox)
                    .where(
                        FederationOutbox.status == "pending",
                        FederationOutbox.next_retry_at <= now,
                    )
                    .order_by(FederationOutbox.created_at.asc())
                    .limit(batch_size)
                )
            )
            .scalars()
            .all()
        )

        for item in rows:
            ok = await deliver_single_outbox_item(db, item)
            if ok:
                delivered += 1
            elif item.status == "dead_letter":
                dead_lettered += 1
            else:
                failed += 1

    return {
        "processed": len(rows),
        "delivered": delivered,
        "retrying": failed,
        "dead_lettered": dead_lettered,
    }


async def outbox_worker_loop(stop_event: asyncio.Event) -> None:
    """Background async loop delivering queued federation events with backoff."""
    wakeup = get_outbox_wakeup_event()
    while not stop_event.is_set():
        try:
            await process_outbox_batch()
        except Exception as exc:
            logger.warning("Federation outbox worker error: %s", exc)

        poll_interval = max(0.05, get_settings().FEDERATION_OUTBOX_POLL_INTERVAL_SECONDS)
        wakeup.clear()
        done, pending = await asyncio.wait(
            [
                asyncio.create_task(stop_event.wait()),
                asyncio.create_task(wakeup.wait()),
            ],
            timeout=poll_interval,
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
        if stop_event.is_set():
            break


async def retry_outbox_item(db: AsyncSession, outbox_id: str) -> FederationOutbox:
    item = (
        await db.execute(select(FederationOutbox).where(FederationOutbox.id == outbox_id))
    ).scalar_one_or_none()
    if not item:
        raise AppError("OUTBOX_ITEM_NOT_FOUND", "Outbox entry was not found.", status_code=404)

    now = datetime.now(timezone.utc)
    item.status = "pending"
    item.attempts = 0
    item.dead_lettered_at = None
    item.next_retry_at = now
    await db.commit()
    await db.refresh(item)
    trigger_outbox_wakeup()
    return item


async def retry_all_dead_letters(db: AsyncSession) -> int:
    now = datetime.now(timezone.utc)
    rows = list(
        (
            await db.execute(
                select(FederationOutbox).where(FederationOutbox.status == "dead_letter")
            )
        )
        .scalars()
        .all()
    )
    for r in rows:
        r.status = "pending"
        r.attempts = 0
        r.dead_lettered_at = None
        r.next_retry_at = now
    await db.commit()
    if rows:
        trigger_outbox_wakeup()
    return len(rows)


# ---------------------------------------------------------------------------
# 5. Remote Encrypted Blob Streaming (`GET /federation/attachments/{id}/download`)
# ---------------------------------------------------------------------------
async def fetch_and_cache_remote_attachment_blob(
    db: AsyncSession,
    att: Attachment,
    dest_blob_path: Path,
) -> Path:
    if dest_blob_path.exists():
        return dest_blob_path

    origin_domain = (att.origin_domain or "").strip().lower()
    if not origin_domain:
        raise AppError(
            "REMOTE_ATTACHMENT_UNAVAILABLE",
            "Attachment is missing remote origin domain.",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    await assert_domain_allowed(db, origin_domain)
    settings = get_settings()
    remote_id = att.remote_attachment_id or att.id
    mapped = settings.federation_domain_map.get(origin_domain)

    if mapped:
        download_url = f"{mapped.rstrip('/')}/federation/attachments/{remote_id}/download"
    elif att.remote_download_url:
        download_url = att.remote_download_url
    else:
        base = resolve_domain_base_url(origin_domain)
        download_url = f"{base}/federation/attachments/{remote_id}/download"

    await validate_federation_url(download_url)
    headers = sign_federation_request(
        "GET",
        download_url,
        b"",
        target_domain=origin_domain,
    )
    timeout = httpx.Timeout(max(15.0, settings.FEDERATION_HTTP_TIMEOUT_SECONDS), connect=5.0)
    async with httpx.AsyncClient(follow_redirects=False, timeout=timeout) as client:
        resp = await client.get(download_url, headers=headers)

    if resp.status_code != 200:
        raise AppError(
            "FEDERATION_ATTACHMENT_FETCH_FAILED",
            f"Remote node '{origin_domain}' returned HTTP {resp.status_code} for encrypted attachment.",
            status_code=status.HTTP_502_BAD_GATEWAY,
        )

    cipher_bytes = resp.content
    if len(cipher_bytes) > settings.MAX_UPLOAD_BYTES + 1024 * 64:
        raise AppError(
            "FILE_TOO_LARGE",
            "Remote encrypted attachment exceeds maximum allowed size.",
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
        )

    if att.sha256_ciphertext:
        actual_sha = hashlib.sha256(cipher_bytes).hexdigest()
        if actual_sha.lower() != att.sha256_ciphertext.lower():
            raise AppError(
                "FEDERATION_ATTACHMENT_HASH_MISMATCH",
                "Downloaded encrypted blob failed SHA-256 integrity check.",
                status_code=status.HTTP_502_BAD_GATEWAY,
            )

    dest_blob_path.parent.mkdir(parents=True, exist_ok=True)
    dest_blob_path.write_bytes(cipher_bytes)
    return dest_blob_path


# ---------------------------------------------------------------------------
# 6. Admin Status & Peer Dashboard Summary
# ---------------------------------------------------------------------------
async def get_federation_status_summary(
    db: AsyncSession,
    viewer: User,
) -> FederationStatusOut:
    settings = get_settings()
    mode = await get_federation_policy_mode(db)
    rules = list(
        (
            await db.execute(
                select(FederationDomainRule).order_by(FederationDomainRule.domain.asc())
            )
        )
        .scalars()
        .all()
    )
    peers = list(
        (
            await db.execute(
                select(FederationPeer).order_by(FederationPeer.domain.asc())
            )
        )
        .scalars()
        .all()
    )

    counts_rows = (
        await db.execute(
            select(FederationOutbox.status, func.count(FederationOutbox.id)).group_by(
                FederationOutbox.status
            )
        )
    ).all()
    counts_map = {str(st): int(cnt) for st, cnt in counts_rows}

    recent_outbox = list(
        (
            await db.execute(
                select(FederationOutbox)
                .order_by(FederationOutbox.created_at.desc())
                .limit(20)
            )
        )
        .scalars()
        .all()
    )

    remote_users_cnt = int(
        (await db.execute(select(func.count(RemoteUserCache.id)))).scalar_one() or 0
    )

    return FederationStatusOut(
        domain=settings.APP_DOMAIN,
        app_name=settings.APP_NAME,
        node_url=settings.NODE_PUBLIC_URL.rstrip("/"),
        public_key_ed25519=get_node_public_key_b64(),
        federation_enabled=settings.FEDERATION_ENABLED,
        policy_mode=mode,
        can_manage=bool(viewer.is_admin),
        rules=[FederationDomainRuleOut.model_validate(r) for r in rules],
        peers=[FederationPeerOut.model_validate(p) for p in peers],
        outbox_stats=FederationOutboxStatsOut(
            pending=counts_map.get("pending", 0),
            processing=counts_map.get("processing", 0),
            delivered=counts_map.get("delivered", 0),
            dead_letter=counts_map.get("dead_letter", 0) + counts_map.get("failed", 0),
        ),
        recent_outbox=[FederationOutboxItemOut.model_validate(o) for o in recent_outbox],
        cached_remote_users=remote_users_cnt,
    )
