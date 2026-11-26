from typing import Annotated, Any

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.rate_limit import api_rate_limit
from app.db.session import get_db_session
from app.models.entities import User
from app.schemas.status import (
    StatusCreateRequest,
    StatusFeedOut,
    StatusItemOut,
    StatusPrivacyOut,
    StatusPrivacyUpdateRequest,
    StatusRecipientCandidateOut,
    StatusViewerOut,
)
from app.services.status_service import (
    create_status_post,
    delete_status_post,
    get_status_feed,
    list_status_recipient_candidates,
    list_status_viewers,
    record_status_view,
    set_status_mute,
    update_user_status_privacy,
)

router = APIRouter(
    prefix="/statuses",
    tags=["statuses"],
    dependencies=[Depends(api_rate_limit())],
)


@router.get("", response_model=StatusFeedOut)
async def list_statuses(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> StatusFeedOut:
    return await get_status_feed(db, current_user)


@router.get("/recipients", response_model=list[StatusRecipientCandidateOut])
async def get_status_recipients(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> list[StatusRecipientCandidateOut]:
    return await list_status_recipient_candidates(db, current_user)


@router.post("", response_model=StatusItemOut, status_code=status.HTTP_201_CREATED)
async def post_status(
    body: StatusCreateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> StatusItemOut:
    return await create_status_post(db, current_user, body)


@router.put("/privacy", response_model=StatusPrivacyOut)
async def put_status_privacy(
    body: StatusPrivacyUpdateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> StatusPrivacyOut:
    return await update_user_status_privacy(db, current_user, body)


@router.post("/{status_id}/view")
async def mark_status_viewed(
    status_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> dict[str, Any]:
    return await record_status_view(db, current_user, status_id)


@router.get("/{status_id}/viewers", response_model=list[StatusViewerOut])
async def get_viewers_for_status(
    status_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> list[StatusViewerOut]:
    return await list_status_viewers(db, current_user, status_id)


@router.delete("/{status_id}")
async def remove_status(
    status_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> dict[str, str]:
    return await delete_status_post(db, current_user, status_id)


@router.post("/mute/{target_user_id}")
async def mute_user_status(
    target_user_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> dict[str, Any]:
    return await set_status_mute(db, current_user, target_user_id, muted=True)


@router.delete("/mute/{target_user_id}")
async def unmute_user_status(
    target_user_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> dict[str, Any]:
    return await set_status_mute(db, current_user, target_user_id, muted=False)
