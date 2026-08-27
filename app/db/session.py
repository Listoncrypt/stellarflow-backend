"""app/db/session.py — SQLAlchemy async session factory for StellarFlow.

Provides ``async_session_factory`` used by the ingestion layer
(``soroban_listener.py``) to persist ``LedgerEvent`` records.

Usage::

    from app.db.session import async_session_factory
    from app.models.events import LedgerEvent

    async with async_session_factory() as session:
        session.add(LedgerEvent(...))
        await session.commit()
"""

from __future__ import annotations

import os
from typing import Any, AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

_DATABASE_URL = (
    os.environ.get("DATABASE_URL") or "postgresql://localhost:5432/stellarflow"
)

# Connection pool configuration via environment variables with sane defaults
DB_POOL_SIZE = int(
    os.environ.get("DB_POOL_SIZE") or os.environ.get("DATABASE_POOL_SIZE") or "10"
)
DB_MAX_OVERFLOW = int(
    os.environ.get("DB_MAX_OVERFLOW") or os.environ.get("DATABASE_MAX_OVERFLOW") or "20"
)
DB_POOL_RECYCLE = int(
    os.environ.get("DB_POOL_RECYCLE") or os.environ.get("DATABASE_POOL_RECYCLE") or "1800"
)
DB_POOL_TIMEOUT = int(
    os.environ.get("DB_POOL_TIMEOUT") or os.environ.get("DATABASE_POOL_TIMEOUT") or "30"
)

_pre_ping_env = (
    os.environ.get("DB_POOL_PRE_PING")
    or os.environ.get("DATABASE_POOL_PRE_PING")
    or "true"
).strip().lower()
DB_POOL_PRE_PING = _pre_ping_env in ("true", "1", "t", "yes")



# Normalise a plain postgresql:// URL to the asyncpg+psycopg driver prefix
# that SQLAlchemy expects for async operations.
async_url = _DATABASE_URL
if async_url.startswith("postgresql://"):
    async_url = async_url.replace("postgresql://", "postgresql+asyncpg://", 1)
elif async_url.startswith("postgres://"):
    async_url = async_url.replace("postgres://", "postgresql+asyncpg://", 1)


def _register_pool_events(target_engine: AsyncEngine) -> None:
    """Attach SQLAlchemy event listeners to track Prometheus pool metrics."""
    from sqlalchemy import event
    from app.db.health import (
        DB_POOL_ACTIVE_CONNECTIONS,
        DB_POOL_CHECKINS_TOTAL,
        DB_POOL_CHECKOUTS_TOTAL,
        DB_POOL_INVALIDATIONS_TOTAL,
    )

    pool = target_engine.pool

    @event.listens_for(pool, "checkout")
    def _on_checkout(dbapi_connection, connection_record, connection_proxy):
        DB_POOL_CHECKOUTS_TOTAL.inc()
        if callable(getattr(pool, "checkedout", None)):
            DB_POOL_ACTIVE_CONNECTIONS.set(pool.checkedout())

    @event.listens_for(pool, "checkin")
    def _on_checkin(dbapi_connection, connection_record):
        DB_POOL_CHECKINS_TOTAL.inc()
        if callable(getattr(pool, "checkedout", None)):
            DB_POOL_ACTIVE_CONNECTIONS.set(pool.checkedout())

    @event.listens_for(pool, "invalidate")
    def _on_invalidate(dbapi_connection, connection_record, exception):
        DB_POOL_INVALIDATIONS_TOTAL.inc()


def create_custom_engine(
    database_url: str | None = None,
    pool_size: int | None = None,
    max_overflow: int | None = None,
    pool_recycle: int | None = None,
    pool_timeout: int | None = None,
    pool_pre_ping: bool | None = None,
    echo: bool = False,
) -> AsyncEngine:
    """Factory to build an AsyncEngine with configurable pool parameters."""
    if database_url is not None:
        url = database_url
    else:
        url = os.environ.get("DATABASE_URL") or _DATABASE_URL

    if not url:
        raise RuntimeError(
            "DATABASE_URL environment variable is not set. "
            "Required by app.db.session for engine initialization."
        )



    target_url = url
    if target_url.startswith("postgresql://"):
        target_url = target_url.replace("postgresql://", "postgresql+asyncpg://", 1)
    elif target_url.startswith("postgres://"):
        target_url = target_url.replace("postgres://", "postgresql+asyncpg://", 1)

    ps = pool_size if pool_size is not None else DB_POOL_SIZE
    mo = max_overflow if max_overflow is not None else DB_MAX_OVERFLOW
    pr = pool_recycle if pool_recycle is not None else DB_POOL_RECYCLE
    pt = pool_timeout if pool_timeout is not None else DB_POOL_TIMEOUT
    pp = pool_pre_ping if pool_pre_ping is not None else DB_POOL_PRE_PING

    engine_kwargs: dict[str, Any] = {
        "pool_size": ps,
        "max_overflow": mo,
        "pool_recycle": pr,
        "pool_timeout": pt,
        "pool_pre_ping": pp,
        "echo": echo,
    }

    if "sqlite" in target_url:
        engine_kwargs.pop("pool_size", None)
        engine_kwargs.pop("max_overflow", None)
        engine_kwargs.pop("pool_recycle", None)
        engine_kwargs.pop("pool_timeout", None)

    engine = create_async_engine(target_url, **engine_kwargs)
    _register_pool_events(engine)
    return engine


_engine = create_custom_engine()

async_session_factory = async_sessionmaker(
    bind=_engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def get_async_session() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency that yields an ``AsyncSession`` and closes it after use."""
    async with async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()

