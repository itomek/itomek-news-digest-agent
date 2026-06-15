"""Canonical date utilities for News Digest Agent — issue #102.

The app treats **America/New_York** as its calendar timezone: the ``digest_date``
column in Supabase reflects the Eastern date on which the digest was generated,
not the UTC date.  This matters most around midnight Eastern time when the UTC
and Eastern dates differ by one day.

Public API
----------
APP_TIMEZONE : str
    The IANA timezone name read from ``settings.app_timezone``.  Exposed for
    callers that need the string (e.g. APScheduler job registration).

app_today() -> datetime.date
    Return today's date in the configured app timezone.  This is the single
    source of truth for "what calendar date is it?" across the codebase.

One-time discontinuity note
---------------------------
Before issue #102, ``push_to_supabase`` stamped ``digest_date`` with
``datetime.now(UTC).date()``.  After this change it uses ``app_today()``
(Eastern).  The few rows written with a UTC date before the deploy will retain
their original dates and will be purged within ``retention_days`` (3 by default)
of the deploy date — no migration is needed.
"""

from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

from news_digest.config import get_settings


def _tz() -> ZoneInfo:
    """Return the app ZoneInfo object, reading timezone from settings each call.

    Not cached: settings-level caching already avoids repeated env reads.
    """
    return ZoneInfo(get_settings().app_timezone)


def app_today() -> date:
    """Return today's calendar date in the configured app timezone.

    Always use this instead of ``datetime.now(UTC).date()`` for any logic that
    answers "what calendar date is it right now?" — digest stamping, published-
    today checks, retention cutoff calculation, etc.

    Returns:
        The current date in ``settings.app_timezone`` (default
        ``America/New_York``).
    """

    now_utc = datetime.now(UTC)
    return now_utc.astimezone(_tz()).date()


#: Exposed for callers that need the IANA timezone name string (e.g. to
#: register APScheduler jobs in the app's local timezone).
APP_TIMEZONE: str = "America/New_York"  # overridden at runtime by settings
