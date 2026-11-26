import time
from collections import defaultdict, deque
from typing import Callable

from fastapi import Request, status

from app.core.config import get_settings
from app.core.errors import AppError
from app.core.metrics import metrics_registry


class SlidingWindowRateLimiter:
    """In-memory sliding-window rate limiter keyed by bucket + client IP / user ID."""

    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def reset(self) -> None:
        self._hits.clear()

    def check(
        self,
        bucket: str,
        key: str,
        max_requests: int,
        window_seconds: int = 60,
    ) -> dict[str, str]:
        now = time.monotonic()
        composite = f"{bucket}:{key}"
        q = self._hits[composite]
        cutoff = now - window_seconds
        while q and q[0] < cutoff:
            q.popleft()
        if len(q) >= max_requests:
            retry_after = max(1, int(window_seconds - (now - q[0])))
            metrics_registry.inc_counter("rate_limited_requests_total", 1)
            raise AppError(
                code="RATE_LIMITED",
                message=f"Too many requests. Please retry in {retry_after}s.",
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                details={"retry_after_seconds": retry_after},
            )
        q.append(now)
        remaining = max(0, max_requests - len(q))
        reset_epoch = int(time.time() + window_seconds)
        return {
            "X-RateLimit-Limit": str(max_requests),
            "X-RateLimit-Remaining": str(remaining),
            "X-RateLimit-Reset": str(reset_epoch),
        }


rate_limiter = SlidingWindowRateLimiter()


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _attach_headers(request: Request, headers: dict[str, str]) -> None:
    request.state.rate_limit_headers = headers


def auth_rate_limit() -> Callable[[Request], None]:
    def _dep(request: Request) -> None:
        settings = get_settings()
        headers = rate_limiter.check(
            "auth", client_ip(request), settings.AUTH_RATE_LIMIT_PER_MINUTE, 60
        )
        _attach_headers(request, headers)

    return _dep


def api_rate_limit() -> Callable[[Request], None]:
    def _dep(request: Request) -> None:
        settings = get_settings()
        headers = rate_limiter.check(
            "api", client_ip(request), settings.API_RATE_LIMIT_PER_MINUTE, 60
        )
        _attach_headers(request, headers)

    return _dep


def upload_rate_limit() -> Callable[[Request], None]:
    def _dep(request: Request) -> None:
        settings = get_settings()
        headers = rate_limiter.check(
            "upload", client_ip(request), settings.UPLOAD_RATE_LIMIT_PER_MINUTE, 60
        )
        _attach_headers(request, headers)

    return _dep


def federation_rate_limit() -> Callable[[Request], None]:
    def _dep(request: Request) -> None:
        settings = get_settings()
        headers = rate_limiter.check(
            "federation", client_ip(request), settings.FEDERATION_RATE_LIMIT_PER_MINUTE, 60
        )
        _attach_headers(request, headers)

    return _dep
