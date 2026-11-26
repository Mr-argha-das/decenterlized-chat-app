import base64
from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field, field_validator

ALLOWED_ATTACHMENT_MIMES: frozenset[str] = frozenset(
    {
        # Images
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
        # Videos
        "video/mp4",
        "video/webm",
        "video/quicktime",
        # Audio & Voice messages
        "audio/webm",
        "audio/ogg",
        "audio/mpeg",
        "audio/mp3",
        "audio/mp4",
        "audio/x-m4a",
        "audio/wav",
        "audio/x-wav",
        "audio/aac",
        # Documents & Archives
        "application/pdf",
        "text/plain",
        "text/csv",
        "text/markdown",
        "application/json",
        "application/zip",
        "application/x-zip-compressed",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }
)


def normalize_mime_type(raw_mime: str) -> str:
    # Strip codec suffix like `audio/webm;codecs=opus` -> `audio/webm`
    base = raw_mime.split(";", 1)[0].strip().lower()
    return base


class AttachmentInitRequest(BaseModel):
    conversation_id: str | None = Field(default=None, min_length=1, max_length=36)
    mime_type: str = Field(..., min_length=3, max_length=120)
    total_size: int = Field(..., ge=1)
    chunk_size: int = Field(default=1_048_576, ge=65_536, le=4_194_304)
    chunk_count: int = Field(..., ge=1, le=200)
    file_nonce: str = Field(..., min_length=8, max_length=64)
    encrypted_filename: str = Field(..., min_length=4, max_length=2048)
    thumbnail_ciphertext: str | None = Field(default=None, max_length=262_144)
    thumbnail_nonce: str | None = Field(default=None, max_length=64)

    @field_validator("file_nonce")
    @classmethod
    def _validate_nonce(cls, v: str) -> str:
        cleaned = v.strip()
        raw = base64.b64decode(cleaned, validate=True)
        if len(raw) < 12:
            raise ValueError("file_nonce must be at least 12 random bytes (base64).")
        return cleaned


class SignedChunkUploadSlot(BaseModel):
    chunk_index: int
    upload_url: str
    expires_at: datetime


class AttachmentInitOut(BaseModel):
    attachment_id: str
    chunk_size: int
    chunk_count: int
    upload_urls: list[SignedChunkUploadSlot]
    expires_in_seconds: int


class AttachmentChunkUploadOut(BaseModel):
    attachment_id: str
    chunk_index: int
    received_bytes: int
    uploaded_chunks: int
    chunk_count: int


class AttachmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    conversation_id: str | None
    message_id: str | None
    uploader_id: str
    mime_type: str
    total_size: int
    ciphertext_size: int
    chunk_size: int
    chunk_count: int
    sha256_ciphertext: str | None
    is_complete: bool
    download_url: str
    created_at: datetime


class StorageQuotaOut(BaseModel):
    used_bytes: int
    quota_bytes: int
    remaining_bytes: int
    max_file_bytes: int
