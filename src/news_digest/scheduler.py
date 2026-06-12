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
import time
from datetime import UTC, date, datetime, timedelta
from typing import Any

from apscheduler.schedulers.blocking import BlockingScheduler

from news_digest.logging import log
from news_digest.tools.publishing import get_last_digest_date
from supabase import Client

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
        log(
            "warn",
            "schedule",
            f"_is_topic_due: bad last_date {last_date_str!r} for {slug!r}; treating as due",
            topic_slug=slug,
            metadata={"slug": slug, "last_date": last_date_str},
        )
        return True

    # Compare last digest *date* (midnight UTC of that day) against now.
    last_datetime = datetime(last_date.year, last_date.month, last_date.day, tzinfo=UTC)
    return (now - last_datetime) >= cadence


def _run_topic(topic: dict[str, Any], agent: Any) -> None:
    """Execute a single topic run via the agent wrapper.

    Applies a 0–300 s random jitter before invoking
    ``agent.generate_and_publish``.  All exceptions are caught so one failing
    topic cannot stop the scheduler cycle.

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
    time.sleep(jitter)

    try:
        log(
            "info",
            "schedule",
            f"_run_topic: starting run for {name!r} ({slug!r})",
            topic_slug=slug,
            metadata={"slug": slug, "name": name},
        )
        result = agent.generate_and_publish(f"Generate the {name} digest for today")
        log(
            "info",
            "schedule",
            f"_run_topic: finished {slug!r} — success={result.get('success')}",
            topic_slug=slug,
            metadata={"slug": slug, "result": result},
        )
    except Exception as exc:  # noqa: BLE001 — failure isolation
        log(
            "error",
            "schedule",
            f"_run_topic: unhandled exception for {slug!r}: {exc.__class__.__name__}: {exc}",
            topic_slug=slug,
            metadata={
                "slug": slug,
                "error": str(exc),
                "exc_type": exc.__class__.__name__,
            },
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
        if topic.get("slug") in due_slugs:
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


def main() -> None:
    """Entry point for the scheduler daemon (runs via systemd).

    Starts a ``BlockingScheduler`` with a single interval job that calls
    ``run_cycle`` every 15 minutes.  Blocks the calling thread until the
    process is terminated.
    """
    scheduler = BlockingScheduler(timezone="UTC")
    scheduler.add_job(
        run_cycle,
        "interval",
        minutes=_TICK_MINUTES,
        id="digest_cycle",
        max_instances=1,
        replace_existing=True,
    )

    log(
        "info",
        "schedule",
        f"scheduler started — tick every {_TICK_MINUTES} minutes (UTC)",
        metadata={"tick_minutes": _TICK_MINUTES},
    )

    # Fire one cycle immediately at startup so the first digest is not delayed
    # up to 15 minutes when the daemon (re-)starts.
    run_cycle()

    scheduler.start()


if __name__ == "__main__":
    main()
