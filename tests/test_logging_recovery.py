"""Tests for structured run logging and error recovery — issue #15.

Covers the three failure modes required by the DoD:
  1. Supabase down during publish → falls back to SQLite, drain on next run.
  2. Lemonade down → topic logged under summarize/error, skipped, no crash.
  3. Scrape flake then success → tenacity retries, exactly one log entry.

These tests monkeypatch network boundaries (Supabase client, httpx transport,
process_query), never internal implementation details of logging.py that are
already covered by test_logging.py.
"""

from unittest.mock import MagicMock, patch

import httpx
import pytest

from news_digest import logging as nd_logging
from news_digest.tools import scraping

# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def reset_fallback_db(tmp_path, monkeypatch, valid_env):
    """Isolate each test to its own SQLite fallback file."""
    monkeypatch.setenv("FALLBACK_LOG_PATH", str(tmp_path / "fallback.sqlite"))
    nd_logging._fallback_db = None
    yield
    if nd_logging._fallback_db:
        nd_logging._fallback_db.close()
    nd_logging._fallback_db = None


@pytest.fixture(autouse=True)
def _reset_rate_limit():
    scraping._last_fetch.clear()
    scraping._last_retry_error.clear()
    yield
    scraping._last_fetch.clear()
    scraping._last_retry_error.clear()


@pytest.fixture(autouse=True)
def _no_real_sleep(monkeypatch):
    monkeypatch.setattr(scraping.time, "sleep", MagicMock())


def _mock_supabase_client():
    client = MagicMock()
    client.table.return_value.insert.return_value.execute.return_value = MagicMock()
    client.table.return_value.upsert.return_value.execute.return_value = MagicMock()
    return client


# ---------------------------------------------------------------------------
# Failure mode 1: Supabase down during log → SQLite fallback + drain
# ---------------------------------------------------------------------------


def test_supabase_down_logs_fall_back_to_sqlite(valid_env):
    """When Supabase is unreachable, log() must persist to SQLite without raising."""
    with patch(
        "news_digest.logging.create_client", side_effect=Exception("connection refused")
    ):
        nd_logging.log(
            "error", "publish", "push_to_supabase failed", metadata={"retry": 1}
        )

    db = nd_logging._get_fallback_db()
    rows = db.execute(
        "SELECT level, category, message FROM system_logs WHERE synced_at IS NULL"
    ).fetchall()
    assert len(rows) == 1
    assert rows[0] == ("error", "publish", "push_to_supabase failed")


def test_supabase_down_drain_on_recovery(valid_env):
    """drain_fallback() ships accumulated rows to Supabase when it comes back up."""
    # Phase 1: Supabase down — two log() calls go to SQLite.
    with patch("news_digest.logging.create_client", side_effect=Exception("down")):
        nd_logging.log("info", "schedule", "cycle start")
        nd_logging.log("error", "publish", "upsert failed")

    db = nd_logging._get_fallback_db()
    pending = db.execute(
        "SELECT id FROM system_logs WHERE synced_at IS NULL"
    ).fetchall()
    assert len(pending) == 2

    # Phase 2: Supabase recovers — drain_fallback ships both rows.
    mock_client = _mock_supabase_client()
    with patch("news_digest.logging.create_client", return_value=mock_client):
        drained = nd_logging.drain_fallback()

    assert drained == 2
    still_pending = db.execute(
        "SELECT id FROM system_logs WHERE synced_at IS NULL"
    ).fetchall()
    assert len(still_pending) == 0


def test_supabase_down_drain_idempotent(valid_env):
    """A second drain_fallback() call after all rows are synced returns 0."""
    mock_client = _mock_supabase_client()
    with patch("news_digest.logging.create_client", return_value=mock_client):
        nd_logging.log("info", "scrape", "fetched 5 entries")
        nd_logging.drain_fallback()
        count = nd_logging.drain_fallback()
    assert count == 0


# ---------------------------------------------------------------------------
# Failure mode 2: Lemonade down → topic skipped, summarize/error logged
# ---------------------------------------------------------------------------


def test_lemonade_down_logs_error_and_returns_failure(valid_env, monkeypatch):
    """When process_query records an llm_connection_error, generate_and_publish
    must log category=summarize/level=error and return success=False without
    crashing or attempting to publish."""
    # Import here to avoid GAIA agent construction at module level.
    from news_digest import agent as nd_agent

    # Construct a minimal fake agent without network calls.
    fake_agent = MagicMock(spec=nd_agent.NewsDigestAgent)
    fake_agent.model_id = "test-model"
    fake_agent.process_query.return_value = {
        "status": "failed",
        "result": "",
        "conversation": [],
        "steps_taken": 1,
        "duration": 0.5,
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
        "error_count": 1,
        "error_history": [
            {
                "step": 1,
                "error": "LLM Server Connection Failed (streaming): connection refused",
                "type": "llm_connection_error",
            }
        ],
    }

    logged_calls: list[dict] = []

    def _capture_log(level, category, message, topic_slug=None, metadata=None):
        logged_calls.append(
            {
                "level": level,
                "category": category,
                "message": message,
                "metadata": metadata,
            }
        )

    monkeypatch.setattr(nd_agent, "log", _capture_log)

    result = nd_agent.NewsDigestAgent.generate_and_publish(
        fake_agent, "Generate ai_models digest for today"
    )

    assert result == {"success": False, "error": "lemonade_down"}
    assert len(logged_calls) == 1
    call = logged_calls[0]
    assert call["level"] == "error"
    assert call["category"] == "summarize"
    assert "Lemonade" in call["message"] or "unreachable" in call["message"]


def test_lemonade_down_does_not_call_publish(valid_env, monkeypatch):
    """No push_to_supabase call should happen when Lemonade is unreachable."""
    from news_digest import agent as nd_agent

    fake_agent = MagicMock(spec=nd_agent.NewsDigestAgent)
    fake_agent.model_id = "test-model"
    fake_agent.process_query.return_value = {
        "status": "failed",
        "result": "",
        "conversation": [],
        "steps_taken": 0,
        "duration": 0.1,
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
        "error_count": 1,
        "error_history": [
            {"step": 0, "error": "conn refused", "type": "llm_connection_error"}
        ],
    }

    monkeypatch.setattr(nd_agent, "log", MagicMock())
    publish_mock = MagicMock()
    monkeypatch.setattr(nd_agent, "_publish_from_result", publish_mock)

    nd_agent.NewsDigestAgent.generate_and_publish(fake_agent, "Generate digest")

    publish_mock.assert_not_called()


# ---------------------------------------------------------------------------
# Failure mode 3: scrape flake then success — one log entry, retries work
# ---------------------------------------------------------------------------


RSS_WELL_FORMED = b"""<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Test</title><link>https://example.com</link>
  <item>
    <title>Fresh Article</title>
    <link>https://example.com/1</link>
    <pubDate>Wed, 06 May 2026 11:00:00 +0000</pubDate>
    <description>Summary</description>
  </item>
</channel></rss>"""


def _patch_make_client_with_handler(monkeypatch, handler):
    real_make = (
        scraping._make_client.__wrapped__
        if hasattr(scraping._make_client, "__wrapped__")
        else scraping._make_client
    )
    mock_transport = httpx.MockTransport(handler)

    def _patched(**_kwargs):
        return real_make(transport=mock_transport)

    monkeypatch.setattr(scraping, "_make_client", _patched)
    return mock_transport


def test_scrape_flake_then_success_retries_and_succeeds(monkeypatch, valid_env):
    """Two connect errors followed by a successful response must yield entries.

    This validates that tenacity's 3-attempt budget is working and that the
    public fetch_rss tool still returns data after a retry-then-success path.
    """
    from datetime import UTC, datetime

    monkeypatch.setattr(
        scraping, "_now_utc", lambda: datetime(2026, 5, 6, 12, 0, tzinfo=UTC)
    )
    monkeypatch.setattr(scraping, "_validate_url", lambda url: None)

    call_count = {"n": 0}

    def handler(req):
        call_count["n"] += 1
        if call_count["n"] < 3:
            raise httpx.ConnectError("flaky network")
        return httpx.Response(200, content=RSS_WELL_FORMED)

    _patch_make_client_with_handler(monkeypatch, handler)

    log_mock = MagicMock()
    monkeypatch.setattr(scraping, "log", log_mock)

    result = scraping.fetch_rss("https://example.com/feed.xml", since_hours=24)

    # Retried twice then succeeded: 3 total calls to the transport.
    assert call_count["n"] == 3
    assert len(result) == 1
    assert result[0]["title"] == "Fresh Article"


def test_scrape_flake_then_success_emits_exactly_one_log_entry(monkeypatch, valid_env):
    """Retry internals must not log. Only the final success info log is emitted."""
    from datetime import UTC, datetime

    monkeypatch.setattr(
        scraping, "_now_utc", lambda: datetime(2026, 5, 6, 12, 0, tzinfo=UTC)
    )
    monkeypatch.setattr(scraping, "_validate_url", lambda url: None)

    call_count = {"n": 0}

    def handler(req):
        call_count["n"] += 1
        if call_count["n"] < 3:
            raise httpx.ConnectError("flaky network")
        return httpx.Response(200, content=RSS_WELL_FORMED)

    _patch_make_client_with_handler(monkeypatch, handler)

    log_mock = MagicMock()
    monkeypatch.setattr(scraping, "log", log_mock)

    scraping.fetch_rss("https://example.com/feed.xml", since_hours=24)

    # Single info log for success — no warn logs for the intermediate retries.
    assert log_mock.call_count == 1
    assert log_mock.call_args.args[0] == "info"
    assert log_mock.call_args.args[1] == "scrape"
    md = log_mock.call_args.kwargs["metadata"]
    assert md["entries_returned"] == 1
    assert isinstance(md["duration_ms"], int)


def test_scrape_exhausted_retries_logs_warn_with_error_class(monkeypatch, valid_env):
    """When all 3 attempts fail, fetch_rss must log exactly one warn with
    last_error_class populated and return []."""
    monkeypatch.setattr(scraping, "_validate_url", lambda url: None)

    def handler(req):
        raise httpx.ConnectError("dns failed")

    _patch_make_client_with_handler(monkeypatch, handler)

    log_mock = MagicMock()
    monkeypatch.setattr(scraping, "log", log_mock)

    result = scraping.fetch_rss("https://example.com/feed.xml", since_hours=24)

    assert result == []
    assert log_mock.call_count == 1
    call = log_mock.call_args
    assert call.args[0] == "warn"
    assert call.args[1] == "scrape"
    md = call.kwargs["metadata"]
    assert md["last_error_class"] == "ConnectError"
