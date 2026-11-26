from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field


class PushKeysIn(BaseModel):
    p256dh: str = Field(..., min_length=16, max_length=255)
    auth: str = Field(..., min_length=8, max_length=255)


class PushSubscribeRequest(BaseModel):
    endpoint: str = Field(..., min_length=12, max_length=512)
    keys: PushKeysIn
    local_decrypt_enabled: bool = False


class PushSubscriptionUpdateRequest(BaseModel):
    local_decrypt_enabled: bool


class PushUnsubscribeRequest(BaseModel):
    endpoint: str = Field(..., min_length=12, max_length=512)


class PushSubscriptionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    device_id: str | None
    endpoint: str
    local_decrypt_enabled: bool
    user_agent: str | None
    created_at: datetime


class VapidPublicKeyOut(BaseModel):
    public_key: str
    enabled: bool = True
