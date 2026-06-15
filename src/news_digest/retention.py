"""Daily hard-purge of stale digests — issue #102.

Deletes ``digests`` rows whose ``digest_date`` is older than the retention
window.  With the default ``retention_days=4``, today's digest plus the three
prior days are kept; anything older is deleted.

Public API
----------
purge_old_digests() -> None
    Delete digests older than the retention window.  Idempotent; swallows and
    logs errors so the daemon never crashes on a purge failure.

_cutoff_date(today, retention_days) -> datetime.date
    Pure helper exposed for tests.  Returns the *inclusive* lower boundary:
    rows *on* the cutoff date are retained; rows *before* it are deleted.

Retention window example (retention_days=4, today=2026-06-15):
    Kept:    2026-06-12, 2026-06-13, 2026-06-14, 2026-06-15
    Deleted: 2026-06-11 and older (digest_date < '2026-06-12')
"""

from datetime import date, timedelta

from news_digest.config import get_settings
from news_digest.dates import app_today
from news_digest.logging import log
from news_digest.supabase_client import get_client
from supabase import Client


def _client() -> Client:
    """Return the shared Supabase client (service_role).

    Thin wrapper kept as the monkeypatch seam for tests; auth rationale lives
    in ``news_digest.supabase_client``.
    """
    return get_client()


def _cutoff_date(today: date, retention_days: int) -> date:
    """Return the cutoff date for the retention window.

    Rows with ``digest_date < cutoff.isoformat()`` are deleted.  Rows on the
    cutoff date itself are retained.

    Args:
        today: The reference date (typically ``app_today()``).
        retention_days: Number of days to retain, including today.

    Returns:
        ``today - (retention_days - 1)`` as a ``datetime.date``.

    Examples:
        retention_days=3, today=2026-06-15 → cutoff=2026-06-13
        (keeps 2026-06-13, 2026-06-14, 2026-06-15; deletes 2026-06-12+)
    """
    return today - timedelta(days=retention_days - 1)


def purge_old_digests() -> None:
    """Delete digest rows older than the configured retention window.

    Uses the service-role Supabase client to issue a hard delete on the
    ``digests`` table for all rows where ``digest_date < cutoff_iso``.

    The cutoff is computed from ``app_today()`` and ``settings.retention_days``
    on every call, so it is always relative to the current Eastern date.

    Idempotent: calling it multiple times on the same day deletes the same
    (already-empty) set of rows.  Errors from Supabase are caught, logged as
    ``error``/``retention``, and swallowed so the scheduler daemon never
    crashes on a purge failure.
    """
    settings = get_settings()
    today = app_today()
    cutoff = _cutoff_date(today, settings.retention_days)
    cutoff_iso = cutoff.isoformat()

    try:
        resp = (
            _client().table("digests").delete().lt("digest_date", cutoff_iso).execute()
        )
        deleted = len(resp.data) if resp.data else 0
        log(
            "info",
            "retention",
            f"purge_old_digests: deleted {deleted} row(s) older than {cutoff_iso}",
            metadata={
                "cutoff": cutoff_iso,
                "deleted": deleted,
                "today": today.isoformat(),
            },
        )
    except Exception as exc:  # noqa: BLE001 — never crash the daemon
        log(
            "error",
            "retention",
            f"purge_old_digests: failed: {exc.__class__.__name__}: {exc}",
            metadata={"cutoff": cutoff_iso, "error": str(exc)},
        )
