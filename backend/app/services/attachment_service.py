import hashlib
import hmac
import math
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import AppError
from app.models.entities import Attachment, ConversationMember, User
from app.schemas.attachments import (
    ALLOWED_ATTACHMENT_MIMES,
    AttachmentChunkUploadOut,
    AttachmentInitOut,
    AttachmentInitRequest,
    AttachmentOut,
    SignedChunkUploadSlot,
    StorageQuotaOut,
    normalize_mime_type,
)
from app.services.privacy_service import assert_not_blocked_for_messaging

AES_GCM_TAG_BYTES = 16


def _blobs_root() -> Path:
    root = get_settings().storage_path / "encrypted_blobs"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _staging_dir(storage_key: str) -> Path:
    return _blobs_root() / "staging" / storage_key


def _assembled_blob_path(storage_key: str) -> Path:
    p = _blobs_root() / "objects"
    p.mkdir(parents=True, exist_ok=True)
    return p / f"{storage_key}.enc"


def sign_chunk_upload_token(
    attachment_id: str,
    uploader_id: str,
    chunk_index: int,
    expires_epoch: int,
) -> str:
    secret = get_settings().UPLOAD_SIGNING_SECRET.encode("utf-8")
    msg = f"upload:v1:{attachment_id}:{uploader_id}:{chunk_index}:{expires_epoch}".encode("utf-8")
    return hmac.new(secret, msg, hashlib.sha256).hexdigest()


def verify_chunk_upload_token(
    attachment_id: str,
    uploader_id: str,
    chunk_index: int,
    expires_epoch: int,
    signature: str,
) -> bool:
    now_epoch = int(datetime.now(timezone.utc).timestamp())
    if expires_epoch < now_epoch:
        return False
    expected = sign_chunk_upload_token(attachment_id, uploader_id, chunk_index, expires_epoch)
    return hmac.compare_digest(expected, signature)


def sign_download_token(attachment_id: str, expires_epoch: int) -> str:
    secret = get_settings().UPLOAD_SIGNING_SECRET.encode("utf-8")
    msg = f"download:v1:{attachment_id}:{expires_epoch}".encode("utf-8")
    return hmac.new(secret, msg, hashlib.sha256).hexdigest()


def verify_download_token(attachment_id: str, expires_epoch: int, signature: str) -> bool:
    now_epoch = int(datetime.now(timezone.utc).timestamp())
    if expires_epoch < now_epoch:
        return False
    expected = sign_download_token(attachment_id, expires_epoch)
    return hmac.compare_digest(expected, signature)


def build_signed_download_url(attachment_id: str) -> str:
    expires_epoch = int((datetime.now(timezone.utc) + timedelta(hours=24)).timestamp())
    sig = sign_download_token(attachment_id, expires_epoch)
    return f"/attachments/{attachment_id}/download?expires={expires_epoch}&sig={sig}"


async def get_user_storage_usage(db: AsyncSession, user: User) -> StorageQuotaOut:
    settings = get_settings()
    used_res = await db.execute(
        select(
            func.coalesce(
                func.sum(
                    func.coalesce(
                        func.nullif(Attachment.ciphertext_size, 0),
                        Attachment.total_size,
                    )
                ),
                0,
            )
        ).where(Attachment.uploader_id == user.id)
    )
    used_bytes = int(used_res.scalar_one() or 0)
    quota_bytes = int(user.storage_quota_bytes or settings.PER_USER_STORAGE_QUOTA_BYTES)
    return StorageQuotaOut(
        used_bytes=used_bytes,
        quota_bytes=quota_bytes,
        remaining_bytes=max(0, quota_bytes - used_bytes),
        max_file_bytes=settings.MAX_UPLOAD_BYTES,
    )


async def _get_conversation_member_ids_checked(
    db: AsyncSession, conversation_id: str, user_id: str
) -> list[str]:
    res = await db.execute(
        select(ConversationMember.user_id).where(
            ConversationMember.conversation_id == conversation_id
        )
    )
    member_ids = list(res.scalars().all())
    if not member_ids or user_id not in member_ids:
        raise AppError(
            "FORBIDDEN_CONVERSATION",
            "You are not a member of this conversation.",
            status_code=status.HTTP_403_FORBIDDEN,
        )
    return member_ids


async def init_encrypted_attachment(
    db: AsyncSession,
    uploader: User,
    body: AttachmentInitRequest,
) -> AttachmentInitOut:
    settings = get_settings()

    # 1. File type allow-list
    clean_mime = normalize_mime_type(body.mime_type)
    if clean_mime not in ALLOWED_ATTACHMENT_MIMES:
        raise AppError(
            "UNSUPPORTED_FILE_TYPE",
            f"File type '{clean_mime}' is not in the allowed media/document allow-list.",
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        )

    # 2. Max 100 MB single-file limit
    if body.total_size > settings.MAX_UPLOAD_BYTES:
        raise AppError(
            "FILE_TOO_LARGE",
            f"Attachment exceeds maximum file size of {settings.MAX_UPLOAD_BYTES // (1024 * 1024)} MB.",
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
        )

    # 3. Validate chunk geometry
    expected_chunks = max(1, math.ceil(body.total_size / body.chunk_size))
    if body.chunk_count != expected_chunks:
        raise AppError(
            "INVALID_CHUNK_COUNT",
            f"Expected {expected_chunks} chunks for {body.total_size} bytes at chunk_size={body.chunk_size}.",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    # 4. Membership & block rules (when attached to a conversation; Status media has conversation_id=None)
    if body.conversation_id:
        member_ids = await _get_conversation_member_ids_checked(
            db, body.conversation_id, uploader.id
        )
        await assert_not_blocked_for_messaging(db, uploader.id, member_ids)

    # 5. Per-user storage quota enforcement
    usage = await get_user_storage_usage(db, uploader)
    estimated_ciphertext = body.total_size + (body.chunk_count * AES_GCM_TAG_BYTES)
    if usage.used_bytes + estimated_ciphertext > usage.quota_bytes:
        raise AppError(
            "STORAGE_QUOTA_EXCEEDED",
            "Upload exceeds your encrypted storage quota on this node.",
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
        )

    now = datetime.now(timezone.utc)
    attachment = Attachment(
        conversation_id=body.conversation_id,
        uploader_id=uploader.id,
        storage_backend=settings.STORAGE_BACKEND,
        storage_key="",
        encrypted_filename=body.encrypted_filename,
        mime_type=clean_mime,
        total_size=body.total_size,
        ciphertext_size=0,
        chunk_size=body.chunk_size,
        chunk_count=body.chunk_count,
        uploaded_chunks=0,
        uploaded_chunk_map=[],
        file_nonce=body.file_nonce,
        thumbnail_ciphertext=body.thumbnail_ciphertext,
        thumbnail_nonce=body.thumbnail_nonce,
        is_complete=False,
        created_at=now,
    )
    db.add(attachment)
    await db.flush()
    attachment.storage_key = f"{uploader.id[:8]}_{attachment.id}"
    await db.commit()
    await db.refresh(attachment)

    _staging_dir(attachment.storage_key).mkdir(parents=True, exist_ok=True)

    expires_dt = now + timedelta(seconds=settings.UPLOAD_URL_EXPIRE_SECONDS)
    expires_epoch = int(expires_dt.timestamp())
    slots: list[SignedChunkUploadSlot] = []
    for idx in range(body.chunk_count):
        sig = sign_chunk_upload_token(attachment.id, uploader.id, idx, expires_epoch)
        slots.append(
            SignedChunkUploadSlot(
                chunk_index=idx,
                upload_url=(
                    f"/attachments/upload/{attachment.id}/{idx}"
                    f"?expires={expires_epoch}&sig={sig}"
                ),
                expires_at=expires_dt,
            )
        )

    return AttachmentInitOut(
        attachment_id=attachment.id,
        chunk_size=body.chunk_size,
        chunk_count=body.chunk_count,
        upload_urls=slots,
        expires_in_seconds=settings.UPLOAD_URL_EXPIRE_SECONDS,
    )


async def store_encrypted_chunk_via_signed_url(
    db: AsyncSession,
    *,
    attachment_id: str,
    chunk_index: int,
    expires: int,
    sig: str,
    raw_ciphertext: bytes,
) -> AttachmentChunkUploadOut:
    res = await db.execute(select(Attachment).where(Attachment.id == attachment_id))
    att = res.scalar_one_or_none()
    if not att:
        raise AppError(
            "ATTACHMENT_NOT_FOUND",
            "Upload session does not exist or was cancelled.",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    if not verify_chunk_upload_token(att.id, att.uploader_id, chunk_index, expires, sig):
        raise AppError(
            "INVALID_UPLOAD_SIGNATURE",
            "Signed upload URL is invalid or expired.",
            status_code=status.HTTP_403_FORBIDDEN,
        )

    if att.is_complete:
        raise AppError(
            "UPLOAD_ALREADY_COMPLETE",
            "Attachment upload has already been finalized.",
            status_code=status.HTTP_409_CONFLICT,
        )

    if chunk_index < 0 or chunk_index >= att.chunk_count:
        raise AppError(
            "INVALID_CHUNK_INDEX",
            f"chunk_index must be in 0..{att.chunk_count - 1}.",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    max_chunk_wire_bytes = att.chunk_size + AES_GCM_TAG_BYTES + 64
    if len(raw_ciphertext) <= AES_GCM_TAG_BYTES or len(raw_ciphertext) > max_chunk_wire_bytes:
        raise AppError(
            "INVALID_CHUNK_SIZE",
            f"Encrypted chunk must be between {AES_GCM_TAG_BYTES + 1} and {max_chunk_wire_bytes} bytes.",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    stage = _staging_dir(att.storage_key)
    stage.mkdir(parents=True, exist_ok=True)
    part_path = stage / f"chunk_{chunk_index:06d}.part"
    part_path.write_bytes(raw_ciphertext)

    seen = sorted(set(att.uploaded_chunk_map or []) | {chunk_index})
    att.uploaded_chunk_map = seen
    att.uploaded_chunks = len(seen)
    await db.commit()

    return AttachmentChunkUploadOut(
        attachment_id=att.id,
        chunk_index=chunk_index,
        received_bytes=len(raw_ciphertext),
        uploaded_chunks=att.uploaded_chunks,
        chunk_count=att.chunk_count,
    )


def _to_attachment_out(att: Attachment) -> AttachmentOut:
    return AttachmentOut(
        id=att.id,
        conversation_id=att.conversation_id,
        message_id=att.message_id,
        uploader_id=att.uploader_id,
        mime_type=att.mime_type,
        total_size=att.total_size,
        ciphertext_size=att.ciphertext_size,
        chunk_size=att.chunk_size,
        chunk_count=att.chunk_count,
        sha256_ciphertext=att.sha256_ciphertext,
        is_complete=att.is_complete,
        download_url=build_signed_download_url(att.id),
        created_at=att.created_at,
    )


async def complete_encrypted_attachment(
    db: AsyncSession,
    uploader: User,
    attachment_id: str,
) -> AttachmentOut:
    res = await db.execute(select(Attachment).where(Attachment.id == attachment_id))
    att = res.scalar_one_or_none()
    if not att or att.uploader_id != uploader.id:
        raise AppError(
            "ATTACHMENT_NOT_FOUND",
            "Attachment upload session not found.",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    if att.is_complete:
        return _to_attachment_out(att)

    seen = set(att.uploaded_chunk_map or [])
    missing = [i for i in range(att.chunk_count) if i not in seen]
    if missing:
        raise AppError(
            "INCOMPLETE_CHUNKS",
            f"Missing encrypted chunks: {missing[:10]}",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    stage = _staging_dir(att.storage_key)
    final_path = _assembled_blob_path(att.storage_key)
    hasher = hashlib.sha256()
    total_cipher_bytes = 0

    with final_path.open("wb") as out_f:
        for idx in range(att.chunk_count):
            part_path = stage / f"chunk_{idx:06d}.part"
            if not part_path.exists():
                raise AppError(
                    "MISSING_STAGED_CHUNK",
                    f"Staged chunk {idx} not found on disk.",
                    status_code=status.HTTP_400_BAD_REQUEST,
                )
            chunk_bytes = part_path.read_bytes()
            hasher.update(chunk_bytes)
            out_f.write(chunk_bytes)
            total_cipher_bytes += len(chunk_bytes)

    shutil.rmtree(stage, ignore_errors=True)

    from app.core.metrics import metrics_registry
    from app.services.file_scanner import scan_completed_blob

    await scan_completed_blob(
        blob_path=final_path,
        mime_type=att.mime_type,
        encrypted_filename=att.encrypted_filename,
        expected_plaintext_size=att.total_size,
        ciphertext_size=total_cipher_bytes,
        chunk_count=att.chunk_count,
    )

    att.ciphertext_size = total_cipher_bytes
    att.sha256_ciphertext = hasher.hexdigest()
    att.is_complete = True
    att.completed_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(att)
    metrics_registry.inc_counter("attachments_completed_total", 1)
    return _to_attachment_out(att)


async def cancel_or_delete_attachment(
    db: AsyncSession,
    actor: User,
    attachment_id: str,
) -> None:
    res = await db.execute(select(Attachment).where(Attachment.id == attachment_id))
    att = res.scalar_one_or_none()
    if not att:
        return
    if att.uploader_id != actor.id:
        raise AppError(
            "FORBIDDEN",
            "Only the uploader can cancel or delete this attachment.",
            status_code=status.HTTP_403_FORBIDDEN,
        )

    shutil.rmtree(_staging_dir(att.storage_key), ignore_errors=True)
    blob_file = _assembled_blob_path(att.storage_key)
    if blob_file.exists():
        blob_file.unlink(missing_ok=True)

    await db.delete(att)
    await db.commit()


async def resolve_encrypted_blob_for_download(
    db: AsyncSession,
    attachment_id: str,
    *,
    requester: User | None,
    expires: int | None,
    sig: str | None,
) -> tuple[Attachment, Path]:
    res = await db.execute(select(Attachment).where(Attachment.id == attachment_id))
    att = res.scalar_one_or_none()
    if not att or not att.is_complete:
        raise AppError(
            "ATTACHMENT_NOT_FOUND",
            "Encrypted attachment not found.",
            status_code=status.HTTP_404_NOT_FOUND,
        )

    authorized = False
    if expires is not None and sig and verify_download_token(att.id, expires, sig):
        authorized = True
    elif requester is not None:
        if requester.id == att.uploader_id:
            authorized = True
        elif att.conversation_id:
            mem = await db.execute(
                select(ConversationMember.id).where(
                    ConversationMember.conversation_id == att.conversation_id,
                    ConversationMember.user_id == requester.id,
                )
            )
            if mem.scalar_one_or_none() is not None:
                authorized = True
        else:
            # Check if attachment belongs to an active 24hr Status visible to requester
            from app.models.entities import Contact, StatusPost
            from app.services.status_service import (
                _get_blocked_ids,
                is_viewer_allowed_for_status,
            )

            now = datetime.now(timezone.utc)
            st_post = (
                await db.execute(
                    select(StatusPost).where(
                        StatusPost.attachment_id == att.id,
                        StatusPost.expires_at > now,
                    )
                )
            ).scalar_one_or_none()
            if st_post:
                c_ids = set(
                    (
                        await db.execute(
                            select(Contact.contact_user_id).where(
                                Contact.owner_id == st_post.user_id
                            )
                        )
                    ).scalars().all()
                )
                blocked_ids = await _get_blocked_ids(db, requester.id)
                if is_viewer_allowed_for_status(
                    st_post, requester.id, c_ids, blocked_ids
                ):
                    authorized = True

    if not authorized:
        raise AppError(
            "FORBIDDEN",
            "Not authorized to access this encrypted blob.",
            status_code=status.HTTP_403_FORBIDDEN,
        )

    blob_path = _assembled_blob_path(att.storage_key)
    if not blob_path.exists():
        if att.storage_backend == "remote":
            from app.services.federation_service import (
                fetch_and_cache_remote_attachment_blob,
            )

            blob_path = await fetch_and_cache_remote_attachment_blob(db, att, blob_path)
        else:
            raise AppError(
                "BLOB_MISSING",
                "Encrypted blob missing on storage backend.",
                status_code=status.HTTP_404_NOT_FOUND,
            )
    return att, blob_path


async def get_attachment_metadata_authorized(
    db: AsyncSession,
    attachment_id: str,
    requester: User,
) -> AttachmentOut:
    att, _ = await resolve_encrypted_blob_for_download(
        db,
        attachment_id,
        requester=requester,
        expires=None,
        sig=None,
    )
    return _to_attachment_out(att)
