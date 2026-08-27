"""app/db/health.py — SQLAlchemy database connection pool health inspector & metrics.

Issue #785 — Implement Database Connection Pool Tuning & Health Inspector

Provides ``DatabaseHealthInspector`` and Prometheus pool metrics for observing
and verifying database connectivity, pool utilization, and heartbeat health.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, Optional

from prometheus_client import Counter, Gauge
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Prometheus Metrics Configuration
# ---------------------------------------------------------------------------

DB_POOL_ACTIVE_CONNECTIONS = Gauge(
    "db_pool_active_connections",
    "Number of currently active/checked-out DB connections",
)

DB_POOL_SIZE_GAUGE = Gauge(
    "db_pool_size",
    "Configured size of the SQLAlchemy connection pool",
)

DB_POOL_MAX_OVERFLOW_GAUGE = Gauge(
    "db_pool_max_overflow",
    "Configured max overflow of the SQLAlchemy connection pool",
)

DB_POOL_CHECKOUTS_TOTAL = Counter(
    "db_pool_checkouts_total",
    "Total number of DB pool connection checkouts",
)

DB_POOL_CHECKINS_TOTAL = Counter(
    "db_pool_checkins_total",
    "Total number of DB pool connection checkins",
)

DB_POOL_EXHAUSTION_EVENTS_TOTAL = Counter(
    "db_pool_exhaustion_events_total",
    "Total number of DB pool exhaustion or checkout timeout events",
)

DB_POOL_INVALIDATIONS_TOTAL = Counter(
    "db_pool_invalidations_total",
    "Total number of DB pool connection invalidation events",
)

DB_POOL_PING_LATENCY_SECONDS = Gauge(
    "db_pool_ping_latency_seconds",
    "Database health check ping round-trip latency in seconds",
)


# ---------------------------------------------------------------------------
# Database Health Inspector
# ---------------------------------------------------------------------------


class DatabaseHealthInspector:
    """Inspector for SQLAlchemy async database engine pool state and health.

    Executes checkout heartbeats (``SELECT 1``) and updates Prometheus pool metrics.
    """

    def __init__(self, engine: Optional[AsyncEngine] = None) -> None:
        self._engine = engine

    @property
    def engine(self) -> AsyncEngine:
        if self._engine is None:
            from app.db.session import _engine
            self._engine = _engine
        return self._engine

    def get_pool_status(self) -> Dict[str, Any]:
        """Inspect the engine connection pool metrics and update Prometheus gauges."""
        pool = self.engine.pool

        pool_size = getattr(pool, "size", lambda: 0)() if callable(getattr(pool, "size", None)) else getattr(pool, "_pool_size", 0)
        max_overflow = getattr(pool, "_max_overflow", 0)
        
        checked_in = getattr(pool, "checkedin", lambda: 0)() if callable(getattr(pool, "checkedin", None)) else 0
        checked_out = getattr(pool, "checkedout", lambda: 0)() if callable(getattr(pool, "checkedout", None)) else 0
        overflow = getattr(pool, "overflow", lambda: 0)() if callable(getattr(pool, "overflow", None)) else 0

        # Update Prometheus gauges
        DB_POOL_ACTIVE_CONNECTIONS.set(checked_out)
        DB_POOL_SIZE_GAUGE.set(pool_size)
        DB_POOL_MAX_OVERFLOW_GAUGE.set(max_overflow)

        total_connections = checked_in + checked_out
        available_capacity = max(0, (pool_size + max_overflow) - checked_out)

        return {
            "pool_size": pool_size,
            "max_overflow": max_overflow,
            "checked_in": checked_in,
            "checked_out": checked_out,
            "overflow": overflow,
            "total_connections": total_connections,
            "available_capacity": available_capacity,
        }

    async def check_health(self) -> Dict[str, Any]:
        """Perform a connection checkout heartbeat probe (`SELECT 1`).

        Returns status dictionary containing health, round-trip latency in ms,
        and current pool status metrics.
        """
        start_time = time.monotonic()
        pool_status = self.get_pool_status()
        
        try:
            async with self.engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
            
            elapsed_s = time.monotonic() - start_time
            latency_ms = round(elapsed_s * 1000.0, 2)
            DB_POOL_PING_LATENCY_SECONDS.set(elapsed_s)

            return {
                "status": "healthy",
                "latency_ms": latency_ms,
                "pool": pool_status,
                "error": None,
            }
        except Exception as exc:
            elapsed_s = time.monotonic() - start_time
            latency_ms = round(elapsed_s * 1000.0, 2)
            logger.warning("Database health check failed: %s", exc)
            
            DB_POOL_EXHAUSTION_EVENTS_TOTAL.inc()
            
            return {
                "status": "unhealthy",
                "latency_ms": latency_ms,
                "pool": pool_status,
                "error": str(exc),
            }

    def record_exhaustion_event(self) -> None:
        """Increment pool exhaustion counter."""
        DB_POOL_EXHAUSTION_EVENTS_TOTAL.inc()
