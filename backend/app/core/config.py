from functools import lru_cache
from pathlib import Path
from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Branding & Node Identity
    APP_NAME: str = "RelayChat"
    APP_DOMAIN: str = "chatapp.in"
    NODE_PUBLIC_URL: str = "http://localhost:8000"
    FRONTEND_URL: str = "http://localhost:3000"

    # Database (MySQL 8 in Docker/Prod; SQLite supported for local zero-daemon dev/tests)
    DATABASE_URL: str = "sqlite+aiosqlite:///./relaychat.db"

    # JWT & Cookie Auth
    JWT_SECRET_KEY: str = "relaychat-dev-secret-change-in-production-min-32-chars"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    REFRESH_TOKEN_EXPIRE_DAYS: int = 30
    REFRESH_COOKIE_NAME: str = "relaychat_refresh"
    COOKIE_SECURE: bool = False
    COOKIE_SAMESITE: str = "lax"

    # Node Ed25519 Federation Signing Key
    NODE_PRIVATE_KEY_B64: str = ""
    NODE_KEY_PATH: str = "./.node_keys/node_ed25519.json"

    # Storage & Uploads
    STORAGE_DIR: str = "./storage"
    UPLOAD_SIGNING_SECRET: str = "relaychat-upload-signing-secret-32-bytes"
    MAX_UPLOAD_BYTES: int = 52_428_800  # 50 MB
    MAX_AVATAR_BYTES: int = 5_242_880   # 5 MB
    CHUNK_SIZE_BYTES: int = 1_048_576   # 1 MB

    # Rate Limiting & CORS
    CORS_ORIGINS: str = "http://localhost:3000,http://127.0.0.1:3000"
    AUTH_RATE_LIMIT_PER_MINUTE: int = 25
    API_RATE_LIMIT_PER_MINUTE: int = 240

    # TURN / WebRTC
    TURN_REALM: str = "chatapp.in"
    TURN_SHARED_SECRET: str = "relaychat_turn_shared_secret"

    # Web Push
    VAPID_PUBLIC_KEY: str = ""
    VAPID_PRIVATE_KEY: str = ""
    VAPID_SUBJECT: str = "mailto:admin@chatapp.in"

    @property
    def cors_origin_list(self) -> List[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def storage_path(self) -> Path:
        p = Path(self.STORAGE_DIR)
        p.mkdir(parents=True, exist_ok=True)
        return p


@lru_cache
def get_settings() -> Settings:
    return Settings()
