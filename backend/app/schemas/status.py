import base64
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

StatusPrivacyMode = Literal["contacts", "except", "only"]
StatusMediaType = Literal["text", "image", "video"]
StatusFontFamily = Literal["sans", "serif", "mono", "display"]


class StatusKeyEnvelopeIn(BaseModel):
    wrapped_key: str = Field(..., min_length=8, max_length=4096)
    wrap_nonce: str = Field(..., min_length=8, max_length=64)
    ephemeral_public_key: str | None = Field(default=None, max_length=4096)


class StatusCreateRequest(BaseModel):
    media_type: StatusMediaType = "text"
    ciphertext: str = Field(..., min_length=4, max_length=262144)
    nonce: str = Field(..., min_length=8, max_length=64)
    key_envelopes: dict[str, dict[str, Any]] = Field(default_factory=dict)
    background_style: str | None = Field(
        default="linear-gradient(135deg, #00a884 0%, #0f172a 100%)",
        max_length=128,
    )
    font_family: StatusFontFamily = "sans"
    attachment_id: str | None = Field(default=None, max_length=36)
    privacy_mode: StatusPrivacyMode | None = None
    target_user_ids: list[str] | None = None

    @field_validator("nonce")
    @classmethod
    def _validate_nonce(cls, v: str) -> str:
        cleaned = v.strip()
        raw = base64.b64decode(cleaned, validate=True)
        if len(raw) < 12:
            raise ValueError("nonce must be at least 12 bytes (base64).")
        return cleaned


class StatusPrivacyUpdateRequest(BaseModel):
    mode: StatusPrivacyMode = "contacts"
    except_user_ids: list[str] = Field(default_factory=list)
    only_user_ids: list[str] = Field(default_factory=list)


class StatusPrivacyOut(BaseModel):
    mode: StatusPrivacyMode
    except_user_ids: list[str]
    only_user_ids: list[str]


class StatusViewerOut(BaseModel):
    user_id: str
    global_id: str
    display_name: str
    avatar_url: str | None = None
    viewed_at: datetime


class StatusItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    author_global_id: str
    author_display_name: str
    author_avatar_url: str | None = None
    author_public_key: str
    media_type: str
    ciphertext: str
    nonce: str
    my_key_envelope: dict[str, Any] | None = None
    background_style: str | None = None
    font_family: str = "sans"
    attachment_id: str | None = None
    privacy_mode: str = "contacts"
    is_viewed: bool = False
    view_count: int = 0
    viewers: list[StatusViewerOut] = Field(default_factory=list)
    created_at: datetime
    expires_at: datetime


class UserStatusBundleOut(BaseModel):
    user_id: str
    global_id: str
    display_name: str
    avatar_url: str | None = None
    public_key: str
    is_muted: bool = False
    all_viewed: bool = False
    latest_at: datetime
    statuses: list[StatusItemOut]


class StatusFeedOut(BaseModel):
    my_statuses: list[StatusItemOut]
    recent_updates: list[UserStatusBundleOut]
    muted_updates: list[UserStatusBundleOut]
    privacy: StatusPrivacyOut


class StatusRecipientCandidateOut(BaseModel):
    user_id: str
    global_id: str
    display_name: str
    avatar_url: str | None = None
    public_key: str
