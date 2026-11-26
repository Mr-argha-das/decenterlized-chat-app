from pydantic import BaseModel, Field, field_validator

from app.schemas.user import USERNAME_REGEX, DeviceOut, UserProfileOut, validate_p256_public_key


class SignupRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=20)
    password: str = Field(..., min_length=8, max_length=128)
    display_name: str | None = Field(default=None, min_length=1, max_length=80)
    public_key: str = Field(..., description="Browser-generated ECDH P-256 public JWK")
    device_name: str = Field(default="Web Browser", min_length=1, max_length=120)

    @field_validator("username")
    @classmethod
    def _validate_username(cls, v: str) -> str:
        cleaned = v.strip()
        if not USERNAME_REGEX.fullmatch(cleaned):
            raise ValueError(
                "Username must be 3-20 characters using only lowercase a-z, 0-9, '_' or '.'."
            )
        return cleaned

    @field_validator("public_key")
    @classmethod
    def _validate_pubkey(cls, v: str) -> str:
        return validate_p256_public_key(v)


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=160)
    password: str = Field(..., min_length=1, max_length=128)
    device_name: str = Field(default="Web Browser", min_length=1, max_length=120)

    @field_validator("username")
    @classmethod
    def _normalize_identifier(cls, v: str) -> str:
        cleaned = v.strip().lower()
        # Allow logging in with either `rahul` or `rahul@chatapp.in`
        if "@" in cleaned:
            cleaned = cleaned.split("@", 1)[0]
        return cleaned


class RefreshRequest(BaseModel):
    refresh_token: str | None = None


class AuthTokensOut(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int
    user: UserProfileOut
    device: DeviceOut
