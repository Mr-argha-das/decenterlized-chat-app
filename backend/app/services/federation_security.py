"""
Phase 8 Federation Security:
1. Outbound SSRF Protection (private/loopback/link-local/metadata IP blocking, timeouts,
   no automatic redirects, HTTPS-only enforcement in production).
2. Ed25519 HTTP Signatures (RFC-style Signature header over `(request-target)`, `date`,
   `digest`, `x-federation-origin`, `x-federation-destination`, `x-federation-nonce`,
   with 5-minute clock-skew window and DB-backed nonce replay protection).
"""
import asyncio
import base64
import hashlib
import hmac
import ipaddress
import secrets
import socket
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime, parsedate_to_datetime
from urllib.parse import urlparse

from fastapi import Request, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import AppError
from app.core.security import get_node_public_key_b64, sign_ed25519, verify_ed25519
from app.models.entities import FederationNonce

CGNAT_NETWORK = ipaddress.ip_network("100.64.0.0/10")
REQUIRED_SIGNED_HEADERS = {
    "(request-target)",
    "date",
    "digest",
    "x-federation-origin",
    "x-federation-nonce",
}


def is_disallowed_ip(ip_str: str) -> bool:
    """Return True if IP is private, loopback, link-local, metadata, CGNAT, multicast, or reserved."""
    try:
        ip_obj = ipaddress.ip_address(ip_str)
    except ValueError:
        return True

    if isinstance(ip_obj, ipaddress.IPv6Address) and ip_obj.ipv4_mapped is not None:
        ip_obj = ip_obj.ipv4_mapped

    if (
        ip_obj.is_private
        or ip_obj.is_loopback
        or ip_obj.is_link_local
        or ip_obj.is_multicast
        or ip_obj.is_reserved
        or ip_obj.is_unspecified
    ):
        return True

    if isinstance(ip_obj, ipaddress.IPv4Address) and ip_obj in CGNAT_NETWORK:
        return True

    return False


async def validate_federation_url(
    url: str,
    *,
    require_https: bool | None = None,
    allow_private_ips: bool | None = None,
) -> str:
    """
    Validate an outbound S2S URL against SSRF, scheme downgrade, embedded credentials,
    and private/reserved IP resolution.
    """
    settings = get_settings()
    cleaned = url.strip()
    parsed = urlparse(cleaned)

    if parsed.scheme not in ("http", "https"):
        raise AppError(
            "FEDERATION_INVALID_SCHEME",
            f"Unsupported URL scheme '{parsed.scheme}'. Only HTTP(S) is permitted.",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    must_https = settings.must_require_federation_https if require_https is None else require_https
    if must_https and parsed.scheme != "https":
        raise AppError(
            "FEDERATION_HTTPS_REQUIRED",
            "HTTPS is strictly required for federation requests in production.",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    if parsed.username or parsed.password:
        raise AppError(
            "FEDERATION_INVALID_URL",
            "Embedded credentials are not allowed in federation URLs.",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    hostname = (parsed.hostname or "").strip().lower()
    if not hostname:
        raise AppError(
            "FEDERATION_INVALID_HOST",
            "Federation URL is missing a valid hostname.",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    allow_private = (
        settings.FEDERATION_ALLOW_PRIVATE_IPS if allow_private_ips is None else allow_private_ips
    )
    port = parsed.port or (443 if parsed.scheme == "https" else 80)

    # Check literal IP first before DNS resolution
    try:
        ipaddress.ip_address(hostname)
        resolved_ips = [hostname]
    except ValueError:
        try:
            addr_infos = await asyncio.to_thread(
                socket.getaddrinfo, hostname, port, type=socket.SOCK_STREAM
            )
            resolved_ips = list({str(info[4][0]) for info in addr_infos if info[4]})
        except socket.gaierror as exc:
            raise AppError(
                "FEDERATION_DNS_FAILURE",
                f"Could not resolve federation host '{hostname}'.",
                status_code=status.HTTP_502_BAD_GATEWAY,
            ) from exc

    if not resolved_ips:
        raise AppError(
            "FEDERATION_DNS_FAILURE",
            f"No IP addresses resolved for federation host '{hostname}'.",
            status_code=status.HTTP_502_BAD_GATEWAY,
        )

    if not allow_private:
        for ip_str in resolved_ips:
            if is_disallowed_ip(ip_str):
                raise AppError(
                    "FEDERATION_SSRF_BLOCKED",
                    f"Federation host '{hostname}' resolved to disallowed non-public IP '{ip_str}'.",
                    status_code=status.HTTP_403_FORBIDDEN,
                )

    return cleaned


def resolve_domain_base_url(domain: str) -> str:
    """Resolve `domain` into its base origin URL using FEDERATION_DOMAIN_MAP or protocol defaults."""
    settings = get_settings()
    norm = domain.strip().lower()
    mapped = settings.federation_domain_map.get(norm)
    if mapped:
        return mapped.rstrip("/")

    if settings.must_require_federation_https:
        return f"https://{norm}"

    if norm.endswith(".local") or norm.startswith("localhost") or ":" in norm:
        return f"http://{norm}"

    return f"https://{norm}"


def compute_body_digest(raw_body: bytes) -> str:
    digest_b64 = base64.b64encode(hashlib.sha256(raw_body).digest()).decode("ascii")
    return f"SHA-256={digest_b64}"


def parse_http_date(date_str: str) -> datetime:
    cleaned = date_str.strip()
    try:
        dt = parsedate_to_datetime(cleaned)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        pass
    try:
        iso_dt = datetime.fromisoformat(cleaned.replace("Z", "+00:00"))
        if iso_dt.tzinfo is None:
            iso_dt = iso_dt.replace(tzinfo=timezone.utc)
        return iso_dt.astimezone(timezone.utc)
    except Exception as exc:
        raise AppError(
            "FEDERATION_INVALID_DATE",
            "Malformed Date header on federation request.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        ) from exc


def build_signing_string(
    method: str,
    path_with_query: str,
    header_lookup: dict[str, str],
    signed_headers: list[str],
) -> bytes:
    target = f"{method.lower()} {path_with_query}"
    lines: list[str] = []
    for h in signed_headers:
        h_low = h.strip().lower()
        if h_low == "(request-target)":
            lines.append(f"(request-target): {target}")
        else:
            val = header_lookup.get(h_low, "").strip()
            lines.append(f"{h_low}: {val}")
    return "\n".join(lines).encode("utf-8")


def sign_federation_request(
    method: str,
    url: str,
    raw_body: bytes = b"",
    *,
    target_domain: str | None = None,
    origin_domain: str | None = None,
    nonce: str | None = None,
    date_hdr: str | None = None,
) -> dict[str, str]:
    """Build signed HTTP Signature headers (Ed25519 + Date + SHA-256 Digest + Nonce)."""
    settings = get_settings()
    origin = (origin_domain or settings.APP_DOMAIN).strip().lower()
    parsed = urlparse(url)
    path_with_query = (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else "")
    dest = (target_domain or parsed.hostname or "").strip().lower()

    effective_date = date_hdr or format_datetime(datetime.now(timezone.utc), usegmt=True)
    effective_digest = compute_body_digest(raw_body)
    effective_nonce = nonce or secrets.token_urlsafe(24)

    signed_headers = [
        "(request-target)",
        "date",
        "digest",
        "x-federation-origin",
        "x-federation-destination",
        "x-federation-nonce",
    ]
    header_map = {
        "date": effective_date,
        "digest": effective_digest,
        "x-federation-origin": origin,
        "x-federation-destination": dest,
        "x-federation-nonce": effective_nonce,
    }
    signing_bytes = build_signing_string(method, path_with_query, header_map, signed_headers)
    sig_b64 = sign_ed25519(signing_bytes)

    key_id = f"{settings.NODE_PUBLIC_URL.rstrip('/')}/.well-known/node-key"
    sig_header = (
        f'keyId="{key_id}",'
        f'algorithm="ed25519",'
        f'headers="{" ".join(signed_headers)}",'
        f'signature="{sig_b64}"'
    )

    return {
        "Date": effective_date,
        "Digest": effective_digest,
        "X-Federation-Origin": origin,
        "X-Federation-Destination": dest,
        "X-Federation-Nonce": effective_nonce,
        "X-Federation-Key": get_node_public_key_b64(),
        "Signature": sig_header,
        "Content-Type": "application/json",
    }


def parse_signature_header(raw_sig_header: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in raw_sig_header.split(","):
        piece = part.strip()
        if "=" not in piece:
            continue
        k, v = piece.split("=", 1)
        out[k.strip()] = v.strip().strip('"')
    return out


async def verify_and_record_federation_signature(
    request: Request,
    db: AsyncSession,
    raw_body: bytes,
    peer_public_key_b64: str,
) -> tuple[str, str]:
    """
    Verify incoming Ed25519 HTTP Signature, Date window (5 min), SHA-256 Digest,
    destination domain binding, and non-replayed X-Federation-Nonce.
    Returns `(origin_domain, nonce)`.
    """
    settings = get_settings()
    origin = (request.headers.get("x-federation-origin") or "").strip().lower()
    dest = (request.headers.get("x-federation-destination") or "").strip().lower()
    date_hdr = (request.headers.get("date") or "").strip()
    digest_hdr = (request.headers.get("digest") or "").strip()
    nonce = (request.headers.get("x-federation-nonce") or "").strip()
    sig_hdr = (request.headers.get("signature") or "").strip()

    if not origin or not date_hdr or not digest_hdr or not nonce or not sig_hdr:
        raise AppError(
            "FEDERATION_MISSING_HEADERS",
            "Missing required HTTP Signature headers (Signature, Date, Digest, X-Federation-Origin, X-Federation-Nonce).",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    if len(nonce) < 8 or len(nonce) > 128:
        raise AppError(
            "FEDERATION_INVALID_NONCE",
            "X-Federation-Nonce must be between 8 and 128 characters.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    if dest and dest != settings.APP_DOMAIN.lower():
        raise AppError(
            "FEDERATION_WRONG_DESTINATION",
            f"Request was signed for '{dest}', not '{settings.APP_DOMAIN.lower()}'.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    # 1. Enforce 5-minute clock-skew window
    now = datetime.now(timezone.utc)
    req_dt = parse_http_date(date_hdr)
    skew_seconds = abs((now - req_dt).total_seconds())
    if skew_seconds > settings.FEDERATION_SIGNATURE_MAX_SKEW_SECONDS:
        raise AppError(
            "FEDERATION_TIMESTAMP_SKEW",
            f"Federation Date header is outside the {settings.FEDERATION_SIGNATURE_MAX_SKEW_SECONDS}s replay window.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    # 2. Constant-time SHA-256 Digest verification
    expected_digest = compute_body_digest(raw_body)
    if not hmac.compare_digest(expected_digest.encode("ascii"), digest_hdr.encode("utf-8", errors="ignore")):
        raise AppError(
            "FEDERATION_DIGEST_MISMATCH",
            "Request body SHA-256 digest does not match Digest header.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    # 3. Parse Signature header & verify required covered headers
    parsed_sig = parse_signature_header(sig_hdr)
    algo = (parsed_sig.get("algorithm") or "").lower()
    if algo != "ed25519":
        raise AppError(
            "FEDERATION_UNSUPPORTED_ALGORITHM",
            "Federation HTTP Signature must use algorithm='ed25519'.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )
    headers_str = parsed_sig.get("headers") or ""
    signed_headers = [h.strip().lower() for h in headers_str.split() if h.strip()]
    if not REQUIRED_SIGNED_HEADERS.issubset(set(signed_headers)):
        raise AppError(
            "FEDERATION_INSUFFICIENT_SIGNED_HEADERS",
            "Signature must cover (request-target), date, digest, x-federation-origin, and x-federation-nonce.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )
    signature_b64 = parsed_sig.get("signature") or ""
    if not signature_b64:
        raise AppError(
            "FEDERATION_MISSING_SIGNATURE",
            "Signature value is empty.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    path_with_query = request.url.path + (f"?{request.url.query}" if request.url.query else "")
    lower_headers = {k.lower(): v for k, v in request.headers.items()}
    signing_bytes = build_signing_string(
        request.method,
        path_with_query,
        lower_headers,
        signed_headers,
    )

    if not verify_ed25519(peer_public_key_b64, signing_bytes, signature_b64):
        raise AppError(
            "FEDERATION_INVALID_SIGNATURE",
            f"Ed25519 HTTP Signature verification failed for origin '{origin}'.",
            status_code=status.HTTP_401_UNAUTHORIZED,
        )

    # 4. Replay protection: purge expired nonces and record (origin, nonce) atomically
    await db.execute(delete(FederationNonce).where(FederationNonce.expires_at < now))
    existing_nonce = (
        await db.execute(
            select(FederationNonce.id).where(
                FederationNonce.origin_domain == origin,
                FederationNonce.nonce == nonce,
            )
        )
    ).scalar_one_or_none()
    if existing_nonce is not None:
        raise AppError(
            "FEDERATION_REPLAY_DETECTED",
            "Duplicate X-Federation-Nonce detected within the 5-minute replay window.",
            status_code=status.HTTP_409_CONFLICT,
        )

    db.add(
        FederationNonce(
            origin_domain=origin,
            nonce=nonce,
            expires_at=now + timedelta(seconds=settings.FEDERATION_SIGNATURE_MAX_SKEW_SECONDS + 60),
            created_at=now,
        )
    )
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise AppError(
            "FEDERATION_REPLAY_DETECTED",
            "Duplicate X-Federation-Nonce detected within the 5-minute replay window.",
            status_code=status.HTTP_409_CONFLICT,
        ) from exc

    return origin, nonce
