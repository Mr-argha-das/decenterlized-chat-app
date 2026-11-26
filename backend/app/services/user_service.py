from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.entities import User
from app.schemas.user import USERNAME_REGEX, UsernameCheckOut


async def check_username_availability(db: AsyncSession, raw_username: str) -> UsernameCheckOut:
    settings = get_settings()
    candidate = raw_username.strip().lower()
    full_id = f"{candidate}@{settings.APP_DOMAIN}"

    if not USERNAME_REGEX.fullmatch(candidate):
        return UsernameCheckOut(
            username=candidate,
            id=full_id,
            valid=False,
            available=False,
            reason="Username must be 3–20 characters using only a-z, 0-9, '_' or '.'.",
        )

    existing = await db.execute(
        select(User.id).where(
            (User.global_id == full_id)
            | ((User.username == candidate) & (User.domain == settings.APP_DOMAIN))
        )
    )
    if existing.scalar_one_or_none() is not None:
        return UsernameCheckOut(
            username=candidate,
            id=full_id,
            valid=True,
            available=False,
            reason=f"'{candidate}@{settings.APP_DOMAIN}' is already taken.",
        )

    return UsernameCheckOut(
        username=candidate,
        id=full_id,
        valid=True,
        available=True,
        reason=None,
    )
