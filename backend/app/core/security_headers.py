"""HTTP Security Headers & Content-Security-Policy middleware."""
from fastapi import Request, Response

from app.core.config import get_settings


def apply_security_headers(request: Request, response: Response) -> None:
    settings = get_settings()
    is_prod = settings.ENVIRONMENT.strip().lower() == "production"

    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault(
        "Permissions-Policy",
        "camera=(self), microphone=(self), geolocation=(self), payment=()",
    )
    response.headers.setdefault("X-Permitted-Cross-Domain-Policies", "none")

    if is_prod or settings.COOKIE_SECURE:
        response.headers.setdefault(
            "Strict-Transport-Security",
            "max-age=63072000; includeSubDomains; preload",
        )

    if settings.STRICT_FRAME_HEADERS:
        response.headers.setdefault("X-Frame-Options", "DENY")

    # Skip strict API CSP on interactive Swagger docs so /docs continues to render cleanly
    if settings.CSP_ENABLED and not request.url.path.startswith(("/docs", "/redoc")):
        frame_ancestors = "'none'" if settings.STRICT_FRAME_HEADERS else "*"
        csp_directives = [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://tile.openstreetmap.org",
            "media-src 'self' data: blob:",
            "connect-src 'self' ws: wss: http: https:",
            "worker-src 'self' blob:",
            "font-src 'self' data:",
            "object-src 'none'",
            "base-uri 'self'",
            f"frame-ancestors {frame_ancestors}",
        ]
        response.headers.setdefault("Content-Security-Policy", "; ".join(csp_directives))
