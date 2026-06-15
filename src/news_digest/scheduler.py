"""Scheduler for the News Digest Agent.

Runs a 15-minute tick loop via APScheduler's BlockingScheduler. On each tick
the scheduler fetches all digest_topics rows from Supabase, skips disabled
topics (kill switch), checks whether each enabled topic is due (elapsed time
since last digest >= cadence), applies a 0–300 s random jitter, and then calls
``agent.generate_and_publish()`` one topic at a time (max_instances=1, because
the local LLM is the bottleneck).

Per-topic failure is isolated: one crash is logged and the loop continues. Each
cycle is logged via ``news_digest.logging.log`` with ``category="schedule"``.

Designed to run as a long-lived daemon via systemd::

    python -m news_digest.scheduler

See §2.6, §4, and §5.5 of docs/architecture.md for the design spec.
"""

import random
import signal
import threading
import traceback
from datetime import UTC, date, datetime, timedelta
from typing import Any

from apscheduler.schedulers.blocking import BlockingScheduler

from news_digest.config import get_settings
from news_digest.curator import run_curator_cycle
from news_digest.dates import app_today
from news_digest.logging import log
from news_digest.retention import purge_old_digests
from news_digest.tools.publishing import get_last_digest_date
from supabase import Client

# Set once when a SIGTERM/SIGINT arrives; never reset — this is a one-shot
# daemon process.  Used by _run_topic and run_cycle to abort sleeps and
# skip not-yet-started topics instead of letting the process drift minutes
# past its shutdown deadline.
_shutdown_event = threading.Event()

# Tick every 15 minutes.
_TICK_MINUTES = 15

# Maximum random sleep applied per topic before triggering, to avoid hammering
# all sources at the same instant.
_MAX_JITTER_SECONDS = 300

# Cadence string -> timedelta mapping.  The constraint check in migration 0001
# allows exactly '24h' and '7d' — keep this exhaustive; log and skip on unknown.
_CADENCE_MAP: dict[str, timedelta] = {
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
}

# Maximum number of attempts (initial + retries) when a run finishes without
# publishing.  Lemonade-down failures skip the retry loop entirely.
_MAX_RUN_ATTEMPTS = 3


def _client() -> Client:
    """Build a Supabase client authenticated as service_role.

    Thin wrapper so tests can monkeypatch ``news_digest.scheduler._client``
    without touching the publishing module.
    """
    from news_digest.tools.publishing import _client as _pub_client

    return _pub_client()


def _parse_cadence(cadence: str) -> timedelta | None:
    """Return the timedelta for a cadence string, or None if unrecognised.

    Args:
        cadence: A cadence string as stored in ``digest_topics.cadence``.

    Returns:
        The corresponding ``timedelta``, or ``None`` for unknown values.
    """
    return _CADENCE_MAP.get(cadence)


def _is_topic_due(topic: dict[str, Any], now: datetime) -> bool:
    """Return True when a topic should be run this cycle.

    Computes ``now - last_digest_datetime >= cadence``.  When the topic has
    never been run (``last_date`` is None) it is always due.

    Args:
        topic: A row from ``digest_topics`` with at least ``slug`` and
            ``cadence`` keys.
        now: The current UTC datetime.

    Returns:
        True when the topic is due, False when it should be skipped.
    """
    slug = topic["slug"]
    cadence_str = topic.get("cadence", "")
    cadence = _parse_cadence(cadence_str)
    if cadence is None:
        log(
            "warn",
            "schedule",
            f"_is_topic_due: unrecognised cadence {cadence_str!r} for {slug!r}; skipping",
            topic_slug=slug,
            metadata={"slug": slug, "cadence": cadence_str},
        )
        return False

    result = get_last_digest_date(slug)
    last_date_str = result.get("last_date")
    if last_date_str is None:
        # Never published — always due.
        return True

    try:
        last_date: date = date.fromisoformat(last_date_str)
    except ValueError:
        # A parse failure is a bug signal (digest_date is a Postgres date
        # column, so this should never happen). Skip rather than treat as due:
        # treating it as due would hammer the LLM every 15 minutes for as long
        # as the bad value persists.
        log(
            "warn",
            "schedule",
            f"_is_topic_due: bad last_date {last_date_str!r} for {slug!r}; skipping",
            topic_slug=slug,
            metadata={"slug": slug, "last_date": last_date_str},
        )
        return False

    # Compare last digest *date* (midnight UTC of that day) against now.
    last_datetime = datetime(last_date.year, last_date.month, last_date.day, tzinfo=UTC)
    return (now - last_datetime) >= cadence


def _is_published_today(slug: str) -> bool | None:
    """Check whether a digest for *slug* has already been written today.

    Compares the most recent digest date against today's Eastern date, matching
    the timezone used by ``push_to_supabase`` (``app_today()`` — issue #102).

    Args:
        slug: The topic slug to check.

    Returns:
        True when a digest row exists for today's Eastern date, False when it
        does not, and None when verification is unavailable because the Supabase
        read failed (``get_last_digest_date`` swallowed an exception and
        returned an ``error`` key). None lets the caller fall back to the
        run's own publish result instead of burning retries — three full 35B
        regenerations — on a transient read blip while publishes are landing.
    """
    result = get_last_digest_date(slug)
    if "error" in result:
        return None
    last_date_str = result.get("last_date")
    if last_date_str is None:
        return False
    try:
        last_date = date.fromisoformat(last_date_str)
    except ValueError:
        return False
    return last_date == app_today()


def _run_topic(topic: dict[str, Any], agent: Any) -> None:
    """Execute a single topic run via the agent wrapper, with retry-until-published.

    Applies a 0–300 s random jitter before the first attempt.  After each
    attempt, verifies whether a digest row actually landed in Supabase for
    today's UTC date. If not:
    - ``lemonade_down`` failures skip retries immediately (LLM is unreachable).
    - Otherwise retries up to ``_MAX_RUN_ATTEMPTS`` total attempts.
    - If still unpublished after all attempts, logs an error so monitoring
      catches it (the run is NOT falsely reported as success).

    When the verification read itself fails (Supabase unreachable for reads),
    the run's own ``result["success"]`` is trusted instead — it reflects
    ``_publish_from_result``'s verified write — and a warn is logged that
    verification was skipped.

    All exceptions are caught so one failing topic cannot stop the scheduler
    cycle.

    Args:
        topic: A ``digest_topics`` row with at least ``slug`` and ``name``.
        agent: A ``NewsDigestAgent`` instance exposing ``generate_and_publish``.
    """
    slug = topic["slug"]
    name = topic.get("name", slug)

    jitter = random.uniform(0, _MAX_JITTER_SECONDS)
    log(
        "info",
        "schedule",
        f"_run_topic: {slug!r} — jitter {jitter:.0f}s before start",
        topic_slug=slug,
        metadata={"slug": slug, "jitter_s": round(jitter, 1)},
    )
    if _shutdown_event.wait(jitter):
        log(
            "info",
            "schedule",
            f"_run_topic: shutdown requested during jitter — skipping {slug!r}",
            topic_slug=slug,
            metadata={"slug": slug},
        )
        return

    for attempt in range(1, _MAX_RUN_ATTEMPTS + 1):
        try:
            log(
                "info",
                "schedule",
                f"_run_topic: starting run for {name!r} ({slug!r}) attempt {attempt}/{_MAX_RUN_ATTEMPTS}",
                topic_slug=slug,
                metadata={"slug": slug, "name": name, "attempt": attempt},
            )
            result = agent.generate_and_publish(f"Generate the {name} digest for today")
            log(
                "info",
                "schedule",
                f"_run_topic: finished {slug!r} attempt {attempt} — success={result.get('success')}",
                topic_slug=slug,
                metadata={"slug": slug, "result": result, "attempt": attempt},
            )
        except Exception as exc:  # noqa: BLE001 — failure isolation
            log(
                "error",
                "schedule",
                f"_run_topic: unhandled exception for {slug!r} attempt {attempt}: {exc.__class__.__name__}: {exc}",
                topic_slug=slug,
                metadata={
                    "slug": slug,
                    "error": str(exc),
                    "exc_type": exc.__class__.__name__,
                    "attempt": attempt,
                    "traceback": traceback.format_exc(),
                },
            )
            result = {"success": False, "error": exc.__class__.__name__}

        # Lemonade unreachable — retrying while the LLM is down is pointless.
        if result.get("error") == "lemonade_down":
            log(
                "warn",
                "schedule",
                f"_run_topic: {slug!r} skipping retries — lemonade_down",
                topic_slug=slug,
                metadata={"slug": slug, "attempt": attempt},
            )
            return

        # Verify that a digest row actually landed (GAIA returns status=success
        # even when the final turn was malformed and nothing was published).
        published = _is_published_today(slug)
        if published is None:
            # Verification read failed — trust the run's own publish result
            # (it reflects _publish_from_result's verified write) rather than
            # burning retries on a transient Supabase read blip.
            log(
                "warn",
                "schedule",
                f"_run_topic: {slug!r} publish verification skipped — Supabase read error; trusting run result",
                topic_slug=slug,
                metadata={
                    "slug": slug,
                    "attempt": attempt,
                    "run_success": result.get("success"),
                },
            )
            published = bool(result.get("success"))
        if published:
            return

        # Not published yet.
        if attempt < _MAX_RUN_ATTEMPTS:
            if _shutdown_event.is_set():
                log(
                    "info",
                    "schedule",
                    f"_run_topic: shutdown requested — stopping retries for {slug!r}",
                    topic_slug=slug,
                    metadata={"slug": slug, "attempt": attempt},
                )
                return
            log(
                "warn",
                "schedule",
                f"_run_topic: {slug!r} run finished without publishing, retrying {attempt + 1}/{_MAX_RUN_ATTEMPTS}",
                topic_slug=slug,
                metadata={
                    "slug": slug,
                    "attempt": attempt,
                    "next_attempt": attempt + 1,
                },
            )
        else:
            log(
                "error",
                "schedule",
                f"_run_topic: {slug!r} failed to publish after {_MAX_RUN_ATTEMPTS} attempts",
                topic_slug=slug,
                metadata={"slug": slug, "attempts": _MAX_RUN_ATTEMPTS},
            )


def run_cycle(agent: Any | None = None) -> None:
    """One scheduler tick: fetch topics, check due, run each due topic in turn.

    This function is the sole entry point that APScheduler calls every 15
    minutes.  It is also directly callable from tests (pass a mock agent).

    Args:
        agent: A ``NewsDigestAgent`` instance.  When ``None``, one is
            constructed lazily from the active ``Settings``.
    """
    cycle_start = datetime.now(UTC)
    log(
        "info",
        "schedule",
        f"run_cycle: tick at {cycle_start.isoformat()}",
        metadata={"tick_at": cycle_start.isoformat()},
    )

    # Fetch all topics — both enabled and disabled — so we can log disabled skips.
    try:
        resp = _client().table("digest_topics").select("*").execute()
        topics: list[dict[str, Any]] = resp.data or []
    except Exception as exc:  # noqa: BLE001
        log(
            "error",
            "schedule",
            f"run_cycle: could not fetch digest_topics: {exc.__class__.__name__}",
            metadata={"error": str(exc)},
        )
        return

    if not topics:
        log("info", "schedule", "run_cycle: no topics found; nothing to do")
        return

    # Lazy agent construction (deferred to avoid import-time model loading
    # in tests that construct the scheduler without a real environment).
    if agent is None:
        from news_digest.agent import NewsDigestAgent

        agent = NewsDigestAgent()

    due_slugs: list[str] = []
    skipped_disabled: list[str] = []

    for topic in topics:
        slug = topic.get("slug", "<unknown>")

        # Kill switch: skip disabled topics every tick.
        if not topic.get("enabled", False):
            skipped_disabled.append(slug)
            continue

        if _is_topic_due(topic, cycle_start):
            due_slugs.append(slug)

    if skipped_disabled:
        log(
            "info",
            "schedule",
            f"run_cycle: skipped disabled topics: {skipped_disabled}",
            metadata={"disabled": skipped_disabled},
        )

    if not due_slugs:
        log(
            "info",
            "schedule",
            "run_cycle: no topics due this cycle",
            metadata={"checked": [t.get("slug") for t in topics if t.get("enabled")]},
        )
        _log_cycle_end(cycle_start, due_slugs=[])
        return

    log(
        "info",
        "schedule",
        f"run_cycle: topics due this cycle: {due_slugs}",
        metadata={"due": due_slugs},
    )

    # Run due topics one at a time (max_instances=1 enforced by sequential loop).
    for topic in topics:
        if topic.get("slug") not in due_slugs:
            continue
        if _shutdown_event.is_set():
            log(
                "info",
                "schedule",
                "run_cycle: shutdown requested — aborting cycle early",
                metadata={
                    "remaining": [
                        t.get("slug") for t in topics if t.get("slug") in due_slugs
                    ]
                },
            )
            break
        _run_topic(topic, agent)

    _log_cycle_end(cycle_start, due_slugs=due_slugs)


def _log_cycle_end(cycle_start: datetime, due_slugs: list[str]) -> None:
    """Emit a schedule/cycle-end log entry with duration.

    Args:
        cycle_start: UTC datetime when this cycle began.
        due_slugs: Topics that were due (and triggered) this cycle.
    """
    duration_s = round((datetime.now(UTC) - cycle_start).total_seconds(), 1)
    log(
        "info",
        "schedule",
        f"run_cycle: cycle complete in {duration_s}s; ran {len(due_slugs)} topic(s)",
        metadata={"duration_s": duration_s, "ran_topics": due_slugs},
    )


def _install_signal_handlers(scheduler: BlockingScheduler) -> None:
    """Install SIGTERM/SIGINT handlers that shut the scheduler down cleanly.

    ``systemctl stop`` sends SIGTERM; without a handler the process dies
    mid-digest and systemd escalates to SIGKILL. The handler logs a
    ``schedule`` entry and calls ``scheduler.shutdown(wait=True)``, which
    waits for any in-flight job to finish and unblocks the
    ``BlockingScheduler`` main loop so the process exits normally.

    Args:
        scheduler: The scheduler instance to shut down on signal.
    """

    def _handle(signum: int, frame: Any) -> None:
        log(
            "info",
            "schedule",
            f"received {signal.Signals(signum).name} — shutting down cleanly",
            metadata={"signal": signal.Signals(signum).name},
        )
        _shutdown_event.set()
        scheduler.shutdown(wait=True)

    signal.signal(signal.SIGTERM, _handle)
    signal.signal(signal.SIGINT, _handle)


def run_purge_cycle() -> None:
    """Wrapper around ``purge_old_digests`` for use as an APScheduler job.

    Logs the start of the purge run and delegates to ``purge_old_digests``,
    which handles all errors internally and never raises.
    """
    log(
        "info",
        "retention",
        "run_purge_cycle: starting daily digest retention purge",
    )
    purge_old_digests()


def main() -> None:
    """Entry point for the scheduler daemon (runs via systemd).

    Starts a ``BlockingScheduler`` with a single interval job that calls
    ``run_cycle`` every 15 minutes.  Blocks the calling thread until the
    process receives SIGTERM/SIGINT, then shuts down cleanly (waiting for
    any in-flight digest run to finish).
    """
    scheduler = BlockingScheduler(timezone="UTC")
    # Overrun safety: APScheduler's default coalesce=True plus max_instances=1
    # self-throttles when a cycle (jitter + LLM runs) overruns the 15-minute
    # tick — missed ticks collapse into one and never run concurrently.
    scheduler.add_job(
        run_cycle,
        "interval",
        minutes=_TICK_MINUTES,
        id="digest_cycle",
        max_instances=1,
        replace_existing=True,
    )

    _settings = get_settings()
    scheduler.add_job(
        run_curator_cycle,
        "cron",
        hour=_settings.schedule_curator_hour,
        minute=_settings.schedule_curator_minute,
        id="source_curator",
        max_instances=1,
        replace_existing=True,
    )
    scheduler.add_job(
        run_purge_cycle,
        "cron",
        hour=_settings.schedule_retention_hour,
        minute=0,
        id="digest_retention",
        max_instances=1,
        replace_existing=True,
    )

    _install_signal_handlers(scheduler)

    log(
        "info",
        "schedule",
        f"scheduler started — tick every {_TICK_MINUTES} minutes (UTC); "
        f"retention purge daily at {_settings.schedule_retention_hour:02d}:00 UTC",
        metadata={
            "tick_minutes": _TICK_MINUTES,
            "retention_hour_utc": _settings.schedule_retention_hour,
            "retention_days": _settings.retention_days,
        },
    )

    # Fire one cycle immediately at startup so the first digest is not delayed
    # up to 15 minutes when the daemon (re-)starts. This call runs outside
    # APScheduler's executor protection, so guard it: an exception here (e.g.
    # NewsDigestAgent() init failing because Lemonade is down at boot) must not
    # kill the daemon before scheduler.start() — the next tick retries.
    try:
        run_cycle()
    except Exception as exc:  # noqa: BLE001 — startup must reach scheduler.start()
        log(
            "error",
            "schedule",
            f"startup run_cycle failed: {exc.__class__.__name__}: {exc}",
            metadata={"error": str(exc), "exc_type": exc.__class__.__name__},
        )

    scheduler.start()


if __name__ == "__main__":
    main()
