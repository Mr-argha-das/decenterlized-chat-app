from typing import Annotated

from fastapi import APIRouter, Depends, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_auth, get_current_user
from app.core.rate_limit import api_rate_limit
from app.db.session import get_db_session
from app.models.entities import Device, User
from app.schemas.push import (
    PushSubscribeRequest,
    PushSubscriptionOut,
    PushSubscriptionUpdateRequest,
    PushUnsubscribeRequest,
    VapidPublicKeyOut,
)
from app.services.push_service import (
    get_vapid_public_key_info,
    list_user_push_subscriptions,
    remove_push_subscription,
    send_test_push_notification,
    update_push_subscription_preferences,
    upsert_push_subscription,
)

router = APIRouter(
    prefix="/push",
    tags=["push"],
    dependencies=[Depends(api_rate_limit())],
)


@router.get("/vapid-public-key", response_model=VapidPublicKeyOut)
async def get_vapid_key() -> VapidPublicKeyOut:
    return get_vapid_public_key_info()


@router.get("/subscriptions", response_model=list[PushSubscriptionOut])
async def get_subscriptions(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> list[PushSubscriptionOut]:
    return await list_user_push_subscriptions(db, current_user)


@router.post(
    "/subscribe",
    response_model=PushSubscriptionOut,
    status_code=status.HTTP_201_CREATED,
)
async def subscribe_push(
    request: Request,
    body: PushSubscribeRequest,
    auth: Annotated[tuple[User, Device], Depends(get_current_auth)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> PushSubscriptionOut:
    user, device = auth
    return await upsert_push_subscription(
        db,
        user=user,
        device_id=device.id,
        user_agent=request.headers.get("user-agent"),
        body=body,
    )


@router.patch("/subscriptions/{subscription_id}", response_model=PushSubscriptionOut)
async def patch_subscription(
    subscription_id: str,
    body: PushSubscriptionUpdateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> PushSubscriptionOut:
    return await update_push_subscription_preferences(
        db,
        user=current_user,
        subscription_id=subscription_id,
        body=body,
    )


@router.post("/unsubscribe")
async def unsubscribe_push_by_endpoint(
    body: PushUnsubscribeRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> dict[str, str]:
    return await remove_push_subscription(db, user=current_user, endpoint=body.endpoint)


@router.delete("/subscriptions/{subscription_id}")
async def delete_subscription_by_id(
    subscription_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> dict[str, str]:
    return await remove_push_subscription(
        db, user=current_user, subscription_id=subscription_id
    )


@router.post("/test")
async def trigger_test_push(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> dict[str, int]:
    return await send_test_push_notification(db, current_user)
