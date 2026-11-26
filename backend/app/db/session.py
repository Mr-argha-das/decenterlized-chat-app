from collections.abc import AsyncGenerator
from typing import Any

from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import get_settings


def build_async_engine(database_url: str | None = None) -> AsyncEngine:
    url = database_url or get_settings().DATABASE_URL
    kwargs: dict[str, Any] = {"future": True}

    if url.startswith("mysql"):
        kwargs["pool_pre_ping"] = True
        kwargs["pool_recycle"] = 1800
        kwargs["pool_size"] = 10
        kwargs["max_overflow"] = 20

    engine = create_async_engine(url, **kwargs)

    if url.startswith("sqlite"):
        @event.listens_for(engine.sync_engine, "connect")
        def _set_sqlite_pragma(dbapi_conn: Any, _conn_record: Any) -> None:
            cursor = dbapi_conn.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    return engine


engine: AsyncEngine = build_async_engine()
AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)


async def get_db_session() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        yield session
