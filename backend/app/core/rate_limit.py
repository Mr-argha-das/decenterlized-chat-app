import time
from collections import defaultdict, deque
from typing import Callable

from fastapi import Request, status

from app.core.config import get_settings
from app.core.errors import AppError


class SlidingWindowRateLimiter:
    """In-memory sliding-window rate limiter keyed by bucket + client IP."""

    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def reset(self) -> None:
        self._hits.clear()

    def check(self, bucket: str, key: str, max_requests: int, window_seconds: int = 60) -> None:
        now = time.monotonic()
        composite = f"{bucket}:{key}"
        q = self._hits[composite]
        cutoff = now - window_seconds
        while q and q[0] < cutoff:
            q.popleft()
        if len(q) >= max_requests:
            retry_after = max(1, int(window_seconds - (now - q[0])))
            raise AppError(
                code="RATE_LIMITED",
                message=f"Too many requests. Please retry in {retry_after}s.",
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                details={"retry_after_seconds": retry_after},
            )
        q.append(now)


rate_limiter = SlidingWindowRateLimiter()


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def auth_rate_limit() -> Callable[[Request], None]:
    def _dep(request: Request) -> None:
        settings = get_settings()
        rate_limiter.check("auth", client_ip(request), settings.AUTH_RATE_LIMIT_PER_MINUTE, 60)

    return _dep


def api_rate_limit() -> Callable[[Request], None]:
    def _dep(request: Request) -> None:
        settings = get_settings()
        rate_limiter.check("api", client_ip(request), settings.API_RATE_LIMIT_PER_MINUTE, 60)

    return _dep
