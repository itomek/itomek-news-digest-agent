from unittest.mock import MagicMock, patch

import pytest

from news_digest import logging as nd_logging


@pytest.fixture(autouse=True)
def reset_fallback_db(tmp_path, monkeypatch, valid_env):
    monkeypatch.setenv("FALLBACK_LOG_PATH", str(tmp_path / "fallback.sqlite"))
    nd_logging._fallback_db = None
    yield
    if nd_logging._fallback_db:
        nd_logging._fallback_db.close()
    nd_logging._fallback_db = None


def _mock_supabase_client():
    client = MagicMock()
    client.table.return_value.insert.return_value.execute.return_value = MagicMock()
    client.table.return_value.upsert.return_value.execute.return_value = MagicMock()
    return client


def test_log_writes_to_supabase_when_reachable(valid_env):
    mock_client = _mock_supabase_client()
    with patch("news_digest.logging.create_client", return_value=mock_client):
        nd_logging.log("info", "scrape", "fetched 10 entries", topic_slug="ai_models")

    mock_client.table.assert_called_with("system_logs")
    call_args = mock_client.table.return_value.insert.call_args[0][0]
    assert call_args["level"] == "info"
    assert call_args["category"] == "scrape"
    assert call_args["topic_slug"] == "ai_models"
    assert call_args["message"] == "fetched 10 entries"
    assert "id" in call_args
    assert "timestamp" in call_args


def test_log_falls_back_to_sqlite_on_supabase_failure(valid_env, tmp_path):
    with patch(
        "news_digest.logging.create_client", side_effect=Exception("network error")
    ):
        nd_logging.log("error", "publish", "supabase down", metadata={"retries": 3})

    db = nd_logging._get_fallback_db()
    rows = db.execute("SELECT level, category, message FROM system_logs").fetchall()
    assert len(rows) == 1
    assert rows[0] == ("error", "publish", "supabase down")


def test_log_never_raises_on_any_failure(valid_env):
    with patch("news_digest.logging.create_client", side_effect=RuntimeError("boom")):
        with patch.object(
            nd_logging, "_write_fallback", side_effect=OSError("disk full")
        ):
            nd_logging.log("warn", "system", "should not raise")


def test_drain_fallback_pushes_rows_to_supabase(valid_env):
    with patch("news_digest.logging.create_client", side_effect=Exception("down")):
        nd_logging.log("info", "schedule", "msg1")
        nd_logging.log("info", "schedule", "msg2")

    db = nd_logging._get_fallback_db()
    unsynced = db.execute(
        "SELECT id FROM system_logs WHERE synced_at IS NULL"
    ).fetchall()
    assert len(unsynced) == 2

    mock_client = _mock_supabase_client()
    with patch("news_digest.logging.create_client", return_value=mock_client):
        drained = nd_logging.drain_fallback()

    assert drained == 2
    still_unsynced = db.execute(
        "SELECT id FROM system_logs WHERE synced_at IS NULL"
    ).fetchall()
    assert len(still_unsynced) == 0


def test_drain_fallback_returns_zero_when_supabase_still_down(valid_env):
    with patch("news_digest.logging.create_client", side_effect=Exception("down")):
        nd_logging.log("info", "schedule", "msg")
        result = nd_logging.drain_fallback()
    assert result == 0


def test_drain_fallback_idempotent_on_already_synced_rows(valid_env):
    mock_client = _mock_supabase_client()
    with patch("news_digest.logging.create_client", return_value=mock_client):
        nd_logging.log("info", "scrape", "already synced")
        nd_logging.drain_fallback()
        count = nd_logging.drain_fallback()
    assert count == 0
