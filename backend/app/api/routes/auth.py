from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_auth
from app.core.config import get_settings
from app.core.errors import AppError
from app.core.rate_limit import auth_rate_limit, client_ip
from app.db.session import get_db_session
from app.models.entities import Device, User
from app.schemas.auth import AuthTokensOut, LoginRequest, RefreshRequest, SignupRequest
from app.services.auth_service import (
    authenticate_user_and_device,
    register_user_and_device,
    revoke_device_session,
    rotate_refresh_token,
)

router = APIRouter(tags=["auth"])


def _is_https_request(request: Request) -> bool:
    proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    if proto == "https" or request.url.scheme == "https":
        return True
    origin = (request.headers.get("origin") or request.headers.get("referer") or "").lower()
    return origin.startswith("https://")


def _set_auth_cookies(
    request: Request, response: Response, access_token: str, refresh_token: str
) -> None:
    settings = get_settings()
    is_https = settings.COOKIE_SECURE or _is_https_request(request)
    # Inside HTTPS cross-site preview iframes, SameSite=None + Secure + Partitioned (CHIPS)
    # allows cookies to work seamlessly; on plain HTTP localhost/tests, use SameSite=Lax.
    samesite_mode = "none" if is_https else settings.COOKIE_SAMESITE

    response.set_cookie(
        key="relaychat_access",
        value=access_token,
        httponly=True,
        secure=is_https,
        samesite=samesite_mode,  # type: ignore[arg-type]
        max_age=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        path="/",
    )
    response.set_cookie(
        key=settings.REFRESH_COOKIE_NAME,
        value=refresh_token,
        httponly=True,
        secure=is_https,
        samesite=samesite_mode,  # type: ignore[arg-type]
        max_age=settings.REFRESH_TOKEN_EXPIRE_DAYS * 86400,
        path="/",
    )
    if is_https:
        # Append Partitioned attribute (CHIPS) to Set-Cookie headers for cross-site iframe support
        raw_headers = response.raw_headers
        for idx, (k, v) in enumerate(raw_headers):
            if k.lower() == b"set-cookie" and b"Partitioned" not in v:
                raw_headers[idx] = (k, v + b"; Partitioned")


def _clear_auth_cookies(request: Request, response: Response) -> None:
    settings = get_settings()
    is_https = settings.COOKIE_SECURE or _is_https_request(request)
    samesite_mode = "none" if is_https else settings.COOKIE_SAMESITE
    response.delete_cookie(
        key="relaychat_access", path="/", secure=is_https, samesite=samesite_mode  # type: ignore[arg-type]
    )
    response.delete_cookie(
        key=settings.REFRESH_COOKIE_NAME,
        path="/",
        secure=is_https,
        samesite=samesite_mode,  # type: ignore[arg-type]
    )


@router.post(
    "/signup",
    response_model=AuthTokensOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(auth_rate_limit())],
)
async def signup(
    body: SignupRequest,
    request: Request,
    response: Response,
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> AuthTokensOut:
    out = await register_user_and_device(
        db=db,
        body=body,
        user_agent=request.headers.get("user-agent"),
        ip_addr=client_ip(request),
    )
    _set_auth_cookies(request, response, out.access_token, out.refresh_token)
    return out


@router.post(
    "/login",
    response_model=AuthTokensOut,
    dependencies=[Depends(auth_rate_limit())],
)
async def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> AuthTokensOut:
    out = await authenticate_user_and_device(
        db=db,
        body=body,
        user_agent=request.headers.get("user-agent"),
        ip_addr=client_ip(request),
    )
    _set_auth_cookies(request, response, out.access_token, out.refresh_token)
    return out


@router.post(
    "/refresh",
    response_model=AuthTokensOut,
    dependencies=[Depends(auth_rate_limit())],
)
async def refresh_tokens(
    request: Request,
    response: Response,
    db: Annotated[AsyncSession, Depends(get_db_session)],
    body: RefreshRequest | None = None,
    cookie_token: Annotated[str | None, Cookie(alias="relaychat_refresh")] = None,
) -> AuthTokensOut:
    raw_token = (body.refresh_token if body and body.refresh_token else None) or cookie_token
    if not raw_token:
        raise AppError(
            code="MISSING_REFRESH_TOKEN",
            message="Refresh token is required.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )
    try:
        out = await rotate_refresh_token(db=db, raw_token=raw_token)
    except AppError:
        _clear_auth_cookies(request, response)
        raise

    _set_auth_cookies(request, response, out.access_token, out.refresh_token)
    return out


@router.post("/logout")
async def logout(
    request: Request,
    response: Response,
    auth: Annotated[tuple[User, Device], Depends(get_current_auth)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> dict[str, str]:
    user, device = auth
    await revoke_device_session(db=db, user=user, device=device)
    _clear_auth_cookies(request, response)
    return {"status": "logged_out"}
