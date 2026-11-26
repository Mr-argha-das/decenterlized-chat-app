from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, status
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.errors import AppError
from app.core.rate_limit import api_rate_limit, upload_rate_limit
from app.db.session import get_db_session
from app.models.entities import User
from app.schemas.attachments import (
    AttachmentChunkUploadOut,
    AttachmentInitOut,
    AttachmentInitRequest,
    AttachmentOut,
    StorageQuotaOut,
)
from app.services.attachment_service import (
    cancel_or_delete_attachment,
    complete_encrypted_attachment,
    get_attachment_metadata_authorized,
    get_user_storage_usage,
    init_encrypted_attachment,
    resolve_encrypted_blob_for_download,
    store_encrypted_chunk_via_signed_url,
)

router = APIRouter(
    prefix="/attachments",
    tags=["attachments"],
    dependencies=[Depends(api_rate_limit())],
)


@router.get("/quota", response_model=StorageQuotaOut)
async def get_my_storage_quota(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> StorageQuotaOut:
    return await get_user_storage_usage(db, current_user)


@router.post(
    "/init",
    response_model=AttachmentInitOut,
    status_code=status.HTTP_201_CREATED,
)
async def post_init_attachment(
    body: AttachmentInitRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> AttachmentInitOut:
    return await init_encrypted_attachment(db, current_user, body)


@router.put(
    "/upload/{attachment_id}/{chunk_index}",
    response_model=AttachmentChunkUploadOut,
    dependencies=[Depends(upload_rate_limit())],
)
async def put_encrypted_chunk(
    attachment_id: str,
    chunk_index: int,
    request: Request,
    expires: Annotated[int, Query(...)],
    sig: Annotated[str, Query(..., min_length=16, max_length=128)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> AttachmentChunkUploadOut:
    raw_ciphertext = await request.body()
    return await store_encrypted_chunk_via_signed_url(
        db,
        attachment_id=attachment_id,
        chunk_index=chunk_index,
        expires=expires,
        sig=sig,
        raw_ciphertext=raw_ciphertext,
    )


@router.post("/{attachment_id}/complete", response_model=AttachmentOut)
async def post_complete_attachment(
    attachment_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> AttachmentOut:
    return await complete_encrypted_attachment(db, current_user, attachment_id)


@router.delete("/{attachment_id}")
async def delete_attachment(
    attachment_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> dict[str, str]:
    await cancel_or_delete_attachment(db, current_user, attachment_id)
    return {"status": "deleted", "attachment_id": attachment_id}


@router.get("/{attachment_id}", response_model=AttachmentOut)
async def get_attachment_info(
    attachment_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> AttachmentOut:
    return await get_attachment_metadata_authorized(db, attachment_id, current_user)


@router.get("/{attachment_id}/download")
async def download_encrypted_attachment(
    attachment_id: str,
    request: Request,
    db: Annotated[AsyncSession, Depends(get_db_session)],
    expires: Annotated[int | None, Query()] = None,
    sig: Annotated[str | None, Query()] = None,
) -> FileResponse:
    requester: User | None = None
    if expires is None or not sig:
        # Authenticate via Bearer header or cookie when signed query token isn't supplied
        from app.api.deps import verify_access_token_and_load_auth

        token: str | None = None
        auth_hdr = request.headers.get("authorization")
        if auth_hdr and auth_hdr.lower().startswith("bearer "):
            token = auth_hdr[7:].strip()
        elif request.cookies.get("relaychat_access"):
            token = request.cookies.get("relaychat_access")

        if token:
            try:
                requester, _ = await verify_access_token_and_load_auth(
                    token, db, touch_device=False
                )
            except AppError:
                requester = None

    att, blob_path = await resolve_encrypted_blob_for_download(
        db,
        attachment_id,
        requester=requester,
        expires=expires,
        sig=sig,
    )
    return FileResponse(
        blob_path,
        media_type="application/octet-stream",
        headers={
            "X-RelayChat-Encrypted": "AES-256-GCM-Chunked",
            "X-RelayChat-Chunk-Size": str(att.chunk_size),
            "X-RelayChat-Chunk-Count": str(att.chunk_count),
            "Cache-Control": "private, max-age=86400",
        },
    )
