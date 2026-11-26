import json
import re
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

USERNAME_REGEX = re.compile(r"^[a-z0-9_.]{3,20}$")
PrivacyScope = Literal["everyone", "contacts", "nobody"]
WallpaperChoice = Literal["default", "emerald", "midnight", "sand", "rose", "slate"]


def validate_p256_public_key(value: str) -> str:
    """Ensure uploaded key is a valid ECDH P-256 public key and NEVER contains a private scalar."""
    raw = value.strip()
    if not raw or len(raw) > 4096:
        raise ValueError("Public key must be non-empty and under 4096 characters.")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("Public key must be a valid Web Crypto JWK JSON string.") from exc

    if not isinstance(parsed, dict):
        raise ValueError("Public key JWK must be a JSON object.")
    if "d" in parsed:
        raise ValueError("Private key material ('d') must NEVER be sent to the server.")
    if parsed.get("kty") != "EC" or parsed.get("crv") != "P-256":
        raise ValueError("Public key must be an EC P-256 key (kty='EC', crv='P-256').")
    if not parsed.get("x") or not parsed.get("y"):
        raise ValueError("Public key JWK is missing curve coordinates 'x' or 'y'.")
    canonical = {
        "kty": "EC",
        "crv": "P-256",
        "x": str(parsed["x"]),
        "y": str(parsed["y"]),
        "ext": True,
    }
    return json.dumps(canonical, separators=(",", ":"))


class UserProfileOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    username: str
    domain: str
    global_id: str
    public_key: str
    display_name: str
    about: str
    avatar_url: str | None
    is_local: bool
    is_online: bool
    last_seen_at: datetime | None
    privacy_last_seen: str
    privacy_profile_photo: str = "everyone"
    privacy_read_receipts: bool
    privacy_read_receipts_visibility: str = "everyone"
    notifications_enabled: bool = True
    notification_sound: bool = True
    chat_wallpaper: str = "default"
    theme: str
    created_at: datetime


class UserProfileUpdate(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=80)
    about: str | None = Field(default=None, max_length=255)
    avatar_url: str | None = Field(default=None, max_length=512)
    privacy_last_seen: PrivacyScope | None = None
    privacy_profile_photo: PrivacyScope | None = None
    privacy_read_receipts: bool | PrivacyScope | None = None
    privacy_read_receipts_visibility: PrivacyScope | None = None
    notifications_enabled: bool | None = None
    notification_sound: bool | None = None
    chat_wallpaper: WallpaperChoice | None = None
    theme: Literal["light", "dark", "system"] | None = None


class DeleteAccountRequest(BaseModel):
    password: str | None = Field(default=None, max_length=128)
    confirm: str | None = Field(default=None, max_length=32)


class PublicKeyRotateRequest(BaseModel):
    public_key: str

    @field_validator("public_key")
    @classmethod
    def _check_pub_key(cls, v: str) -> str:
        return validate_p256_public_key(v)


class DeviceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    device_name: str
    user_agent: str | None
    ip_address: str | None
    is_revoked: bool
    last_active: datetime
    last_active_at: datetime
    created_at: datetime
    is_current: bool = False


class UsernameCheckOut(BaseModel):
    username: str
    id: str
    valid: bool
    available: bool
    reason: str | None = None


class WellKnownUserOut(BaseModel):
    id: str
    username: str
    domain: str
    global_id: str
    display_name: str
    about: str
    avatar_url: str | None
    public_key: str
    key_algorithm: str = "ECDH-P256"
    node: str
    node_url: str
    federation_inbox_url: str


class NodeKeyOut(BaseModel):
    app_name: str
    domain: str
    node_url: str
    algorithm: str = "Ed25519"
    public_key: str
    federation_inbox_url: str
    protocol_version: str = "1.0"


WellKnownNodeKeyOut = NodeKeyOut
