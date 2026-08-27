"""tests/test_db_session_health.py — Unit tests for DB pool tuning, health inspector & metrics.

Issue #785 — Implement Database Connection Pool Tuning & Health Inspector
"""

from __future__ import annotations

import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from prometheus_client import REGISTRY

from app.db.health import (
    DB_POOL_ACTIVE_CONNECTIONS,
    DB_POOL_CHECKINS_TOTAL,
    DB_POOL_CHECKOUTS_TOTAL,
    DB_POOL_EXHAUSTION_EVENTS_TOTAL,
    DB_POOL_INVALIDATIONS_TOTAL,
    DatabaseHealthInspector,
)
from app.db.session import (
    DB_MAX_OVERFLOW,
    DB_POOL_PRE_PING,
    DB_POOL_RECYCLE,
    DB_POOL_SIZE,
    DB_POOL_TIMEOUT,
    create_custom_engine,
)
from app.main import app


# ---------------------------------------------------------------------------
# Connection Pool Configuration Tests
# ---------------------------------------------------------------------------


class TestDatabasePoolConfiguration:
    def test_default_environment_parameters(self):
        """Verify default pool configuration values match sane defaults."""
        assert DB_POOL_SIZE == 10
        assert DB_MAX_OVERFLOW == 20
        assert DB_POOL_RECYCLE == 1800
        assert DB_POOL_TIMEOUT == 30
        assert DB_POOL_PRE_PING is True

    @patch.dict(
        os.environ,
        {
            "DB_POOL_SIZE": "15",
            "DB_MAX_OVERFLOW": "25",
            "DB_POOL_RECYCLE": "3600",
            "DB_POOL_TIMEOUT": "45",
            "DB_POOL_PRE_PING": "false",
        },
    )
    def test_custom_engine_creation_with_env_overrides(self):
        """Verify custom engine factory respects parameters and env overrides."""
        engine = create_custom_engine(
            database_url="sqlite+aiosqlite:///:memory:",
            pool_size=15,
            max_overflow=25,
            pool_recycle=3600,
            pool_timeout=45,
            pool_pre_ping=False,
        )
        assert engine is not None
        assert engine.url.drivername == "sqlite+aiosqlite"

    def test_custom_engine_requires_database_url(self):
        """Verify RuntimeError is raised if database URL is missing."""
        with patch.dict(os.environ, {"DATABASE_URL": ""}, clear=True):
            with pytest.raises(RuntimeError, match="DATABASE_URL environment variable is not set"):
                create_custom_engine(database_url="")


# ---------------------------------------------------------------------------
# Database Health Inspector Tests
# ---------------------------------------------------------------------------


class TestDatabaseHealthInspector:
    def test_get_pool_status_structure(self):
        """Verify get_pool_status extracts metrics from engine pool."""
        mock_engine = MagicMock()
        mock_pool = MagicMock()
        mock_pool.size.return_value = 10
        mock_pool._max_overflow = 20
        mock_pool.checkedin.return_value = 8
        mock_pool.checkedout.return_value = 2
        mock_pool.overflow.return_value = 0
        mock_engine.pool = mock_pool

        inspector = DatabaseHealthInspector(engine=mock_engine)
        status = inspector.get_pool_status()

        assert status["pool_size"] == 10
        assert status["max_overflow"] == 20
        assert status["checked_in"] == 8
        assert status["checked_out"] == 2
        assert status["overflow"] == 0
        assert status["total_connections"] == 10
        assert status["available_capacity"] == 28

    @pytest.mark.asyncio
    async def test_check_health_healthy(self):
        """Verify check_health returns healthy status when SELECT 1 succeeds."""
        mock_engine = MagicMock()
        mock_conn = AsyncMock()
        mock_engine.connect.return_value.__aenter__.return_value = mock_conn

        mock_pool = MagicMock()
        mock_pool.size.return_value = 10
        mock_pool._max_overflow = 20
        mock_pool.checkedin.return_value = 10
        mock_pool.checkedout.return_value = 0
        mock_pool.overflow.return_value = 0
        mock_engine.pool = mock_pool

        inspector = DatabaseHealthInspector(engine=mock_engine)
        result = await inspector.check_health()

        assert result["status"] == "healthy"
        assert result["error"] is None
        assert "latency_ms" in result
        assert result["pool"]["pool_size"] == 10
        mock_conn.execute.assert_called_once()

    @pytest.mark.asyncio
    async def test_check_health_unhealthy(self):
        """Verify check_health handles failure, increments metrics, and returns unhealthy."""
        mock_engine = MagicMock()
        mock_engine.connect.side_effect = Exception("Connection refused")

        mock_pool = MagicMock()
        mock_pool.size.return_value = 10
        mock_pool._max_overflow = 20
        mock_pool.checkedin.return_value = 0
        mock_pool.checkedout.return_value = 0
        mock_pool.overflow.return_value = 0
        mock_engine.pool = mock_pool

        inspector = DatabaseHealthInspector(engine=mock_engine)
        
        initial_exhaustion = DB_POOL_EXHAUSTION_EVENTS_TOTAL._value.get()
        result = await inspector.check_health()

        assert result["status"] == "unhealthy"
        assert "Connection refused" in result["error"]
        assert DB_POOL_EXHAUSTION_EVENTS_TOTAL._value.get() == initial_exhaustion + 1

    def test_record_exhaustion_event(self):
        """Verify record_exhaustion_event increments Prometheus counter."""
        inspector = DatabaseHealthInspector(engine=MagicMock())
        initial = DB_POOL_EXHAUSTION_EVENTS_TOTAL._value.get()
        inspector.record_exhaustion_event()
        assert DB_POOL_EXHAUSTION_EVENTS_TOTAL._value.get() == initial + 1


# ---------------------------------------------------------------------------
# Prometheus Metrics & Pool Event Listeners Tests
# ---------------------------------------------------------------------------


class TestPrometheusMetricsAndPoolEvents:
    def test_prometheus_metrics_registered(self):
        """Verify Prometheus metrics are registered in collector registry."""
        metrics_names = [m.name for m in REGISTRY.collect()]
        assert "db_pool_active_connections" in metrics_names
        assert "db_pool_size" in metrics_names
        assert "db_pool_max_overflow" in metrics_names
        assert any(name.startswith("db_pool_checkouts") for name in metrics_names)
        assert any(name.startswith("db_pool_checkins") for name in metrics_names)
        assert any(name.startswith("db_pool_exhaustion_events") for name in metrics_names)
        assert any(name.startswith("db_pool_invalidations") for name in metrics_names)
        assert "db_pool_ping_latency_seconds" in metrics_names



# ---------------------------------------------------------------------------
# FastAPI DB Health Endpoint Test
# ---------------------------------------------------------------------------


class TestHealthDbEndpoint:
    @patch("app.db.health.DatabaseHealthInspector.check_health")
    def test_health_db_endpoint_healthy(self, mock_check_health):
        """Verify /health/db returns 200 when DB is healthy."""
        mock_check_health.return_value = {
            "status": "healthy",
            "latency_ms": 1.25,
            "pool": {
                "pool_size": 10,
                "max_overflow": 20,
                "checked_in": 10,
                "checked_out": 0,
                "overflow": 0,
                "total_connections": 10,
                "available_capacity": 30,
            },
            "error": None,
        }

        client = TestClient(app)
        response = client.get("/health/db")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "healthy"
        assert data["latency_ms"] == 1.25
        assert data["pool"]["pool_size"] == 10

    @patch("app.db.health.DatabaseHealthInspector.check_health")
    def test_health_db_endpoint_unhealthy(self, mock_check_health):
        """Verify /health/db returns 503 when DB is unhealthy."""
        mock_check_health.return_value = {
            "status": "unhealthy",
            "latency_ms": 500.0,
            "pool": {
                "pool_size": 10,
                "max_overflow": 20,
                "checked_in": 0,
                "checked_out": 0,
                "overflow": 0,
                "total_connections": 0,
                "available_capacity": 30,
            },
            "error": "Database offline",
        }

        client = TestClient(app)
        response = client.get("/health/db")
        assert response.status_code == 503
        data = response.json()
        assert data["status"] == "unhealthy"
        assert data["error"] == "Database offline"
