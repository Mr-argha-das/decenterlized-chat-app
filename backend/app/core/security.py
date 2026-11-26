import base64
import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)
from fastapi import status

from app.core.config import get_settings
from app.core.errors import AppError

_password_hasher = PasswordHasher(
    time_cost=2,
    memory_cost=65536,
    parallelism=2,
)


def hash_password(password: str) -> str:
    return _password_hasher.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    if not password_hash:
        return False
    try:
        return _password_hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def create_access_token(user_id: str, device_id: str, global_id: str) -> tuple[str, int]:
    settings = get_settings()
    expires_delta = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    now = datetime.now(timezone.utc)
    exp = now + expires_delta
    payload = {
        "sub": user_id,
        "did": device_id,
        "gid": global_id,
        "typ": "access",
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    token = jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)
    return token, int(expires_delta.total_seconds())


def create_refresh_token(user_id: str, device_id: str) -> tuple[str, str, datetime]:
    settings = get_settings()
    jti = uuid.uuid4().hex
    now = datetime.now(timezone.utc)
    exp = now + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    payload = {
        "sub": user_id,
        "did": device_id,
        "jti": jti,
        "typ": "refresh",
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    token = jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)
    return token, jti, exp


def decode_jwt_token(token: str, expected_type: str) -> dict[str, Any]:
    settings = get_settings()
    try:
        payload = jwt.decode(
            token,
            settings.JWT_SECRET_KEY,
            algorithms=[settings.JWT_ALGORITHM],
        )
    except jwt.ExpiredSignatureError as exc:
        raise AppError(
            code="TOKEN_EXPIRED",
            message="Authentication token has expired.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        ) from exc
    except jwt.PyJWTError as exc:
        raise AppError(
            code="INVALID_TOKEN",
            message="Invalid authentication token.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        ) from exc

    if payload.get("typ") != expected_type:
        raise AppError(
            code="INVALID_TOKEN_TYPE",
            message=f"Expected a {expected_type} token.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )
    return payload


# -----------------------------------------------------------------------------
# Node Ed25519 Federation Keypair Management
# -----------------------------------------------------------------------------
_cached_node_keys: dict[tuple[str, str], Ed25519PrivateKey] = {}


def reset_node_key_cache() -> None:
    _cached_node_keys.clear()


def get_node_private_key() -> Ed25519PrivateKey:
    settings = get_settings()
    cache_key = (settings.NODE_PRIVATE_KEY_B64, str(Path(settings.NODE_KEY_PATH)))
    if cache_key in _cached_node_keys:
        return _cached_node_keys[cache_key]

    if settings.NODE_PRIVATE_KEY_B64:
        raw = base64.b64decode(settings.NODE_PRIVATE_KEY_B64)
        priv = Ed25519PrivateKey.from_private_bytes(raw)
        _cached_node_keys[cache_key] = priv
        return priv

    key_file = Path(settings.NODE_KEY_PATH)
    if key_file.exists():
        data = json.loads(key_file.read_text(encoding="utf-8"))
        raw = base64.b64decode(data["private_key_b64"])
        priv = Ed25519PrivateKey.from_private_bytes(raw)
        _cached_node_keys[cache_key] = priv
        return priv

    key_file.parent.mkdir(parents=True, exist_ok=True)
    priv = Ed25519PrivateKey.generate()
    priv_b64 = base64.b64encode(
        priv.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    ).decode("ascii")
    pub_b64 = base64.b64encode(
        priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    ).decode("ascii")
    key_file.write_text(
        json.dumps(
            {
                "algorithm": "Ed25519",
                "domain": settings.APP_DOMAIN,
                "private_key_b64": priv_b64,
                "public_key_b64": pub_b64,
                "created_at": datetime.now(timezone.utc).isoformat(),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    _cached_node_keys[cache_key] = priv
    return priv


def get_node_public_key_b64() -> str:
    priv = get_node_private_key()
    pub_bytes = priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return base64.b64encode(pub_bytes).decode("ascii")


def sign_ed25519(message: bytes) -> str:
    sig = get_node_private_key().sign(message)
    return base64.b64encode(sig).decode("ascii")


def verify_ed25519(public_key_b64: str, message: bytes, signature_b64: str) -> bool:
    try:
        pub_bytes = base64.b64decode(public_key_b64)
        sig_bytes = base64.b64decode(signature_b64)
        pub = Ed25519PublicKey.from_public_bytes(pub_bytes)
        pub.verify(sig_bytes, message)
        return True
    except (ValueError, InvalidSignature):
        return False
