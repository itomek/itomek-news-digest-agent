"""Tests for src/news_digest/tools/publishing.py — issue #8, #58, #102.

These use a lightweight fake Supabase client. Per the project's testing policy
the real pass gate is the live-Supabase integration run on the host; these
mocked tests lock the logic (cache, upsert payload, None-handling, graceful
failure) and are tracked against the real-world result.
"""

from datetime import date
from unittest.mock import MagicMock

import pytest

from news_digest.tools import publishing
from news_digest.tools.publishing import (
    fetch_topic_config,
    get_last_digest_date,
    get_recent_digests,
    list_topics,
    push_to_supabase,
)

# Fixed Eastern date used across push_to_supabase tests (issue #102).
_FAKE_TODAY = date(2026, 6, 15)


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


@pytest.fixture(autouse=True)
def _patch_app_today(monkeypatch):
    """Freeze app_today() to _FAKE_TODAY for all publishing tests (issue #102).

    Prevents push_to_supabase from calling get_settings() which requires
    Supabase env vars in the hermetic test environment, and makes the
    digest_date assertions deterministic.
    """
    monkeypatch.setattr(publishing, "app_today", lambda: _FAKE_TODAY)


def _install_client(monkeypatch, state):
    calls = {"count": 0}

    def _fake_client():
        calls["count"] += 1
        return FakeClient(state)

    monkeypatch.setattr(publishing, "_client", _fake_client)
    return calls


# ---------------------------------------------------------------------------
# _client — agent authenticates as service_role (issue #60)
# ---------------------------------------------------------------------------


def test_client_authenticates_as_service_role(monkeypatch):
    """The agent is a trusted backend and authenticates as service_role for ALL
    Supabase access, reads included. Anon reads return zero rows since read
    policies moved to the `authenticated` role (#57 / migration 0006)."""
    from news_digest import supabase_client

    captured = {}

    def fake_create_client(url, key):
        captured["url"] = url
        captured["key"] = key
        return MagicMock()

    settings = MagicMock(
        supabase_url="https://x.supabase.co",
        supabase_service_key="SERVICE_KEY",
        supabase_anon_key="ANON_KEY",
    )
    monkeypatch.setattr(supabase_client, "create_client", fake_create_client)
    monkeypatch.setattr(supabase_client, "get_settings", lambda: settings)

    publishing._client()

    assert captured["url"] == "https://x.supabase.co"
    assert captured["key"] == "SERVICE_KEY"  # never the anon key


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
# push_to_supabase — issue #58: structured output (summary + items + derived content)
# ---------------------------------------------------------------------------

_SAMPLE_ITEMS = [
    {
        "headline": "AI Corp ships Model X",
        "blurb": "A new frontier model. Beats previous baselines.",
        "detail": "Scores 95 on MMLU. Six months of training.",
        "metadata": {"sources": [{"title": "Blog", "url": "https://example.com"}]},
    }
]


def test_push_to_supabase_upserts_expected_row_and_returns_id(monkeypatch):
    state = {"rows": {"digest_topics": [{"slug": "ai_models", "cadence": "24h"}]}}
    _install_client(monkeypatch, state)
    result = push_to_supabase(
        "ai_models",
        summary="Top AI news today.",
        items=_SAMPLE_ITEMS,
        sources_used=["https://example.com"],
        token_count=123,
    )

    assert result["success"] is True
    assert result["id"] == "fake-uuid-123"

    up = state["upserts"][-1]
    assert up["table"] == "digests"
    assert up["on_conflict"] == "topic_slug,digest_date"
    row = up["row"]
    assert row["topic_slug"] == "ai_models"
    assert row["summary"] == "Top AI news today."
    assert row["items"] == _SAMPLE_ITEMS
    # content is derived, not empty, and contains no raw URLs
    assert isinstance(row["content"], str) and len(row["content"]) > 0
    assert "http" not in row["content"]
    assert row["sources_used"] == ["https://example.com"]
    assert row["token_count"] == 123
    assert row["cadence"] == "24h"
    assert row["prompt_version"] == publishing.PROMPT_VERSION
    # digest_date uses the Eastern-canonical date (issue #102), frozen to _FAKE_TODAY
    assert row["digest_date"] == _FAKE_TODAY.isoformat()


def test_push_to_supabase_explicit_content_is_honored(monkeypatch):
    state = {"rows": {"digest_topics": [{"slug": "ai_models", "cadence": "24h"}]}}
    _install_client(monkeypatch, state)
    result = push_to_supabase(
        "ai_models",
        summary="Summary here.",
        items=_SAMPLE_ITEMS,
        sources_used=[],
        token_count=0,
        content="Explicitly provided content, no override.",
    )
    assert result["success"] is True
    row = state["upserts"][-1]["row"]
    assert row["content"] == "Explicitly provided content, no override."


def test_push_to_supabase_items_persisted_unchanged(monkeypatch):
    state = {"rows": {"digest_topics": [{"slug": "ai_models", "cadence": "24h"}]}}
    _install_client(monkeypatch, state)
    push_to_supabase(
        "ai_models",
        summary="S",
        items=_SAMPLE_ITEMS,
        sources_used=[],
        token_count=0,
    )
    row = state["upserts"][-1]["row"]
    assert row["items"] == _SAMPLE_ITEMS


def test_push_to_supabase_unknown_topic_returns_failure(monkeypatch):
    _install_client(monkeypatch, {"rows": {"digest_topics": []}})
    result = push_to_supabase(
        "ghost", summary="x", items=[], sources_used=[], token_count=0
    )
    assert result["success"] is False
    assert "error" in result


def test_push_to_supabase_handles_db_failure_gracefully(monkeypatch):
    # Pre-seed the config cache so the only live call is the failing upsert.
    publishing._config_cache["ai_models"] = (
        publishing._now(),
        {"slug": "ai_models", "cadence": "24h"},
    )
    _install_client(monkeypatch, {"raise": RuntimeError("db down")})
    result = push_to_supabase(
        "ai_models", summary="x", items=[], sources_used=[], token_count=0
    )
    assert result["success"] is False
    assert "error" in result


# ---------------------------------------------------------------------------
# push_to_supabase — Eastern date stamping (issue #102)
# ---------------------------------------------------------------------------


def test_push_stamps_eastern_date_not_utc(monkeypatch):
    """digest_date uses app_today() (Eastern), not datetime.now(UTC).date().

    The autouse _patch_app_today fixture freezes app_today() to _FAKE_TODAY
    (2026-06-15). We additionally patch it here to a different date to prove
    it is the sole source — the UTC date from the real clock is irrelevant.
    """
    eastern_date = date(2026, 3, 10)  # a specific Eastern date for the test
    monkeypatch.setattr(publishing, "app_today", lambda: eastern_date)

    state = {"rows": {"digest_topics": [{"slug": "ai_models", "cadence": "24h"}]}}
    _install_client(monkeypatch, state)

    result = push_to_supabase(
        "ai_models",
        summary="Test digest.",
        items=[],
        sources_used=[],
        token_count=0,
    )

    assert result["success"] is True
    row = state["upserts"][-1]["row"]
    assert row["digest_date"] == "2026-03-10", (
        "push_to_supabase must stamp the Eastern date from app_today(), "
        f"not the UTC date. Got: {row['digest_date']!r}"
    )


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


# ---------------------------------------------------------------------------
# list_topics
# ---------------------------------------------------------------------------


def test_list_topics_returns_enabled_topics_for_slug_discovery(monkeypatch):
    state = {
        "rows": {
            "digest_topics": [
                {
                    "slug": "ai_models",
                    "name": "AI model releases",
                    "cadence": "24h",
                    "enabled": True,
                },
            ]
        }
    }
    _install_client(monkeypatch, state)
    out = list_topics()
    assert "topics" in out
    by_slug = {t["slug"]: t for t in out["topics"]}
    assert "ai_models" in by_slug
    assert by_slug["ai_models"]["name"] == "AI model releases"


def test_list_topics_handles_failure_gracefully(monkeypatch):
    _install_client(monkeypatch, {"raise": RuntimeError("db down")})
    out = list_topics()
    assert out["topics"] == []
    assert "error" in out


# ---------------------------------------------------------------------------
# get_recent_digests — issue #16
# ---------------------------------------------------------------------------


def test_get_recent_digests_returns_most_recent_first_with_date_and_content(
    monkeypatch,
):
    state = {
        "rows": {
            "digests": [
                {
                    "topic_slug": "ai_models",
                    "digest_date": "2026-05-28",
                    "content": "older content",
                },
                {
                    "topic_slug": "ai_models",
                    "digest_date": "2026-05-30",
                    "content": "newer content",
                },
                {
                    "topic_slug": "other_topic",
                    "digest_date": "2026-05-31",
                    "content": "other content",
                },
            ]
        }
    }
    _install_client(monkeypatch, state)
    out = get_recent_digests("ai_models", limit=2)
    assert "digests" in out
    assert len(out["digests"]) == 2
    # most-recent-first
    assert out["digests"][0]["date"] == "2026-05-30"
    assert out["digests"][0]["content"] == "newer content"
    assert out["digests"][1]["date"] == "2026-05-28"
    assert out["digests"][1]["content"] == "older content"


def test_get_recent_digests_default_limit_returns_at_most_one(monkeypatch):
    state = {
        "rows": {
            "digests": [
                {
                    "topic_slug": "ai_models",
                    "digest_date": "2026-05-28",
                    "content": "older content",
                },
                {
                    "topic_slug": "ai_models",
                    "digest_date": "2026-05-30",
                    "content": "newer content",
                },
            ]
        }
    }
    _install_client(monkeypatch, state)
    out = get_recent_digests("ai_models")  # default limit=1
    assert len(out["digests"]) == 1
    assert out["digests"][0]["date"] == "2026-05-30"


def test_get_recent_digests_no_rows_returns_empty_list(monkeypatch):
    _install_client(monkeypatch, {"rows": {"digests": []}})
    out = get_recent_digests("ai_models")
    assert out == {"digests": []}


def test_get_recent_digests_handles_exception_without_raising(monkeypatch):
    _install_client(monkeypatch, {"raise": RuntimeError("db down")})
    out = get_recent_digests("ai_models")
    assert out["digests"] == []


# ---------------------------------------------------------------------------
# fetch_topic_config — disabled source filtering (issue #98)
# ---------------------------------------------------------------------------


def test_fetch_topic_config_filters_disabled_sources(monkeypatch):
    """enabled:false sources are filtered out of the returned sources list."""
    state = {
        "rows": {
            "digest_topics": [
                {
                    "slug": "ai_models",
                    "cadence": "24h",
                    "sources": [
                        {
                            "type": "rss",
                            "url": "https://enabled.example/feed",
                            "enabled": True,
                        },
                        {
                            "type": "rss",
                            "url": "https://disabled.example/feed",
                            "enabled": False,
                        },
                    ],
                }
            ]
        }
    }
    _install_client(monkeypatch, state)
    cfg = fetch_topic_config("ai_models")
    urls = [s["url"] for s in cfg["sources"]]
    assert "https://enabled.example/feed" in urls
    assert "https://disabled.example/feed" not in urls


def test_fetch_topic_config_keeps_sources_without_enabled_key(monkeypatch):
    """Sources without an 'enabled' key are treated as enabled (backward-compatible)."""
    state = {
        "rows": {
            "digest_topics": [
                {
                    "slug": "ai_models",
                    "cadence": "24h",
                    "sources": [
                        {"type": "rss", "url": "https://no-key.example/feed"},
                        {
                            "type": "rss",
                            "url": "https://explicit-true.example/feed",
                            "enabled": True,
                        },
                    ],
                }
            ]
        }
    }
    _install_client(monkeypatch, state)
    cfg = fetch_topic_config("ai_models")
    urls = [s["url"] for s in cfg["sources"]]
    assert "https://no-key.example/feed" in urls
    assert "https://explicit-true.example/feed" in urls


def test_fetch_topic_config_cache_also_filters_disabled(monkeypatch):
    """Cache-hit path also applies the enabled filter."""
    state = {
        "rows": {
            "digest_topics": [
                {
                    "slug": "ai_models",
                    "cadence": "24h",
                    "sources": [
                        {"type": "rss", "url": "https://enabled.example/feed"},
                        {
                            "type": "rss",
                            "url": "https://disabled.example/feed",
                            "enabled": False,
                        },
                    ],
                }
            ]
        }
    }
    _install_client(monkeypatch, state)
    # First call populates cache
    fetch_topic_config("ai_models")
    # Second call is served from cache — still should filter
    cfg2 = fetch_topic_config("ai_models")
    urls = [s["url"] for s in cfg2["sources"]]
    assert "https://enabled.example/feed" in urls
    assert "https://disabled.example/feed" not in urls
