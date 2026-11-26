from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, status
from fastapi.responses import FileResponse
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.errors import AppError
from app.core.metrics import metrics_registry
from app.core.rate_limit import api_rate_limit, federation_rate_limit
from app.db.session import get_db_session
from app.models.entities import (
    Attachment,
    ConversationMember,
    FederationOutbox,
    FederationPeer,
    User,
)
from app.schemas.federation import (
    FederationDomainRuleIn,
    FederationDomainRuleOut,
    FederationInboxAckOut,
    FederationInboxEnvelope,
    FederationOutboxItemOut,
    FederationPeerOut,
    FederationPolicyUpdateIn,
    FederationProbePeerIn,
    FederationStatusOut,
)
from app.services.attachment_service import _assembled_blob_path
from app.services.federation_inbox import process_federation_inbox_envelope
from app.services.federation_security import verify_and_record_federation_signature
from app.services.federation_service import (
    assert_domain_allowed,
    delete_domain_rule,
    discover_and_cache_peer,
    get_federation_status_summary,
    process_outbox_batch,
    retry_all_dead_letters,
    retry_outbox_item,
    set_federation_policy,
    upsert_domain_rule,
)

router = APIRouter(prefix="/federation", tags=["federation"])


def _require_admin(user: User) -> None:
    if not user.is_admin:
        raise AppError(
            "ADMIN_REQUIRED",
            "Node administrator privileges are required to modify federation policy.",
            status_code=status.HTTP_403_FORBIDDEN,
        )


# ---------------------------------------------------------------------------
# 1. Server-to-Server Endpoints (Ed25519 HTTP Signature Protected)
# ---------------------------------------------------------------------------
@router.post(
    "/inbox",
    response_model=FederationInboxAckOut,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(federation_rate_limit())],
)
async def post_federation_inbox(
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> FederationInboxAckOut:
    metrics_registry.inc_counter("federation_events_received_total", 1)
    raw_body = await request.body()
    origin_domain = (request.headers.get("x-federation-origin") or "").strip().lower()
    if not origin_domain:
        raise AppError(
            "FEDERATION_MISSING_ORIGIN",
            "Missing X-Federation-Origin header.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    await assert_domain_allowed(db, origin_domain)
    peer = await discover_and_cache_peer(db, origin_domain)

    verified_origin, _ = await verify_and_record_federation_signature(
        request,
        db,
        raw_body,
        peer.public_key_ed25519,
    )

    try:
        envelope = FederationInboxEnvelope.model_validate_json(raw_body)
    except ValidationError as exc:
        raise AppError(
            "INVALID_FEDERATION_PAYLOAD",
            "Invalid federation inbox JSON envelope.",
            status_code=status.HTTP_400_BAD_REQUEST,
        ) from exc

    if envelope.origin_domain.strip().lower() != verified_origin:
        raise AppError(
            "FEDERATION_ORIGIN_MISMATCH",
            "Envelope origin_domain does not match signed X-Federation-Origin header.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    await process_federation_inbox_envelope(db, verified_origin, envelope)

    now = datetime.now(timezone.utc)
    peer.last_seen_at = now
    peer.status = "online"
    peer.failure_count = 0
    peer.last_error = None
    peer.updated_at = now
    await db.commit()

    return FederationInboxAckOut(
        status="accepted",
        event_id=envelope.event_id,
        event_type=envelope.event_type,
        domain=verified_origin,
    )


@router.get("/attachments/{attachment_id}/download")
async def get_federation_attachment_blob(
    attachment_id: str,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> FileResponse:
    origin_domain = (request.headers.get("x-federation-origin") or "").strip().lower()
    if not origin_domain:
        raise AppError(
            "FEDERATION_MISSING_ORIGIN",
            "Missing X-Federation-Origin header.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    await assert_domain_allowed(db, origin_domain)
    peer = await discover_and_cache_peer(db, origin_domain)
    await verify_and_record_federation_signature(
        request,
        db,
        b"",
        peer.public_key_ed25519,
    )

    att = (
        await db.execute(
            select(Attachment).where(
                Attachment.id == attachment_id,
                Attachment.is_complete.is_(True),
            )
        )
    ).scalar_one_or_none()
    if not att:
        raise AppError("ATTACHMENT_NOT_FOUND", "Encrypted attachment not found.", status_code=404)

    # Authorize: at least one conversation participant must belong to `origin_domain`
    if att.conversation_id:
        domain_member = (
            await db.execute(
                select(ConversationMember.id)
                .join(User, User.id == ConversationMember.user_id)
                .where(
                    ConversationMember.conversation_id == att.conversation_id,
                    User.domain == origin_domain,
                )
                .limit(1)
            )
        ).scalar_one_or_none()
        if domain_member is None:
            raise AppError(
                "FORBIDDEN_ATTACHMENT_DOMAIN",
                f"No participant from '{origin_domain}' belongs to this attachment's conversation.",
                status_code=status.HTTP_403_FORBIDDEN,
            )

    blob_path = _assembled_blob_path(att.storage_key)
    if not blob_path.exists():
        raise AppError("BLOB_MISSING", "Encrypted blob not found on node disk.", status_code=404)

    await db.commit()
    return FileResponse(
        blob_path,
        media_type="application/octet-stream",
        headers={
            "X-RelayChat-Encrypted": "AES-256-GCM-Chunked",
            "X-RelayChat-Chunk-Size": str(att.chunk_size),
            "X-RelayChat-Chunk-Count": str(att.chunk_count),
        },
    )


# ---------------------------------------------------------------------------
# 2. Peer Status & Admin Policy Controls
# ---------------------------------------------------------------------------
@router.get(
    "/status",
    response_model=FederationStatusOut,
    dependencies=[Depends(api_rate_limit())],
)
async def get_status_dashboard(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> FederationStatusOut:
    return await get_federation_status_summary(db, current_user)


@router.get(
    "/peers",
    response_model=list[FederationPeerOut],
    dependencies=[Depends(api_rate_limit())],
)
async def list_peers(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> list[FederationPeerOut]:
    rows = (
        await db.execute(select(FederationPeer).order_by(FederationPeer.domain.asc()))
    ).scalars().all()
    return [FederationPeerOut.model_validate(p) for p in rows]


@router.post(
    "/peers/probe",
    response_model=FederationPeerOut,
    dependencies=[Depends(api_rate_limit())],
)
async def probe_remote_peer(
    body: FederationProbePeerIn,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> FederationPeerOut:
    _require_admin(current_user)
    peer = await discover_and_cache_peer(db, body.domain, force_refresh=True)
    return FederationPeerOut.model_validate(peer)


@router.put(
    "/policy",
    response_model=FederationStatusOut,
    dependencies=[Depends(api_rate_limit())],
)
async def update_policy(
    body: FederationPolicyUpdateIn,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> FederationStatusOut:
    _require_admin(current_user)
    await set_federation_policy(
        db,
        actor=current_user,
        mode=body.mode,
        allow_domains=body.allow_domains,
        block_domains=body.block_domains,
    )
    return await get_federation_status_summary(db, current_user)


@router.post(
    "/domains",
    response_model=FederationDomainRuleOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(api_rate_limit())],
)
async def add_or_update_domain_rule(
    body: FederationDomainRuleIn,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> FederationDomainRuleOut:
    _require_admin(current_user)
    rule = await upsert_domain_rule(
        db,
        actor=current_user,
        domain=body.domain,
        rule=body.rule,
        note=body.note,
    )
    return FederationDomainRuleOut.model_validate(rule)


@router.delete(
    "/domains/{domain}",
    dependencies=[Depends(api_rate_limit())],
)
async def remove_domain_rule_route(
    domain: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> dict[str, object]:
    _require_admin(current_user)
    removed = await delete_domain_rule(db, domain)
    return {"status": "removed" if removed else "noop", "domain": domain.strip().lower()}


@router.get(
    "/outbox",
    response_model=list[FederationOutboxItemOut],
    dependencies=[Depends(api_rate_limit())],
)
async def list_outbox_items(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> list[FederationOutboxItemOut]:
    _require_admin(current_user)
    stmt = select(FederationOutbox).order_by(FederationOutbox.created_at.desc()).limit(limit)
    if status_filter:
        stmt = stmt.where(FederationOutbox.status == status_filter.strip().lower())
    rows = (await db.execute(stmt)).scalars().all()
    return [FederationOutboxItemOut.model_validate(r) for r in rows]


@router.post(
    "/outbox/{outbox_id}/retry",
    response_model=FederationOutboxItemOut,
    dependencies=[Depends(api_rate_limit())],
)
async def post_retry_outbox_item(
    outbox_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> FederationOutboxItemOut:
    _require_admin(current_user)
    item = await retry_outbox_item(db, outbox_id)
    return FederationOutboxItemOut.model_validate(item)


@router.post(
    "/outbox/retry-dead-letters",
    dependencies=[Depends(api_rate_limit())],
)
async def post_retry_dead_letters(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> dict[str, int]:
    _require_admin(current_user)
    requeued = await retry_all_dead_letters(db)
    return {"requeued": requeued}


@router.post(
    "/outbox/flush",
    dependencies=[Depends(api_rate_limit())],
)
async def post_flush_outbox(
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict[str, int]:
    _require_admin(current_user)
    return await process_outbox_batch()
