import base64
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


def _validate_base64_blob(val: str, field_name: str, max_len: int) -> str:
    cleaned = val.strip()
    if not cleaned or len(cleaned) > max_len:
        raise ValueError(f"{field_name} must be non-empty and at most {max_len} characters.")
    try:
        raw = base64.b64decode(cleaned, validate=True)
    except Exception as exc:
        raise ValueError(f"{field_name} must be valid base64.") from exc
    if len(raw) == 0:
        raise ValueError(f"{field_name} decoded to empty bytes.")
    return cleaned


class PeerSummaryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    username: str
    domain: str
    global_id: str
    display_name: str
    raw_display_name: str | None = None
    nickname: str | None = None
    about: str
    avatar_url: str | None
    public_key: str
    is_online: bool
    last_seen_at: datetime | None
    is_contact: bool = False
    is_blocked_by_me: bool = False
    has_blocked_me: bool = False


class MessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    conversation_id: str
    sender_id: str
    sender_global_id: str
    ciphertext: str
    nonce: str
    type: str
    status: str
    reply_to_id: str | None
    client_msg_id: str | None = None
    created_at: datetime
    edited_at: datetime | None
    deleted_at: datetime | None
    deleted_for_everyone: bool
    delivered_at: datetime | None = None
    read_at: datetime | None = None


class ConversationCreateRequest(BaseModel):
    peer_username: str | None = Field(default=None, min_length=1, max_length=160)
    peer_id: str | None = Field(default=None, min_length=1, max_length=64)


class ConversationUpdateRequest(BaseModel):
    is_pinned: bool | None = None
    is_muted: bool | None = None


class ConversationOut(BaseModel):
    id: str
    type: str
    name: str | None
    icon_url: str | None
    peer: PeerSummaryOut | None = None
    unread_count: int
    is_pinned: bool
    is_muted: bool
    last_message_at: datetime | None
    last_message: MessageOut | None = None
    created_at: datetime


class MessageCreateRequest(BaseModel):
    conversation_id: str = Field(..., min_length=1, max_length=36)
    ciphertext: str = Field(..., min_length=4, max_length=131072)
    nonce: str = Field(..., min_length=8, max_length=64)
    type: Literal[
        "text",
        "image",
        "video",
        "audio",
        "voice",
        "document",
        "file",
        "location",
        "live_location",
    ] = "text"
    reply_to_id: str | None = Field(default=None, max_length=36)
    client_msg_id: str | None = Field(default=None, max_length=64)

    @field_validator("ciphertext")
    @classmethod
    def _check_ct(cls, v: str) -> str:
        return _validate_base64_blob(v, "ciphertext", 131072)

    @field_validator("nonce")
    @classmethod
    def _check_nonce(cls, v: str) -> str:
        cleaned = _validate_base64_blob(v, "nonce", 64)
        raw = base64.b64decode(cleaned)
        if len(raw) < 12:
            raise ValueError("AES-GCM nonce must be at least 12 bytes (96 bits).")
        return cleaned


class MessageEditRequest(BaseModel):
    ciphertext: str = Field(..., min_length=4, max_length=131072)
    nonce: str = Field(..., min_length=8, max_length=64)

    @field_validator("ciphertext")
    @classmethod
    def _check_ct(cls, v: str) -> str:
        return _validate_base64_blob(v, "ciphertext", 131072)

    @field_validator("nonce")
    @classmethod
    def _check_nonce(cls, v: str) -> str:
        cleaned = _validate_base64_blob(v, "nonce", 64)
        if len(base64.b64decode(cleaned)) < 12:
            raise ValueError("AES-GCM nonce must be at least 12 bytes (96 bits).")
        return cleaned


class MessageAckRequest(BaseModel):
    status: Literal["delivered", "read"] = "read"
    message_ids: list[str] | None = None


class CursorMessagesOut(BaseModel):
    items: list[MessageOut]
    next_cursor: str | None
    has_more: bool
