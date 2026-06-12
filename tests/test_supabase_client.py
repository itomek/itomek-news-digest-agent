"""Tests for src/news_digest/supabase_client.py — shared cached Supabase client.

The scheduler daemon runs 24/7 (~96 ticks/day, several log() calls per tick);
building a fresh client — and a fresh httpx connection pool — per call leaks
idle sockets over weeks. These tests lock the single-pool guarantee: one
create_client per settings, reuse across modules, a resettable cache, and no
caching of construction failures.
"""

from unittest.mock import MagicMock

import pytest

from news_digest import supabase_client
from news_digest.config import get_settings


@pytest.fixture
def counted_create(monkeypatch):
    """Replace create_client with a counting fake returning distinct mocks."""
    calls = {"count": 0}

    def fake_create_client(url, key):
        calls["count"] += 1
        return MagicMock(name=f"client-{calls['count']}")

    monkeypatch.setattr(supabase_client, "create_client", fake_create_client)
    return calls


def test_get_client_reuses_one_client(valid_env, counted_create):
    first = supabase_client.get_client()
    second = supabase_client.get_client()
    assert first is second
    assert counted_create["count"] == 1


def test_cache_clear_builds_fresh_client(valid_env, counted_create):
    first = supabase_client.get_client()
    supabase_client.cache_clear()
    second = supabase_client.get_client()
    assert first is not second
    assert counted_create["count"] == 2


def test_client_rebuilt_when_settings_change(valid_env, counted_create, monkeypatch):
    """The cache is keyed on settings values: a rotated key yields a new client
    without an explicit cache_clear()."""
    first = supabase_client.get_client()
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "rotated-key")
    get_settings.cache_clear()
    second = supabase_client.get_client()
    assert first is not second
    assert counted_create["count"] == 2


def test_construction_failure_is_not_cached(valid_env, monkeypatch):
    """A transient create_client failure must not poison the cache —
    lru_cache does not memoise exceptions, so the next call retries."""
    attempts = {"count": 0}

    def flaky_create_client(url, key):
        attempts["count"] += 1
        if attempts["count"] == 1:
            raise RuntimeError("transient construction failure")
        return MagicMock()

    monkeypatch.setattr(supabase_client, "create_client", flaky_create_client)

    with pytest.raises(RuntimeError):
        supabase_client.get_client()
    client = supabase_client.get_client()
    assert client is supabase_client.get_client()
    assert attempts["count"] == 2


def test_all_call_sites_share_one_client(
    valid_env, counted_create, monkeypatch, tmp_path
):
    """log(), the publishing tools, and the scheduler must all ride the same
    pooled client — exactly one create_client for the whole process."""
    from news_digest import logging as nd_logging
    from news_digest import scheduler
    from news_digest.tools import publishing

    monkeypatch.setenv("FALLBACK_LOG_PATH", str(tmp_path / "fallback.sqlite"))

    nd_logging.log("info", "system", "first")
    nd_logging.log("info", "system", "second")
    shared = supabase_client.get_client()
    assert publishing._client() is shared
    assert scheduler._client() is shared
    assert counted_create["count"] == 1
