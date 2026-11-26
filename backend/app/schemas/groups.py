import base64
from datetime import datetime
from typing import Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator

from app.core.sanitize import sanitize_multiline_text, sanitize_single_line_text


def _validate_b64(val: str, field_name: str, max_len: int) -> str:
    cleaned = val.strip()
    if not cleaned or len(cleaned) > max_len:
        raise ValueError(f"{field_name} must be non-empty and <= {max_len} chars.")
    raw = base64.b64decode(cleaned, validate=True)
    if len(raw) == 0:
        raise ValueError(f"{field_name} decoded to empty bytes.")
    return cleaned


class GroupMemberOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    user_id: str
    username: str
    domain: str
    global_id: str
    display_name: str
    avatar_url: str | None = None
    public_key: str
    role: Literal["admin", "member"]
    sender_color: str
    is_online: bool = False
    joined_at: datetime


class SenderKeyEnvelopeIn(BaseModel):
    recipient_id: str = Field(..., min_length=1, max_length=36)
    wrapped_key: str = Field(..., min_length=8, max_length=4096)
    nonce: str = Field(..., min_length=8, max_length=64)

    @field_validator("wrapped_key")
    @classmethod
    def _chk_wk(cls, v: str) -> str:
        return _validate_b64(v, "wrapped_key", 4096)

    @field_validator("nonce")
    @classmethod
    def _chk_nonce(cls, v: str) -> str:
        cleaned = _validate_b64(v, "nonce", 64)
        if len(base64.b64decode(cleaned)) < 12:
            raise ValueError("nonce must be at least 12 bytes.")
        return cleaned


class DistributeSenderKeysRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    key_version: int = Field(..., ge=1)
    envelopes: list[SenderKeyEnvelopeIn] = Field(
        ...,
        min_length=1,
        max_length=256,
        validation_alias=AliasChoices("envelopes", "keys"),
    )


class GroupSenderKeyOut(BaseModel):
    id: str
    group_id: str
    sender_id: str
    sender_global_id: str
    sender_public_key: str
    recipient_id: str
    key_version: int
    wrapped_key: str
    nonce: str
    created_at: datetime


class GroupCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    description: str = Field(default="", max_length=500)
    icon_url: str | None = Field(default=None, max_length=512)
    member_ids: list[str] = Field(default_factory=list, max_length=250)
    only_admins_can_send: bool = False
    only_admins_can_edit_info: bool = True
    sender_key_envelopes: list[SenderKeyEnvelopeIn] | None = None

    @field_validator("name")
    @classmethod
    def _clean_name(cls, v: str) -> str:
        cleaned = sanitize_single_line_text(v, max_length=100)
        if not cleaned:
            raise ValueError("Group name cannot be empty.")
        return cleaned

    @field_validator("description")
    @classmethod
    def _clean_desc(cls, v: str) -> str:
        return sanitize_multiline_text(v, max_length=500)


class GroupUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=500)
    icon_url: str | None = Field(default=None, max_length=512)
    only_admins_can_send: bool | None = None
    only_admins_can_edit_info: bool | None = None

    @field_validator("name")
    @classmethod
    def _clean_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        cleaned = sanitize_single_line_text(v, max_length=100)
        if not cleaned:
            raise ValueError("Group name cannot be empty.")
        return cleaned

    @field_validator("description")
    @classmethod
    def _clean_desc(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return sanitize_multiline_text(v, max_length=500)


class GroupAddMembersRequest(BaseModel):
    member_ids: list[str] = Field(..., min_length=1, max_length=100)


class GroupMemberRoleUpdateRequest(BaseModel):
    role: Literal["admin", "member"]


class GroupInviteOut(BaseModel):
    group_id: str
    invite_code: str
    invite_path: str
    invite_revoked_at: datetime | None = None


class GroupInvitePreviewOut(BaseModel):
    group_id: str
    name: str
    description: str
    icon_url: str | None = None
    member_count: int
    already_member: bool = False


class GroupSummaryOut(BaseModel):
    id: str
    name: str
    description: str
    icon_url: str | None = None
    created_by_id: str | None = None
    key_version: int
    only_admins_can_send: bool
    only_admins_can_edit_info: bool
    my_role: Literal["admin", "member"]
    member_count: int
    invite_code: str | None = None
    members: list[GroupMemberOut] = Field(default_factory=list)
    created_at: datetime


class GroupDetailOut(GroupSummaryOut):
    pass
