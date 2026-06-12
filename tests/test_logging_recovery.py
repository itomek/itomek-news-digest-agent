"""Tests for structured run logging and error recovery — issue #15.

Covers the three failure modes required by the DoD:
  1. Supabase down during publish → falls back to SQLite, drained into Supabase
     at the start of the next generate_and_publish run.
  2. Lemonade down → topic logged under summarize/error, skipped, no crash.
     Detection is grounded in an empirical probe against a closed port (see
     OBSERVED_CONNECTION_REFUSED_ENTRY) and guards against GAIA's mixed
     string/dict error_history.
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

# The exact error_history entry GAIA produced on a refused connection, observed
# by running process_query against a closed port (LEMONADE_BASE_URL=
# http://127.0.0.1:9). NOTE the tag is 'llm_error', NOT 'llm_connection_error':
# the requests-based Lemonade stack never raises builtin ConnectionError, so a
# real outage lands in GAIA's generic exception handler.
OBSERVED_CONNECTION_REFUSED_ENTRY = {
    "step": 1,
    "error": (
        "HTTPConnectionPool(host='127.0.0.1', port=9): Max retries exceeded "
        "with url: /api/v1/chat/completions (Caused by NewConnectionError("
        "\"HTTPConnection(host='127.0.0.1', port=9): Failed to establish a "
        'new connection: [Errno 61] Connection refused"))'
    ),
    "type": "llm_error",
}


def _process_query_result(error_history: list) -> dict:
    """Build a minimal failed process_query result with the given error_history."""
    return {
        "status": "failed",
        "result": "",
        "conversation": [],
        "steps_taken": 1,
        "duration": 0.5,
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
        "error_count": len(error_history),
        "error_history": error_history,
    }


def _run_generate_and_publish(monkeypatch, process_query_result, capture_logs=None):
    """Drive NewsDigestAgent.generate_and_publish with a mocked self/process_query.

    Calls the real unbound method so the detection + logging + publish wiring is
    exercised; only the network boundaries (process_query, log, publish) are
    replaced.
    """
    from news_digest import agent as nd_agent

    fake_agent = MagicMock()
    fake_agent.model_id = "test-model"
    fake_agent.process_query.return_value = process_query_result

    if capture_logs is not None:

        def _capture_log(level, category, message, topic_slug=None, metadata=None):
            capture_logs.append(
                {
                    "level": level,
                    "category": category,
                    "message": message,
                    "metadata": metadata,
                }
            )

        monkeypatch.setattr(nd_agent, "log", _capture_log)
    else:
        monkeypatch.setattr(nd_agent, "log", MagicMock())

    publish_mock = MagicMock(return_value={"success": True, "id": "fake-id"})
    monkeypatch.setattr(nd_agent, "_publish_from_result", publish_mock)

    result = nd_agent.NewsDigestAgent.generate_and_publish(
        fake_agent, "Generate ai_models digest for today"
    )
    return result, publish_mock


@pytest.mark.parametrize(
    "entry",
    [
        # Observed empirically: connection refused → generic 'llm_error' tag.
        OBSERVED_CONNECTION_REFUSED_ENTRY,
        # Builtin ConnectionError path (kept for completeness).
        {
            "step": 1,
            "error": "LLM Server Connection Failed: connection reset",
            "type": "llm_connection_error",
        },
        # Streaming path with openai.APIConnectionError's message shape.
        {"step": 1, "error": "Connection error.", "type": "llm_streaming_error"},
    ],
    ids=["observed_llm_error", "llm_connection_error", "streaming_apiconnerror"],
)
def test_lemonade_down_logs_error_and_returns_failure(valid_env, monkeypatch, entry):
    """A connection-level LLM failure must log summarize/error and return
    success=False without crashing or attempting to publish."""
    logged: list[dict] = []
    result, publish_mock = _run_generate_and_publish(
        monkeypatch, _process_query_result([entry]), capture_logs=logged
    )

    assert result == {"success": False, "error": "lemonade_down"}
    publish_mock.assert_not_called()
    summarize_logs = [c for c in logged if c["category"] == "summarize"]
    assert len(summarize_logs) == 1
    call = summarize_logs[0]
    assert call["level"] == "error"
    assert "Lemonade" in call["message"] or "unreachable" in call["message"]


def test_lemonade_down_detection_survives_mixed_error_history(valid_env, monkeypatch):
    """GAIA's error_history mixes plain strings (tool/parse errors) with dicts.
    Detection must not raise AttributeError on string entries and must still
    find the connection failure among them."""
    mixed_history = [
        "Empty LLM response",  # gaia agent.py:890 — plain string
        "Failed to parse tool_args JSON: Expecting value: line 1",  # string
        OBSERVED_CONNECTION_REFUSED_ENTRY,  # the real outage entry
        "ConnectError: connection refused",  # tool error str(e) — string
    ]

    result, publish_mock = _run_generate_and_publish(
        monkeypatch, _process_query_result(mixed_history)
    )

    assert result == {"success": False, "error": "lemonade_down"}
    publish_mock.assert_not_called()


def test_all_string_error_history_does_not_crash_or_skip(valid_env, monkeypatch):
    """An error_history of only strings (tool errors) is not a Lemonade outage:
    no AttributeError, and the run proceeds to publish."""
    result, publish_mock = _run_generate_and_publish(
        monkeypatch,
        _process_query_result(["Empty LLM response", "tool boom"]),
    )

    publish_mock.assert_called_once()
    assert result == {"success": True, "id": "fake-id"}


def test_ordinary_llm_error_is_not_classified_as_lemonade_down(valid_env, monkeypatch):
    """A generic llm_error without connection-level markers (e.g. a mid-run
    model failure) must NOT skip the topic — publish still runs."""
    entry = {
        "step": 2,
        "error": "Invalid response format: expected JSON object",
        "type": "llm_error",
    }
    result, publish_mock = _run_generate_and_publish(
        monkeypatch, _process_query_result([entry])
    )

    publish_mock.assert_called_once()
    assert result == {"success": True, "id": "fake-id"}


def test_is_lemonade_down_handles_none_and_empty():
    from news_digest.agent import _is_lemonade_down

    assert _is_lemonade_down(None) is False
    assert _is_lemonade_down([]) is False


# ---------------------------------------------------------------------------
# Recovery: fallback rows drained at the start of the next run
# ---------------------------------------------------------------------------


def test_generate_and_publish_drains_fallback_on_next_run(valid_env, monkeypatch):
    """A log row stranded in SQLite during a Supabase outage must be drained to
    Supabase by the next generate_and_publish run once Supabase is reachable."""
    from news_digest import agent as nd_agent

    # Phase 1: Supabase down — a publish-failure log lands in the fallback DB.
    with patch(
        "news_digest.logging.create_client", side_effect=Exception("supabase down")
    ):
        nd_logging.log("error", "publish", "upsert failed during outage")

    db = nd_logging._get_fallback_db()
    assert (
        len(db.execute("SELECT id FROM system_logs WHERE synced_at IS NULL").fetchall())
        == 1
    )

    # Phase 2: Supabase back up — the next run drains the stranded row.
    fake_agent = MagicMock()
    fake_agent.model_id = "test-model"
    fake_agent.process_query.return_value = _process_query_result([])
    fake_agent.process_query.return_value["status"] = "success"

    monkeypatch.setattr(nd_agent, "log", MagicMock())
    monkeypatch.setattr(
        nd_agent, "_publish_from_result", MagicMock(return_value={"success": True})
    )

    mock_client = _mock_supabase_client()
    with patch("news_digest.logging.create_client", return_value=mock_client):
        nd_agent.NewsDigestAgent.generate_and_publish(fake_agent, "Generate digest")

    # The stranded row was upserted to Supabase and marked synced locally.
    mock_client.table.assert_called_with("system_logs")
    assert (
        len(db.execute("SELECT id FROM system_logs WHERE synced_at IS NULL").fetchall())
        == 0
    )


def test_generate_and_publish_survives_drain_failure(valid_env, monkeypatch):
    """A broken fallback DB (disk error) must never block the run."""
    from news_digest import agent as nd_agent

    monkeypatch.setattr(
        nd_agent, "drain_fallback", MagicMock(side_effect=OSError("disk full"))
    )
    monkeypatch.setattr(nd_agent, "log", MagicMock())
    monkeypatch.setattr(
        nd_agent, "_publish_from_result", MagicMock(return_value={"success": True})
    )

    fake_agent = MagicMock()
    fake_agent.model_id = "test-model"
    fake_agent.process_query.return_value = _process_query_result([])

    result = nd_agent.NewsDigestAgent.generate_and_publish(fake_agent, "Generate")

    assert result == {"success": True}


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
