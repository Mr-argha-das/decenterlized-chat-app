"""
Clean Phase 4 -> Phase 8 Federation Lookup Hook.
Resolves `username@domain`:
- If `domain == settings.APP_DOMAIN`: looks up the user locally in `users`.
- If `domain != settings.APP_DOMAIN`: checks cached remote `User` rows first, then delegates to
  the registered async federation resolver hook (ready for Phase 8 `/.well-known/user/{username}`).
"""
import re
from collections.abc import Awaitable, Callable

from fastapi import status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import AppError
from app.models.entities import User

DOMAIN_REGEX = re.compile(r"^[a-z0-9.-]+(?::\d{1,5})?$")
LOCALPART_REGEX = re.compile(r"^[a-z0-9_.]{3,20}$")

FederationResolverFn = Callable[[AsyncSession, str, str], Awaitable[User | None]]
_custom_federation_resolver: FederationResolverFn | None = None


def register_federation_resolver(resolver: FederationResolverFn | None) -> None:
    """Allows Phase 8 (or tests) to register a remote `/.well-known/user/{username}` resolver."""
    global _custom_federation_resolver
    _custom_federation_resolver = resolver


def parse_user_identifier(raw_identifier: str) -> tuple[str, str]:
    settings = get_settings()
    cleaned = raw_identifier.strip().lower()
    for prefix in ("relaychat://", "relaychat:", "web+relaychat://", "web+relaychat:"):
        if cleaned.startswith(prefix):
            cleaned = cleaned[len(prefix) :].strip("/")
            break

    if "@" in cleaned:
        parts = cleaned.split("@")
        if len(parts) != 2 or not parts[0] or not parts[1]:
            raise AppError(
                "INVALID_IDENTIFIER",
                "Identifier must be in `username@domain` format.",
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        username, domain = parts[0], parts[1]
    else:
        username, domain = cleaned, settings.APP_DOMAIN.lower()

    if not LOCALPART_REGEX.match(username):
        raise AppError(
            "INVALID_IDENTIFIER",
            "Username part must be 3-20 characters (`a-z`, `0-9`, `_`, `.`).",
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    if not DOMAIN_REGEX.match(domain):
        raise AppError(
            "INVALID_IDENTIFIER",
            "Domain part is not valid.",
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    return username, domain


async def resolve_user_by_identifier(
    db: AsyncSession,
    raw_identifier: str,
) -> User:
    settings = get_settings()
    username, domain = parse_user_identifier(raw_identifier)
    local_domain = settings.APP_DOMAIN.lower()

    # 1. Local node lookup
    if domain == local_domain:
        res = await db.execute(
            select(User).where(
                User.username == username,
                User.domain == local_domain,
            )
        )
        local_user = res.scalar_one_or_none()
        if not local_user:
            raise AppError(
                "USER_NOT_FOUND",
                f"No user '{username}@{local_domain}' exists on this node.",
                status_code=status.HTTP_404_NOT_FOUND,
            )
        return local_user

    # 2. Remote domain: check cached federated actors first
    cached_res = await db.execute(
        select(User).where(User.username == username, User.domain == domain)
    )
    cached_remote = cached_res.scalar_one_or_none()
    if cached_remote:
        return cached_remote

    # 3. Delegate to Phase 8 federation discovery hook
    if _custom_federation_resolver is not None:
        resolved = await _custom_federation_resolver(db, username, domain)
        if resolved:
            return resolved

    raise AppError(
        "FEDERATION_PENDING_PHASE8",
        f"'{username}@{domain}' is on an external node (`{domain}`). Cross-node federation lookup activates in Phase 8.",
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
    )
