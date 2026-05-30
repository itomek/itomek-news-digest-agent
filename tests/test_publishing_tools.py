"""Tests for src/news_digest/tools/publishing.py — issue #8.

These use a lightweight fake Supabase client. Per the project's testing policy
the real pass gate is the live-Supabase integration run on the host; these
mocked tests lock the logic (cache, upsert payload, None-handling, graceful
failure) and are tracked against the real-world result.
"""

from datetime import UTC, datetime
from unittest.mock import MagicMock

import pytest

from news_digest.tools import publishing
from news_digest.tools.publishing import (
    fetch_topic_config,
    get_last_digest_date,
    push_to_supabase,
)


class FakeResp:
    def __init__(self, data):
        self.data = data


class FakeTable:
    """Minimal supabase-py fluent table stub driven by a shared state dict."""

    def __init__(self, name, state):
        self.name = name
        self.state = state
        self._filters = []
        self._order = None
        self._limit = None
        self._mode = "select"
        self._payload = None

    def select(self, *a, **k):
        self._mode = "select"
        return self

    def insert(self, row, **k):
        self._mode, self._payload = "insert", row
        return self

    def upsert(self, row, on_conflict=None, **k):
        self._mode, self._payload = "upsert", row
        self.state.setdefault("upserts", []).append(
            {"table": self.name, "row": row, "on_conflict": on_conflict}
        )
        return self

    def eq(self, col, val):
        self._filters.append((col, val))
        return self

    def order(self, col, desc=False):
        self._order = (col, desc)
        return self

    def limit(self, n):
        self._limit = n
        return self

    def execute(self):
        if self.state.get("raise"):
            raise self.state["raise"]
        if self._mode in ("upsert", "insert"):
            returned = dict(self._payload)
            returned.setdefault("id", "fake-uuid-123")
            return FakeResp([returned])
        rows = [
            r
            for r in self.state.get("rows", {}).get(self.name, [])
            if all(r.get(c) == v for c, v in self._filters)
        ]
        if self._order:
            col, desc = self._order
            rows = sorted(rows, key=lambda r: r.get(col) or "", reverse=desc)
        if self._limit is not None:
            rows = rows[: self._limit]
        return FakeResp(rows)


class FakeClient:
    def __init__(self, state):
        self.state = state

    def table(self, name):
        return FakeTable(name, self.state)


@pytest.fixture(autouse=True)
def _silence_log(monkeypatch):
    monkeypatch.setattr(publishing, "log", MagicMock())


@pytest.fixture(autouse=True)
def _clear_cache():
    publishing._config_cache.clear()
    yield
    publishing._config_cache.clear()


def _install_client(monkeypatch, state):
    calls = {"count": 0}

    def _fake_client(write=False):
        calls["count"] += 1
        return FakeClient(state)

    monkeypatch.setattr(publishing, "_client", _fake_client)
    return calls


# ---------------------------------------------------------------------------
# fetch_topic_config
# ---------------------------------------------------------------------------


def test_fetch_topic_config_returns_row(monkeypatch):
    state = {
        "rows": {
            "digest_topics": [
                {
                    "slug": "ai_models",
                    "cadence": "24h",
                    "prompt_hint": "x",
                    "enabled": True,
                }
            ]
        }
    }
    _install_client(monkeypatch, state)
    cfg = fetch_topic_config("ai_models")
    assert cfg["slug"] == "ai_models"
    assert cfg["cadence"] == "24h"


def test_fetch_topic_config_caches_within_ttl(monkeypatch):
    state = {"rows": {"digest_topics": [{"slug": "ai_models", "cadence": "24h"}]}}
    calls = _install_client(monkeypatch, state)
    fetch_topic_config("ai_models")
    fetch_topic_config("ai_models")
    assert calls["count"] == 1  # second served from cache


def test_fetch_topic_config_refetches_after_ttl(monkeypatch):
    state = {"rows": {"digest_topics": [{"slug": "ai_models", "cadence": "24h"}]}}
    calls = _install_client(monkeypatch, state)
    clock = [1000.0]
    monkeypatch.setattr(publishing, "_now", lambda: clock[0])
    fetch_topic_config("ai_models")
    clock[0] += 301  # past the 300s TTL
    fetch_topic_config("ai_models")
    assert calls["count"] == 2


def test_fetch_topic_config_missing_returns_error_without_raising(monkeypatch):
    _install_client(monkeypatch, {"rows": {"digest_topics": []}})
    cfg = fetch_topic_config("nope")
    assert "error" in cfg


def test_fetch_topic_config_handles_exception_without_raising(monkeypatch):
    _install_client(monkeypatch, {"raise": RuntimeError("db down")})
    cfg = fetch_topic_config("ai_models")
    assert "error" in cfg


# ---------------------------------------------------------------------------
# push_to_supabase
# ---------------------------------------------------------------------------


def test_push_to_supabase_upserts_expected_row_and_returns_id(monkeypatch):
    state = {"rows": {"digest_topics": [{"slug": "ai_models", "cadence": "24h"}]}}
    _install_client(monkeypatch, state)
    result = push_to_supabase("ai_models", "Hello digest", ["https://a"], 123)

    assert result["success"] is True
    assert result["id"] == "fake-uuid-123"

    up = state["upserts"][-1]
    assert up["table"] == "digests"
    assert up["on_conflict"] == "topic_slug,digest_date"
    row = up["row"]
    assert row["topic_slug"] == "ai_models"
    assert row["content"] == "Hello digest"
    assert row["sources_used"] == ["https://a"]
    assert row["token_count"] == 123
    assert row["cadence"] == "24h"  # sourced from topic config
    assert row["prompt_version"] == publishing.PROMPT_VERSION
    assert row["digest_date"] == datetime.now(UTC).date().isoformat()


def test_push_to_supabase_unknown_topic_returns_failure(monkeypatch):
    _install_client(monkeypatch, {"rows": {"digest_topics": []}})
    result = push_to_supabase("ghost", "x", [], 0)
    assert result["success"] is False
    assert "error" in result


def test_push_to_supabase_handles_db_failure_gracefully(monkeypatch):
    # Pre-seed the config cache so the only live call is the failing upsert.
    publishing._config_cache["ai_models"] = (
        publishing._now(),
        {"slug": "ai_models", "cadence": "24h"},
    )
    _install_client(monkeypatch, {"raise": RuntimeError("db down")})
    result = push_to_supabase("ai_models", "x", [], 0)
    assert result["success"] is False
    assert "error" in result


# ---------------------------------------------------------------------------
# get_last_digest_date
# ---------------------------------------------------------------------------


def test_get_last_digest_date_none_when_no_prior_digest(monkeypatch):
    _install_client(monkeypatch, {"rows": {"digests": []}})
    assert get_last_digest_date("ai_models")["last_date"] is None


def test_get_last_digest_date_returns_latest(monkeypatch):
    state = {
        "rows": {
            "digests": [
                {"topic_slug": "ai_models", "digest_date": "2026-05-01"},
                {"topic_slug": "ai_models", "digest_date": "2026-05-29"},
                {"topic_slug": "other", "digest_date": "2026-05-30"},
            ]
        }
    }
    _install_client(monkeypatch, state)
    assert get_last_digest_date("ai_models")["last_date"] == "2026-05-29"


def test_get_last_digest_date_handles_failure_gracefully(monkeypatch):
    _install_client(monkeypatch, {"raise": RuntimeError("db down")})
    out = get_last_digest_date("ai_models")
    assert out["last_date"] is None
