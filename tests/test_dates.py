"""Tests for src/news_digest/dates.py — issue #102.

Verifies the Eastern-canonical date contract: app_today() resolves the current
date in America/New_York, which can differ from the UTC date around midnight.
"""

from datetime import UTC, datetime
from unittest.mock import patch


# Shared helper: build a minimal settings mock with America/New_York
def _eastern_settings():
    return type("S", (), {"app_timezone": "America/New_York"})()


# ---------------------------------------------------------------------------
# app_today
# ---------------------------------------------------------------------------


def test_app_today_returns_eastern_date_not_utc_at_midnight(monkeypatch):
    """Freeze a UTC instant that straddles the Eastern midnight.

    We freeze at 2026-06-12 03:00 UTC = 2026-06-11 23:00 ET (UTC-4 in summer).
    Expected Eastern date: 2026-06-11.
    If the function naively used UTC date it would return 2026-06-12 — wrong.
    """
    from news_digest import dates as dates_module
    from news_digest.dates import app_today

    monkeypatch.setattr(dates_module, "get_settings", _eastern_settings)

    # 2026-06-12 03:00:00 UTC = 2026-06-11 23:00:00 EDT (UTC-4)
    frozen_utc = datetime(2026, 6, 12, 3, 0, 0, tzinfo=UTC)
    with patch("news_digest.dates.datetime") as mock_dt:
        mock_dt.now.return_value = frozen_utc
        result = app_today()

    assert result.year == 2026
    assert result.month == 6
    assert result.day == 11, (
        f"Expected Eastern date 2026-06-11, got {result} "
        "(03:00 UTC = 23:00 EDT, so Eastern date is still the 11th)"
    )


def test_app_today_returns_eastern_date_when_utc_is_next_day(monkeypatch):
    """Freeze at 2026-06-12 03:30 UTC = 2026-06-11 23:30 EDT.
    Eastern date should be the 11th even though UTC date is the 12th.
    """
    from news_digest import dates as dates_module
    from news_digest.dates import app_today

    monkeypatch.setattr(dates_module, "get_settings", _eastern_settings)

    # 2026-06-12 03:30 UTC = 2026-06-11 23:30 EDT (UTC-4)
    frozen_utc = datetime(2026, 6, 12, 3, 30, 0, tzinfo=UTC)
    with patch("news_digest.dates.datetime") as mock_dt:
        mock_dt.now.return_value = frozen_utc
        result = app_today()

    # Eastern date is 11th (not 12th)
    assert result.isoformat() == "2026-06-11"


def test_app_today_returns_correct_date_after_et_midnight(monkeypatch):
    """Freeze at 2026-06-12 05:00 UTC = 2026-06-12 01:00 EDT.
    Both UTC and Eastern date are 2026-06-12.
    """
    from news_digest import dates as dates_module
    from news_digest.dates import app_today

    monkeypatch.setattr(dates_module, "get_settings", _eastern_settings)

    frozen_utc = datetime(2026, 6, 12, 5, 0, 0, tzinfo=UTC)
    with patch("news_digest.dates.datetime") as mock_dt:
        mock_dt.now.return_value = frozen_utc
        result = app_today()

    assert result.isoformat() == "2026-06-12"


def test_app_today_returns_date_object(monkeypatch):
    """app_today() must return a datetime.date, not a datetime."""
    from datetime import date

    from news_digest import dates as dates_module
    from news_digest.dates import app_today

    monkeypatch.setattr(dates_module, "get_settings", _eastern_settings)

    frozen_utc = datetime(2026, 6, 12, 12, 0, 0, tzinfo=UTC)
    with patch("news_digest.dates.datetime") as mock_dt:
        mock_dt.now.return_value = frozen_utc
        result = app_today()

    assert isinstance(result, date)
    assert type(result) is date, "Should return date, not a datetime subclass"


def test_app_today_uses_app_timezone_setting(monkeypatch):
    """app_today() reads app_timezone from settings, not a hardcoded constant."""
    from news_digest import dates as dates_module
    from news_digest.dates import app_today

    # Force settings to use UTC — then 03:00 UTC should give UTC date 2026-06-12
    mock_settings = type("S", (), {"app_timezone": "UTC"})()
    monkeypatch.setattr(dates_module, "get_settings", lambda: mock_settings)

    frozen_utc = datetime(2026, 6, 12, 3, 0, 0, tzinfo=UTC)
    with patch("news_digest.dates.datetime") as mock_dt:
        mock_dt.now.return_value = frozen_utc
        result = app_today()

    # With UTC as app_timezone, 03:00 UTC → date is 2026-06-12
    assert result.isoformat() == "2026-06-12"
