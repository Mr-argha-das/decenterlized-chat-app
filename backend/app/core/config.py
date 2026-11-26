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
    ENVIRONMENT: str = "development"  # development | test | production
    APP_NAME: str = "RelayChat"
    APP_DOMAIN: str = "chatapp.in"
    NODE_PUBLIC_URL: str = "http://localhost:8000"
    FRONTEND_URL: str = "http://localhost:3000"
    ADMIN_USERNAMES: str = "admin,rahul"

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

    # Node Ed25519 Federation Signing Key & S2S Federation Controls
    NODE_PRIVATE_KEY_B64: str = ""
    NODE_KEY_PATH: str = "./.node_keys/node_ed25519.json"
    FEDERATION_ENABLED: bool = True
    FEDERATION_REQUIRE_HTTPS: bool = False
    FEDERATION_ALLOW_PRIVATE_IPS: bool = False
    FEDERATION_HTTP_TIMEOUT_SECONDS: float = 5.0
    FEDERATION_USER_CACHE_TTL_SECONDS: int = 300
    FEDERATION_SIGNATURE_MAX_SKEW_SECONDS: int = 300
    FEDERATION_OUTBOX_POLL_INTERVAL_SECONDS: float = 1.5
    FEDERATION_OUTBOX_BASE_DELAY_SECONDS: float = 2.0
    FEDERATION_OUTBOX_MAX_DELAY_SECONDS: float = 300.0
    FEDERATION_OUTBOX_MAX_ATTEMPTS: int = 6
    FEDERATION_DEFAULT_POLICY_MODE: str = "open"  # open | allowlist | denylist
    FEDERATION_ALLOW_DOMAINS: str = ""
    FEDERATION_BLOCK_DOMAINS: str = ""
    FEDERATION_DOMAIN_MAP: str = ""  # Optional local routing: node-a.local=http://api-a:8000,node-b.local=http://api-b:8000

    # Storage & Uploads (Encrypted blobs only: local disk or S3-compatible/MinIO)
    STORAGE_BACKEND: str = "local"  # local | s3
    STORAGE_DIR: str = "./storage"
    S3_ENDPOINT_URL: str = ""
    S3_BUCKET_NAME: str = "relaychat-blobs"
    S3_ACCESS_KEY: str = ""
    S3_SECRET_KEY: str = ""
    S3_REGION: str = "us-east-1"
    UPLOAD_SIGNING_SECRET: str = "relaychat-upload-signing-secret-32-bytes"
    UPLOAD_URL_EXPIRE_SECONDS: int = 1800
    MAX_UPLOAD_BYTES: int = 104_857_600           # 100 MB per file
    PER_USER_STORAGE_QUOTA_BYTES: int = 524_288_000  # 500 MB per-user encrypted blob quota
    MAX_AVATAR_BYTES: int = 5_242_880             # 5 MB
    CHUNK_SIZE_BYTES: int = 1_048_576             # 1 MB plaintext chunk size

    # Rate Limiting, Hardening & CORS
    CORS_ORIGINS: str = "http://localhost:3000,http://127.0.0.1:3000"
    AUTH_RATE_LIMIT_PER_MINUTE: int = 25
    API_RATE_LIMIT_PER_MINUTE: int = 240
    UPLOAD_RATE_LIMIT_PER_MINUTE: int = 120
    FEDERATION_RATE_LIMIT_PER_MINUTE: int = 180
    WS_MSG_RATE_LIMIT_PER_MINUTE: int = 180
    CSP_ENABLED: bool = True
    STRICT_FRAME_HEADERS: bool = False
    FILE_SCANNER_ENABLED: bool = True
    FILE_SCANNER_CMD: str = ""  # Optional shell/ClamAV scanner command (e.g. "clamdscan --no-summary")
    EXPIRY_CLEANUP_INTERVAL_SECONDS: float = 30.0
    STATUS_TTL_HOURS: int = 24

    # TURN / WebRTC
    TURN_REALM: str = "chatapp.in"
    TURN_SHARED_SECRET: str = "relaychat_turn_shared_secret"

    # Web Push
    VAPID_PUBLIC_KEY: str = ""
    VAPID_PRIVATE_KEY: str = ""
    VAPID_KEY_PATH: str = "./.node_keys/vapid_keys.json"
    VAPID_SUBJECT: str = "mailto:admin@chatapp.in"

    @property
    def cors_origin_list(self) -> List[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def storage_path(self) -> Path:
        p = Path(self.STORAGE_DIR)
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def must_require_federation_https(self) -> bool:
        return bool(self.FEDERATION_REQUIRE_HTTPS or self.ENVIRONMENT.strip().lower() == "production")

    @property
    def admin_username_set(self) -> set[str]:
        return {u.strip().lower() for u in self.ADMIN_USERNAMES.split(",") if u.strip()}

    @property
    def initial_allow_domains(self) -> set[str]:
        return {d.strip().lower() for d in self.FEDERATION_ALLOW_DOMAINS.split(",") if d.strip()}

    @property
    def initial_block_domains(self) -> set[str]:
        return {d.strip().lower() for d in self.FEDERATION_BLOCK_DOMAINS.split(",") if d.strip()}

    @property
    def federation_domain_map(self) -> dict[str, str]:
        mapping: dict[str, str] = {}
        raw = self.FEDERATION_DOMAIN_MAP.strip()
        if not raw:
            return mapping
        for item in raw.split(","):
            part = item.strip()
            if "=" in part:
                k, v = part.split("=", 1)
                if k.strip() and v.strip():
                    mapping[k.strip().lower()] = v.strip().rstrip("/")
        return mapping


@lru_cache
def get_settings() -> Settings:
    return Settings()
