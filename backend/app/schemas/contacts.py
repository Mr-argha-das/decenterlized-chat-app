from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from app.core.sanitize import sanitize_single_line_text


class PeerProfileViewOut(BaseModel):
    id: str
    username: str
    domain: str
    global_id: str
    display_name: str
    nickname: str | None = None
    effective_name: str
    about: str
    avatar_url: str | None
    public_key: str
    is_local: bool
    is_online: bool
    last_seen_at: datetime | None
    is_contact: bool = False
    is_blocked_by_me: bool = False
    has_blocked_me: bool = False


class ContactCreateRequest(BaseModel):
    identifier: str = Field(
        ...,
        min_length=3,
        max_length=200,
        description="Full ID `username@domain` (or QR URI `relaychat:username@domain`)",
    )
    nickname: str | None = Field(default=None, max_length=80)

    @field_validator("nickname")
    @classmethod
    def _clean_nick(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return sanitize_single_line_text(v, max_length=80) or None


class ContactUpdateRequest(BaseModel):
    nickname: str | None = Field(default=None, max_length=80)

    @field_validator("nickname")
    @classmethod
    def _clean_nick(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return sanitize_single_line_text(v, max_length=80) or None


class ContactOut(BaseModel):
    id: str
    owner_id: str
    contact_user_id: str
    nickname: str | None
    created_at: datetime
    user: PeerProfileViewOut


class BlockCreateRequest(BaseModel):
    target_user_id: str | None = Field(default=None, max_length=64)
    identifier: str | None = Field(default=None, max_length=200)
    reason: str | None = Field(default=None, max_length=255)


class BlockOut(BaseModel):
    id: str
    blocker_id: str
    blocked_user_id: str
    reason: str | None
    created_at: datetime
    user: PeerProfileViewOut
