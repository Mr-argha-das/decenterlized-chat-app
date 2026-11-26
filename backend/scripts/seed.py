"""Seed script creating sample local users on RelayChat with valid P-256 public keys."""
import asyncio
import base64
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from sqlalchemy import select

from app.core.config import get_settings
from app.core.security import hash_password
from app.db.base import Base
from app.db.session import AsyncSessionLocal, engine
from app.models.entities import Contact, User


def _b64url_uint(val: int, length: int = 32) -> str:
    return base64.urlsafe_b64encode(val.to_bytes(length, "big")).rstrip(b"=").decode("ascii")


def generate_p256_jwk_pair() -> tuple[dict[str, object], dict[str, object]]:
    priv = ec.generate_private_key(ec.SECP256R1())
    nums = priv.private_numbers()
    pub_nums = nums.public_numbers
    x = _b64url_uint(pub_nums.x)
    y = _b64url_uint(pub_nums.y)
    d = _b64url_uint(nums.private_value)
    pub_jwk: dict[str, object] = {"kty": "EC", "crv": "P-256", "x": x, "y": y, "ext": True}
    priv_jwk: dict[str, object] = {
        "kty": "EC",
        "crv": "P-256",
        "x": x,
        "y": y,
        "d": d,
        "ext": True,
        "key_ops": ["deriveKey", "deriveBits"],
    }
    return pub_jwk, priv_jwk


def create_encrypted_key_backup(global_id: str, pub_jwk: dict[str, object], priv_jwk: dict[str, object], passphrase: str) -> dict[str, object]:
    """Matches browser Web Crypto PBKDF2-SHA256 (250k iterations) + AES-256-GCM backup format."""
    salt = os.urandom(16)
    iv = os.urandom(12)
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=250_000,
    )
    key = kdf.derive(passphrase.encode("utf-8"))
    aesgcm = AESGCM(key)
    plaintext = json.dumps(
        {"globalId": global_id, "publicKeyJwk": pub_jwk, "privateKeyJwk": priv_jwk},
        separators=(",", ":"),
    ).encode("utf-8")
    ciphertext = aesgcm.encrypt(iv, plaintext, None)
    return {
        "format": "relaychat-key-backup-v1",
        "globalId": global_id,
        "kdf": "PBKDF2-SHA256",
        "iterations": 250_000,
        "salt": base64.b64encode(salt).decode("ascii"),
        "iv": base64.b64encode(iv).decode("ascii"),
        "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
        "publicKeyJwk": pub_jwk,
    }


DEMO_USERS = [
    ("rahul", "Rahul Sharma", "Building decentralized systems in Jaipur"),
    ("priya", "Priya Verma", "Available • End-to-end encrypted"),
    ("arjun", "Arjun Mehta", "Security researcher | Open web"),
]
DEMO_PASSWORD = "DemoPassword123!"


async def seed() -> None:
    settings = get_settings()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    backup_dir = Path(settings.NODE_KEY_PATH).parent / "demo_backups"
    backup_dir.mkdir(parents=True, exist_ok=True)

    created_users: list[User] = []
    async with AsyncSessionLocal() as db:
        for username, display_name, about in DEMO_USERS:
            global_id = f"{username}@{settings.APP_DOMAIN}"
            res = await db.execute(select(User).where(User.global_id == global_id))
            existing = res.scalar_one_or_none()
            if existing:
                created_users.append(existing)
                continue

            pub_jwk, priv_jwk = generate_p256_jwk_pair()
            user = User(
                username=username,
                domain=settings.APP_DOMAIN,
                global_id=global_id,
                password_hash=hash_password(DEMO_PASSWORD),
                public_key=json.dumps(pub_jwk, separators=(",", ":")),
                display_name=display_name,
                about=about,
                is_local=True,
                node_url=settings.NODE_PUBLIC_URL.rstrip("/"),
            )
            db.add(user)
            await db.flush()
            created_users.append(user)

            backup = create_encrypted_key_backup(global_id, pub_jwk, priv_jwk, DEMO_PASSWORD)
            (backup_dir / f"{username}.relaykey.json").write_text(
                json.dumps(backup, indent=2), encoding="utf-8"
            )

        # Link Rahul <-> Priya and Rahul <-> Arjun as contacts
        if len(created_users) >= 3:
            pairs = [
                (created_users[0].id, created_users[1].id),
                (created_users[1].id, created_users[0].id),
                (created_users[0].id, created_users[2].id),
            ]
            for owner_id, target_id in pairs:
                exists = await db.execute(
                    select(Contact).where(
                        Contact.owner_id == owner_id,
                        Contact.contact_user_id == target_id,
                    )
                )
                if not exists.scalar_one_or_none():
                    db.add(Contact(owner_id=owner_id, contact_user_id=target_id))

        await db.commit()

    print(f"Seeded {len(created_users)} users on @{settings.APP_DOMAIN} (password: {DEMO_PASSWORD})")
    print(f"Encrypted key backups written to: {backup_dir}")


if __name__ == "__main__":
    asyncio.run(seed())
