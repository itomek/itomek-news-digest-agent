"""Tests for src/news_digest/retention.py — issue #102.

Verifies:
- cutoff math: retention_days=3 keeps today/-1/-2 and deletes -3 and older
- purge_old_digests() calls delete with .lt("digest_date", cutoff_iso)
- graceful failure when the Supabase client raises
"""

from datetime import date
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fake_client_returning(delete_count: int):
    """Build a mock Supabase client whose delete chain reports deleted rows."""
    client = MagicMock()
    tbl = MagicMock()
    client.table.return_value = tbl
    tbl.delete.return_value = tbl
    tbl.lt.return_value = tbl
    resp = MagicMock()
    resp.data = [{}] * delete_count
    tbl.execute.return_value = resp
    return client, tbl


def _fake_client_raising(exc: Exception):
    """Build a mock client whose execute() raises exc."""
    client = MagicMock()
    tbl = MagicMock()
    client.table.return_value = tbl
    tbl.delete.return_value = tbl
    tbl.lt.return_value = tbl
    tbl.execute.side_effect = exc
    return client


# ---------------------------------------------------------------------------
# Cutoff math
# ---------------------------------------------------------------------------


class TestCutoffMath:
    """retention_days=3 → keep today, today-1, today-2; delete today-3+."""

    def test_cutoff_with_retention_3_keeps_today(self):
        """Cutoff is today-2; rows on or after cutoff are retained."""
        from news_digest.retention import _cutoff_date

        today = date(2026, 6, 15)
        cutoff = _cutoff_date(today, retention_days=3)
        # cutoff = today - (3 - 1) = today - 2 = 2026-06-13
        assert cutoff == date(2026, 6, 13)

    def test_cutoff_with_retention_3_keeps_today_minus_2(self):
        """today-2 is AT the cutoff boundary and is retained (not deleted)."""
        from news_digest.retention import _cutoff_date

        today = date(2026, 6, 15)
        cutoff = _cutoff_date(today, retention_days=3)
        # today-2 = 2026-06-13 == cutoff; delete condition is < cutoff
        assert date(2026, 6, 13) >= cutoff  # retained

    def test_cutoff_with_retention_3_deletes_today_minus_3(self):
        """today-3 is BELOW the cutoff and is deleted."""
        from news_digest.retention import _cutoff_date

        today = date(2026, 6, 15)
        cutoff = _cutoff_date(today, retention_days=3)
        assert date(2026, 6, 12) < cutoff  # 2026-06-12 < 2026-06-13 → deleted

    def test_cutoff_with_retention_1_keeps_only_today(self):
        """retention_days=1 → cutoff is today; keeps only today."""
        from news_digest.retention import _cutoff_date

        today = date(2026, 6, 15)
        cutoff = _cutoff_date(today, retention_days=1)
        assert cutoff == date(2026, 6, 15)

    def test_cutoff_with_retention_7(self):
        """retention_days=7 keeps a week of digests."""
        from news_digest.retention import _cutoff_date

        today = date(2026, 6, 15)
        cutoff = _cutoff_date(today, retention_days=7)
        assert cutoff == date(2026, 6, 9)


# ---------------------------------------------------------------------------
# purge_old_digests — delete call shape
# ---------------------------------------------------------------------------


class TestPurgeOldDigests:
    """purge_old_digests() must issue the correct delete query."""

    def test_calls_delete_with_lt_cutoff(self, monkeypatch):
        """delete().lt("digest_date", cutoff_iso) is called with the right cutoff."""
        from news_digest import retention as ret_module

        today = date(2026, 6, 15)
        # retention_days=3 → cutoff = 2026-06-13
        mock_settings = type("S", (), {"retention_days": 3})()
        monkeypatch.setattr(ret_module, "get_settings", lambda: mock_settings)

        client, tbl = _fake_client_returning(2)
        monkeypatch.setattr(ret_module, "_client", lambda: client)

        today_patch = patch("news_digest.retention.app_today", return_value=today)
        log_patch = patch.object(ret_module, "log", MagicMock())

        with today_patch, log_patch:
            from news_digest.retention import purge_old_digests

            purge_old_digests()

        client.table.assert_called_once_with("digests")
        tbl.delete.assert_called_once()
        tbl.lt.assert_called_once_with("digest_date", "2026-06-13")
        tbl.execute.assert_called_once()

    def test_logs_success_with_cutoff_and_deleted_count(self, monkeypatch):
        """On success, log("info","retention",...) includes cutoff and deleted count."""
        from news_digest import retention as ret_module

        today = date(2026, 6, 15)
        mock_settings = type("S", (), {"retention_days": 3})()
        monkeypatch.setattr(ret_module, "get_settings", lambda: mock_settings)

        client, _ = _fake_client_returning(5)
        monkeypatch.setattr(ret_module, "_client", lambda: client)

        captured_logs: list = []

        def _capture_log(level, category, message, **kwargs):
            captured_logs.append(
                {"level": level, "category": category, "msg": message, **kwargs}
            )

        today_patch = patch("news_digest.retention.app_today", return_value=today)
        log_patch = patch.object(ret_module, "log", _capture_log)

        with today_patch, log_patch:
            from news_digest.retention import purge_old_digests

            purge_old_digests()

        assert len(captured_logs) == 1
        entry = captured_logs[0]
        assert entry["level"] == "info"
        assert entry["category"] == "retention"
        assert entry["metadata"]["cutoff"] == "2026-06-13"
        assert entry["metadata"]["deleted"] == 5

    def test_graceful_when_client_raises(self, monkeypatch):
        """A Supabase error is swallowed — purge never raises."""
        from news_digest import retention as ret_module

        today = date(2026, 6, 15)
        mock_settings = type("S", (), {"retention_days": 3})()
        monkeypatch.setattr(ret_module, "get_settings", lambda: mock_settings)

        bad_client = _fake_client_raising(RuntimeError("db gone"))
        monkeypatch.setattr(ret_module, "_client", lambda: bad_client)

        captured_logs: list = []

        def _capture_log(level, category, message, **kwargs):
            captured_logs.append({"level": level, "category": category})

        today_patch = patch("news_digest.retention.app_today", return_value=today)
        log_patch = patch.object(ret_module, "log", _capture_log)

        with today_patch, log_patch:
            from news_digest.retention import purge_old_digests

            # Must not raise
            purge_old_digests()

        # An error must have been logged
        error_logs = [e for e in captured_logs if e["level"] == "error"]
        assert len(error_logs) == 1
        assert error_logs[0]["category"] == "retention"

    def test_idempotent_no_rows_deleted(self, monkeypatch):
        """When no rows match (already purged or fresh DB), delete still called once."""
        from news_digest import retention as ret_module

        today = date(2026, 6, 15)
        mock_settings = type("S", (), {"retention_days": 3})()
        monkeypatch.setattr(ret_module, "get_settings", lambda: mock_settings)

        client, tbl = _fake_client_returning(0)
        monkeypatch.setattr(ret_module, "_client", lambda: client)

        captured_logs: list = []

        def _capture_log(level, category, message, **kwargs):
            captured_logs.append({"level": level, **kwargs.get("metadata", {})})

        today_patch = patch("news_digest.retention.app_today", return_value=today)
        log_patch = patch.object(ret_module, "log", _capture_log)

        with today_patch, log_patch:
            from news_digest.retention import purge_old_digests

            purge_old_digests()

        tbl.execute.assert_called_once()
        # logged deleted=0
        assert captured_logs[0].get("deleted") == 0


# ---------------------------------------------------------------------------
# Integration marker: skip DB-touching tests by default
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_purge_old_digests_integration():
    """Live integration test — requires SUPABASE_* env vars.

    Calls purge_old_digests() against the real Supabase project and verifies
    it returns without raising. Does NOT assert row counts (non-deterministic
    in prod). Only run manually with: pytest -m integration
    """
    from news_digest.retention import purge_old_digests

    # Should not raise even if nothing is deleted
    purge_old_digests()
