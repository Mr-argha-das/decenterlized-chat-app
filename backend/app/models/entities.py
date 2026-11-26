import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_uuid() -> str:
    return str(uuid.uuid4())


class User(Base):
    """Local registered users and cached remote federated actors."""

    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("username", "domain", name="uq_users_username_domain"),
        Index("ix_users_domain_username", "domain", "username"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    username: Mapped[str] = mapped_column(String(20), nullable=False)
    domain: Mapped[str] = mapped_column(String(128), nullable=False)
    global_id: Mapped[str] = mapped_column(String(160), unique=True, index=True, nullable=False)

    # Null for remote federated actors discovered via /.well-known/user/{username}
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Browser-generated ECDH P-256 public key (JWK JSON or SPKI PEM/base64); private key never leaves browser
    public_key: Mapped[str] = mapped_column(Text, nullable=False)

    display_name: Mapped[str] = mapped_column(String(80), nullable=False)
    about: Mapped[str] = mapped_column(
        String(255), nullable=False, default="Hey there! I am using RelayChat."
    )
    avatar_url: Mapped[str | None] = mapped_column(String(512), nullable=True)

    is_local: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    node_url: Mapped[str | None] = mapped_column(String(255), nullable=True)

    is_online: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Privacy & UI preferences
    privacy_last_seen: Mapped[str] = mapped_column(
        String(16), nullable=False, default="everyone"
    )  # everyone | contacts | nobody
    privacy_profile_photo: Mapped[str] = mapped_column(
        String(16), nullable=False, default="everyone"
    )  # everyone | contacts | nobody
    privacy_read_receipts: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    privacy_read_receipts_visibility: Mapped[str] = mapped_column(
        String(16), nullable=False, default="everyone"
    )  # everyone | contacts | nobody
    notifications_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    notification_sound: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    chat_wallpaper: Mapped[str] = mapped_column(String(32), nullable=False, default="default")
    theme: Mapped[str] = mapped_column(String(16), nullable=False, default="dark")
    storage_quota_bytes: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=524_288_000
    )
    status_privacy_mode: Mapped[str] = mapped_column(
        String(16), nullable=False, default="contacts"
    )  # contacts | except | only
    status_privacy_exceptions: Mapped[list[str] | None] = mapped_column(
        JSON, nullable=True, default=list
    )
    status_privacy_only_ids: Mapped[list[str] | None] = mapped_column(
        JSON, nullable=True, default=list
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow
    )

    devices: Mapped[list["Device"]] = relationship(
        "Device", back_populates="user", cascade="all, delete-orphan"
    )
    refresh_tokens: Mapped[list["RefreshToken"]] = relationship(
        "RefreshToken", back_populates="user", cascade="all, delete-orphan"
    )


class Device(Base):
    """Linked browser/device sessions."""

    __tablename__ = "devices"
    __table_args__ = (Index("ix_devices_user_revoked", "user_id", "is_revoked"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False, default="Web Browser")
    user_agent: Mapped[str | None] = mapped_column(String(255), nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    device_public_key: Mapped[str | None] = mapped_column(Text, nullable=True)

    is_revoked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    last_active: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )

    user: Mapped["User"] = relationship("User", back_populates="devices")
    refresh_tokens: Mapped[list["RefreshToken"]] = relationship(
        "RefreshToken", back_populates="device", cascade="all, delete-orphan"
    )

    @property
    def device_name(self) -> str:
        return self.name

    @property
    def last_active_at(self) -> datetime:
        return self.last_active


class RefreshToken(Base):
    """Rotated single-use refresh tokens tied to a user and linked device."""

    __tablename__ = "refresh_tokens"
    __table_args__ = (Index("ix_refresh_tokens_user_revoked", "user_id", "is_revoked"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    device_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False, index=True
    )
    token_jti: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    replaced_by_jti: Mapped[str | None] = mapped_column(String(64), nullable=True)
    is_revoked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )

    user: Mapped["User"] = relationship("User", back_populates="refresh_tokens")
    device: Mapped["Device"] = relationship("Device", back_populates="refresh_tokens")


class Contact(Base):
    """User address book entries (local or federated username@domain)."""

    __tablename__ = "contacts"
    __table_args__ = (
        UniqueConstraint("owner_id", "contact_user_id", name="uq_contacts_owner_target"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    owner_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    contact_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    nickname: Mapped[str | None] = mapped_column(String(80), nullable=True)
    alias: Mapped[str | None] = mapped_column(String(80), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=utcnow, onupdate=utcnow
    )


class Block(Base):
    """Blocked users list."""

    __tablename__ = "blocks"
    __table_args__ = (
        UniqueConstraint("blocker_id", "blocked_id", name="uq_blocks_blocker_blocked"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    blocker_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    blocked_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class Conversation(Base):
    """1:1 direct conversations and sender-key encrypted group chats."""

    __tablename__ = "conversations"
    __table_args__ = (Index("ix_conversations_type_last_msg", "type", "last_message_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    type: Mapped[str] = mapped_column(String(16), nullable=False, default="direct")  # direct | group
    name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    icon_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    direct_pair_key: Mapped[str | None] = mapped_column(
        String(190), unique=True, index=True, nullable=True
    )
    disappearing_timer_seconds: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
    )
    last_message_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), index=True, nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow
    )


class Group(Base):
    """Group metadata, admin-only policies, invite link token, and current sender-key version."""

    __tablename__ = "groups"

    id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("conversations.id", ondelete="CASCADE"),
        primary_key=True,
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    icon_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    description: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    created_by_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    only_admins_can_send: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    only_admins_can_edit_info: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    invite_code: Mapped[str | None] = mapped_column(
        String(64), unique=True, index=True, nullable=True
    )
    invite_revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    key_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow
    )


class ConversationMember(Base):
    """Membership, admin roles, and per-user unread counters."""

    __tablename__ = "conversation_members"
    __table_args__ = (
        UniqueConstraint("conversation_id", "user_id", name="uq_conv_members_conv_user"),
        Index("ix_conv_members_user_conv", "user_id", "conversation_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    conversation_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    role: Mapped[str] = mapped_column(
        String(16), nullable=False, default="member"
    )  # admin | member
    added_by_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    sender_color: Mapped[str | None] = mapped_column(String(16), nullable=True)
    unread_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_pinned: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_muted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    last_read_message_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    muted_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class Message(Base):
    """End-to-end encrypted messages (ciphertext + nonce only; server never sees plaintext)."""

    __tablename__ = "messages"
    __table_args__ = (
        Index("ix_messages_conv_created", "conversation_id", "created_at"),
        Index("ix_messages_conv_status", "conversation_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    conversation_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sender_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sender_global_id: Mapped[str] = mapped_column(String(160), nullable=False, index=True)

    ciphertext: Mapped[str] = mapped_column(Text, nullable=False)
    nonce: Mapped[str] = mapped_column(String(64), nullable=False)
    ephemeral_pub_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    key_envelope: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    sender_key_version: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    mentions: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    system_event: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)

    message_type: Mapped[str] = mapped_column(
        String(24), nullable=False, default="text", index=True
    )  # text | image | video | audio | voice | document | location | live_location | system
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="sent", index=True
    )  # sent | delivered | read

    reply_to_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("messages.id", ondelete="SET NULL"), nullable=True
    )
    client_msg_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_for_everyone: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    deleted_for_user_ids: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)

    metadata_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    federation_id: Mapped[str | None] = mapped_column(
        String(128), unique=True, index=True, nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow, index=True
    )
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    @property
    def type(self) -> str:
        return self.message_type


class MessageReceipt(Base):
    """Per-recipient delivery and read receipts for messages."""

    __tablename__ = "message_receipts"
    __table_args__ = (
        UniqueConstraint("message_id", "user_id", name="uq_message_receipts_msg_user"),
        Index("ix_message_receipts_user_read", "user_id", "read_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    message_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("messages.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class Attachment(Base):
    """Client-side encrypted chunked file attachments & encrypted thumbnails."""

    __tablename__ = "attachments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    conversation_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=True, index=True
    )
    message_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("messages.id", ondelete="CASCADE"), nullable=True, index=True
    )
    uploader_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    storage_backend: Mapped[str] = mapped_column(
        String(16), nullable=False, default="local"
    )  # local | s3 | remote
    storage_key: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    origin_domain: Mapped[str | None] = mapped_column(String(128), nullable=True)
    remote_attachment_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    remote_download_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    encrypted_filename: Mapped[str] = mapped_column(Text, nullable=False)
    mime_type: Mapped[str] = mapped_column(String(120), nullable=False)
    total_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    ciphertext_size: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    chunk_size: Mapped[int] = mapped_column(Integer, nullable=False, default=1_048_576)
    chunk_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    uploaded_chunks: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    uploaded_chunk_map: Mapped[list[int]] = mapped_column(JSON, nullable=False, default=list)
    file_nonce: Mapped[str] = mapped_column(String(64), nullable=False)
    thumbnail_ciphertext: Mapped[str | None] = mapped_column(Text, nullable=True)
    thumbnail_nonce: Mapped[str | None] = mapped_column(String(64), nullable=True)
    sha256_ciphertext: Mapped[str | None] = mapped_column(String(64), nullable=True)
    is_complete: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class LiveLocationSession(Base):
    """Active encrypted live-location sharing sessions (15m / 1h / 8h with auto-expiry)."""

    __tablename__ = "live_location_sessions"
    __table_args__ = (
        Index("ix_live_loc_conv_active", "conversation_id", "is_active"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    message_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("messages.id", ondelete="CASCADE"),
        unique=True,
        nullable=False,
        index=True,
    )
    conversation_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sender_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    ciphertext: Mapped[str] = mapped_column(Text, nullable=False)
    nonce: Mapped[str] = mapped_column(String(64), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow
    )


class GroupKey(Base):
    """Sender-key based group encryption envelopes distributed per member."""

    __tablename__ = "group_keys"
    __table_args__ = (
        UniqueConstraint(
            "conversation_id",
            "sender_id",
            "recipient_id",
            "key_generation",
            name="uq_group_keys_conv_sender_rcpt_gen",
        ),
        Index("ix_group_keys_conv_recipient", "conversation_id", "recipient_id"),
        Index("ix_group_keys_conv_version", "conversation_id", "key_version"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    conversation_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sender_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    recipient_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    key_generation: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    key_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    encrypted_sender_key: Mapped[str] = mapped_column(Text, nullable=False)
    nonce: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )

    @property
    def wrapped_key(self) -> str:
        return self.encrypted_sender_key


class StatusPost(Base):
    """24-hour encrypted Status / Stories posts."""

    __tablename__ = "statuses"
    __table_args__ = (Index("ix_statuses_user_expires", "user_id", "expires_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    media_type: Mapped[str] = mapped_column(
        String(16), nullable=False, default="text"
    )  # text | image | video
    ciphertext: Mapped[str] = mapped_column(Text, nullable=False)
    nonce: Mapped[str] = mapped_column(String(64), nullable=False)
    key_envelopes: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    background_style: Mapped[str | None] = mapped_column(String(64), nullable=True)
    font_family: Mapped[str | None] = mapped_column(String(32), nullable=True, default="sans")
    attachment_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    privacy_mode: Mapped[str] = mapped_column(
        String(16), nullable=False, default="contacts"
    )  # contacts | except | only
    target_user_ids: Mapped[list[str] | None] = mapped_column(JSON, nullable=True, default=list)
    viewer_list: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, index=True
    )


class StatusView(Base):
    """Viewer log for 24-hour Status / Story posts."""

    __tablename__ = "status_views"
    __table_args__ = (
        UniqueConstraint("status_id", "viewer_id", name="uq_status_views_status_viewer"),
        Index("ix_status_views_status_viewed", "status_id", "viewed_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    status_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("statuses.id", ondelete="CASCADE"), nullable=False, index=True
    )
    viewer_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    viewed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class StatusMute(Base):
    """Per-user muted contact status feeds."""

    __tablename__ = "status_mutes"
    __table_args__ = (
        UniqueConstraint("muter_id", "muted_user_id", name="uq_status_mutes_muter_muted"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    muter_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    muted_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class StarredMessage(Base):
    """Per-user bookmarked/starred encrypted messages."""

    __tablename__ = "starred_messages"
    __table_args__ = (
        UniqueConstraint("user_id", "message_id", name="uq_starred_messages_user_msg"),
        Index("ix_starred_messages_user_created", "user_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    message_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("messages.id", ondelete="CASCADE"), nullable=False, index=True
    )
    conversation_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class CallLog(Base):
    """1:1 WebRTC voice & video call history."""

    __tablename__ = "calls"
    __table_args__ = (
        Index("ix_calls_caller_created", "caller_id", "created_at"),
        Index("ix_calls_callee_created", "callee_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    conversation_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True, index=True
    )
    caller_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    callee_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    call_type: Mapped[str] = mapped_column(String(16), nullable=False, default="voice")  # voice | video
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="ringing", index=True
    )  # ringing | ongoing | ended | missed | declined | busy
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, index=True
    )


class FederationPeer(Base):
    """Known remote federated RelayChat nodes and cached Ed25519 keys."""

    __tablename__ = "federation_peers"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    domain: Mapped[str] = mapped_column(String(128), unique=True, index=True, nullable=False)
    node_url: Mapped[str] = mapped_column(String(255), nullable=False)
    inbox_url: Mapped[str | None] = mapped_column(String(255), nullable=True)
    public_key_ed25519: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(
        String(24), nullable=False, default="online"
    )  # online | degraded | unreachable | blocked
    is_trusted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_blocked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    failure_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow
    )


class FederationOutbox(Base):
    """Store-and-forward queue for S2S delivery with retry, exponential backoff, and dead-letter."""

    __tablename__ = "federation_outbox"
    __table_args__ = (Index("ix_fed_outbox_status_retry", "status", "next_retry_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    event_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    target_domain: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    target_inbox_url: Mapped[str] = mapped_column(String(255), nullable=False)
    event_type: Mapped[str] = mapped_column(String(48), nullable=False)
    payload_json: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="pending", index=True
    )  # pending | processing | delivered | dead_letter
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=6)
    next_retry_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, index=True
    )
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    dead_lettered_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RemoteUserCache(Base):
    """TTL-cached remote actors resolved via GET https://domain/.well-known/user/{username}."""

    __tablename__ = "remote_users"
    __table_args__ = (
        UniqueConstraint("username", "domain", name="uq_remote_users_username_domain"),
        Index("ix_remote_users_domain_expires", "domain", "expires_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("users.id", ondelete="CASCADE"),
        unique=True,
        nullable=False,
        index=True,
    )
    global_id: Mapped[str] = mapped_column(String(160), unique=True, index=True, nullable=False)
    username: Mapped[str] = mapped_column(String(20), nullable=False)
    domain: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    display_name: Mapped[str] = mapped_column(String(80), nullable=False)
    about: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    avatar_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    public_key: Mapped[str] = mapped_column(Text, nullable=False)
    node_url: Mapped[str] = mapped_column(String(255), nullable=False)
    inbox_url: Mapped[str] = mapped_column(String(255), nullable=False)
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )


class FederationNonce(Base):
    """5-minute replay-protection nonce window for incoming Ed25519 HTTP Signatures."""

    __tablename__ = "federation_nonces"
    __table_args__ = (
        UniqueConstraint("origin_domain", "nonce", name="uq_fed_nonces_domain_nonce"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    origin_domain: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    nonce: Mapped[str] = mapped_column(String(128), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class FederationPolicySetting(Base):
    """Key-value configuration store for node federation policy (open | allowlist | denylist)."""

    __tablename__ = "federation_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow
    )


class FederationDomainRule(Base):
    """Admin allow-list / block-list rules for remote federated domains."""

    __tablename__ = "federation_domain_rules"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    domain: Mapped[str] = mapped_column(String(128), unique=True, index=True, nullable=False)
    rule: Mapped[str] = mapped_column(
        String(16), nullable=False, index=True
    )  # allow | block
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class PushSubscription(Base):
    """Browser Web Push endpoints (VAPID)."""

    __tablename__ = "push_subscriptions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    device_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("devices.id", ondelete="CASCADE"), nullable=True
    )
    endpoint: Mapped[str] = mapped_column(String(512), unique=True, nullable=False)
    p256dh: Mapped[str] = mapped_column(String(255), nullable=False)
    auth_secret: Mapped[str] = mapped_column(String(255), nullable=False)
    local_decrypt_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    user_agent: Mapped[str | None] = mapped_column(String(255), nullable=True)
    updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=utcnow, onupdate=utcnow
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
