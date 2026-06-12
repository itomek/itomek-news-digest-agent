"""Tests for src/news_digest/scheduler.py — issue #13, #44.

Tests are hermetic: no real APScheduler sleeps, no network.  Due-check logic,
kill-switch behaviour, per-topic failure isolation, cycle logging, and
retry-until-published (#44) are all tested by calling ``run_cycle`` and the
helper functions directly.
"""

import signal
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest

from news_digest import scheduler as sched_module
from news_digest.scheduler import (
    _install_signal_handlers,
    _is_published_today,
    _is_topic_due,
    _parse_cadence,
    _run_topic,
    run_cycle,
)
from news_digest.scheduler import (
    main as sched_main,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _silence_log(monkeypatch):
    """Capture log calls without touching Supabase or SQLite."""
    calls = []
    monkeypatch.setattr(sched_module, "log", lambda *a, **k: calls.append((a, k)))
    return calls


@pytest.fixture()
def log_calls(_silence_log):
    """Expose captured log calls to individual tests."""
    return _silence_log


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    """Skip actual jitter sleeps so tests run at full speed."""
    monkeypatch.setattr(sched_module.time, "sleep", lambda _: None)


@pytest.fixture(autouse=True)
def _assume_published(monkeypatch):
    """Default: treat every run as published so existing tests are unaffected.

    Retry-specific tests override this by patching _is_published_today directly.
    """
    monkeypatch.setattr(sched_module, "_is_published_today", lambda slug: True)


# ---------------------------------------------------------------------------
# _parse_cadence
# ---------------------------------------------------------------------------


def test_parse_cadence_24h():
    assert _parse_cadence("24h") == timedelta(hours=24)


def test_parse_cadence_7d():
    assert _parse_cadence("7d") == timedelta(days=7)


def test_parse_cadence_unknown_returns_none():
    assert _parse_cadence("monthly") is None
    assert _parse_cadence("") is None
    assert _parse_cadence("48h") is None


# ---------------------------------------------------------------------------
# _is_topic_due — due-check logic
# ---------------------------------------------------------------------------


@pytest.fixture()
def _patch_last_date(monkeypatch):
    """Factory: monkeypatch get_last_digest_date to return a given date string."""

    def _set(last_date_str: str | None):
        monkeypatch.setattr(
            sched_module,
            "get_last_digest_date",
            lambda slug: {"last_date": last_date_str},
        )

    return _set


_NOW = datetime(2026, 6, 11, 10, 0, 0, tzinfo=UTC)


def test_is_due_when_never_published(_patch_last_date):
    """A topic with no prior digest is always due."""
    _patch_last_date(None)
    topic = {"slug": "ai_models", "cadence": "24h"}
    assert _is_topic_due(topic, _NOW) is True


def test_is_due_24h_after_yesterday(_patch_last_date):
    """24h cadence: due if last digest was yesterday."""
    _patch_last_date("2026-06-10")
    topic = {"slug": "ai_models", "cadence": "24h"}
    assert _is_topic_due(topic, _NOW) is True


def test_not_due_24h_same_day(_patch_last_date):
    """24h cadence: not due if last digest was today (less than 24h ago)."""
    _patch_last_date("2026-06-11")
    topic = {"slug": "ai_models", "cadence": "24h"}
    assert _is_topic_due(topic, _NOW) is False


def test_is_due_7d_after_7_days(_patch_last_date):
    """7d cadence: due if last digest was 7 days ago."""
    _patch_last_date("2026-06-04")
    topic = {"slug": "penguins", "cadence": "7d"}
    assert _is_topic_due(topic, _NOW) is True


def test_not_due_7d_within_week(_patch_last_date):
    """7d cadence: not due if last digest was 3 days ago."""
    _patch_last_date("2026-06-08")
    topic = {"slug": "penguins", "cadence": "7d"}
    assert _is_topic_due(topic, _NOW) is False


def test_is_due_7d_exactly_at_boundary(_patch_last_date):
    """7d cadence: due exactly at the 7-day boundary."""
    # now = 2026-06-11 10:00 UTC; last = 2026-06-04 → 7 days exactly
    _patch_last_date("2026-06-04")
    topic = {"slug": "local_news", "cadence": "7d"}
    assert _is_topic_due(topic, _NOW) is True


def test_is_due_unknown_cadence_returns_false(_patch_last_date, log_calls):
    """Unknown cadence is logged as warn and treated as not-due."""
    _patch_last_date("2026-06-01")
    topic = {"slug": "mystery", "cadence": "monthly"}
    assert _is_topic_due(topic, _NOW) is False
    # A warn log must have been emitted
    levels = [a[0] for (a, _) in log_calls]
    assert "warn" in levels


def test_is_due_bad_last_date_format_warns_and_skips(_patch_last_date, log_calls):
    """Malformed last_date is a bug signal: warn and skip, never treat as due.

    Treating it as due would re-trigger the LLM every 15 minutes for as long
    as the bad value persists.
    """
    _patch_last_date("not-a-date")
    topic = {"slug": "ai_models", "cadence": "24h"}
    assert _is_topic_due(topic, _NOW) is False
    levels = [a[0] for (a, _) in log_calls]
    assert "warn" in levels


# ---------------------------------------------------------------------------
# run_cycle — integration of the full tick
# ---------------------------------------------------------------------------


def _make_client(topics: list[dict], *, raise_on_fetch: Exception | None = None):
    """Build a mock Supabase client that returns the given topics list."""
    client = MagicMock()
    tbl = MagicMock()
    client.table.return_value = tbl
    tbl.select.return_value = tbl
    tbl.eq.return_value = tbl
    if raise_on_fetch:
        tbl.execute.side_effect = raise_on_fetch
    else:
        resp = MagicMock()
        resp.data = topics
        tbl.execute.return_value = resp
    return client


def _make_agent(return_value: dict | None = None):
    agent = MagicMock()
    agent.generate_and_publish.return_value = return_value or {
        "success": True,
        "id": "x",
        "digest_date": "2026-06-11",
    }
    return agent


@pytest.fixture()
def _patch_last_date_fn(monkeypatch):
    """Patch get_last_digest_date in the scheduler module."""

    def _set(last_date_str: str | None):
        monkeypatch.setattr(
            sched_module,
            "get_last_digest_date",
            lambda slug: {"last_date": last_date_str},
        )

    return _set


# Kill switch: disabled topics are never run
def test_kill_switch_skips_disabled_topic(monkeypatch, log_calls, _patch_last_date_fn):
    """Topics with enabled=False are skipped even if they are past due."""
    _patch_last_date_fn(None)  # would be due
    topics = [
        {"slug": "ai_models", "name": "AI Models", "cadence": "24h", "enabled": False}
    ]
    client = _make_client(topics)
    agent = _make_agent()

    with patch("news_digest.scheduler._client", return_value=client):
        run_cycle(agent=agent)

    agent.generate_and_publish.assert_not_called()
    # Disabled skip must be logged
    messages = [a[2] for (a, _) in log_calls if a[0] == "info"]
    assert any("disabled" in m for m in messages)


# Due topics are run
def test_due_topic_is_triggered(monkeypatch, _patch_last_date_fn, log_calls):
    """A topic that is enabled and past cadence triggers generate_and_publish."""
    _patch_last_date_fn("2026-06-09")  # 2 days ago → due for 24h
    topics = [
        {"slug": "ai_models", "name": "AI Models", "cadence": "24h", "enabled": True}
    ]
    client = _make_client(topics)
    agent = _make_agent()

    with patch("news_digest.scheduler._client", return_value=client):
        run_cycle(agent=agent)

    agent.generate_and_publish.assert_called_once()
    query_arg = agent.generate_and_publish.call_args[0][0]
    assert "AI Models" in query_arg


# Not-due topics are not run
def test_not_due_topic_is_not_triggered(monkeypatch, _patch_last_date_fn):
    """A topic that ran recently (within cadence) is not re-triggered."""
    # Use a fixed "now" so the test is independent of real wall-clock time.
    fixed_now = datetime(2026, 6, 11, 10, 0, 0, tzinfo=UTC)
    # Last digest 2h ago (same day, well within 24h cadence) → not due.
    _patch_last_date_fn("2026-06-11")
    topics = [
        {"slug": "ai_models", "name": "AI Models", "cadence": "24h", "enabled": True}
    ]
    client = _make_client(topics)
    agent = _make_agent()

    with (
        patch("news_digest.scheduler._client", return_value=client),
        patch("news_digest.scheduler.datetime") as mock_dt,
    ):
        mock_dt.now.return_value = fixed_now
        mock_dt.side_effect = lambda *a, **k: datetime(*a, **k)
        run_cycle(agent=agent)

    agent.generate_and_publish.assert_not_called()


# Per-topic failure isolation: one crash does not stop others
def test_failure_isolation_continues_after_crash(
    monkeypatch, _patch_last_date_fn, log_calls
):
    """An exception from one topic's run does not stop the remaining topics."""
    _patch_last_date_fn(None)  # both due
    topics = [
        {"slug": "ai_models", "name": "AI Models", "cadence": "24h", "enabled": True},
        {"slug": "ai_updates", "name": "AI Updates", "cadence": "24h", "enabled": True},
    ]
    client = _make_client(topics)
    agent = MagicMock()
    # First call raises, second succeeds.
    agent.generate_and_publish.side_effect = [RuntimeError("boom"), {"success": True}]

    with patch("news_digest.scheduler._client", return_value=client):
        run_cycle(agent=agent)

    # Both topics were attempted despite the first crash.
    assert agent.generate_and_publish.call_count == 2
    # The crash must have been logged as an error.
    errors = [(a, k) for (a, k) in log_calls if a[0] == "error"]
    assert any("boom" in a[2] or "unhandled exception" in a[2] for (a, k) in errors)


# Cycle start and end are logged with category="schedule"
def test_cycle_start_and_end_are_logged(monkeypatch, _patch_last_date_fn, log_calls):
    """Each cycle emits schedule-category logs at start and end."""
    _patch_last_date_fn("2026-06-11")  # not due — shortest path through the cycle
    topics = [
        {"slug": "ai_models", "name": "AI Models", "cadence": "24h", "enabled": True}
    ]
    client = _make_client(topics)
    agent = _make_agent()

    with patch("news_digest.scheduler._client", return_value=client):
        run_cycle(agent=agent)

    # log() positional signature: (level, category, message, ...)
    categories_positional = [a[1] for (a, _) in log_calls if len(a) >= 2]
    assert categories_positional.count("schedule") >= 2  # at least start + end


# Supabase failure on topic fetch is handled gracefully
def test_supabase_fetch_failure_is_handled(monkeypatch, log_calls):
    """When Supabase is unreachable at cycle start, log an error and return."""
    client = _make_client([], raise_on_fetch=ConnectionError("refused"))
    agent = _make_agent()

    with patch("news_digest.scheduler._client", return_value=client):
        run_cycle(agent=agent)

    agent.generate_and_publish.assert_not_called()
    errors = [a for (a, _) in log_calls if a[0] == "error"]
    assert any("digest_topics" in a[2] or "could not fetch" in a[2] for a in errors)


# Multiple topics: only due ones are triggered
def test_mixed_topics_only_due_ones_run(monkeypatch, log_calls):
    """With a mix of due and not-due topics, only the due ones are triggered."""
    # Fixed "now" so the test never drifts with the real wall clock.
    fixed_now = datetime(2026, 6, 11, 10, 0, 0, tzinfo=UTC)

    # ai_models: last digest yesterday → due
    # penguins: last digest 3 days ago with 7d cadence → not due
    def _last_date(slug):
        if slug == "ai_models":
            return {"last_date": "2026-06-10"}
        return {"last_date": "2026-06-08"}

    monkeypatch.setattr(sched_module, "get_last_digest_date", _last_date)
    topics = [
        {"slug": "ai_models", "name": "AI Models", "cadence": "24h", "enabled": True},
        {
            "slug": "penguins",
            "name": "Pittsburgh Penguins",
            "cadence": "7d",
            "enabled": True,
        },
    ]
    client = _make_client(topics)
    agent = _make_agent()

    with (
        patch("news_digest.scheduler._client", return_value=client),
        patch("news_digest.scheduler.datetime") as mock_dt,
    ):
        mock_dt.now.return_value = fixed_now
        mock_dt.side_effect = lambda *a, **k: datetime(*a, **k)
        run_cycle(agent=agent)

    assert agent.generate_and_publish.call_count == 1
    query_arg = agent.generate_and_publish.call_args[0][0]
    assert "AI Models" in query_arg


# Empty topic list produces no errors and logs correctly
def test_empty_topic_list_is_handled(monkeypatch, log_calls):
    """When digest_topics is empty the cycle completes cleanly."""
    client = _make_client([])
    agent = _make_agent()

    with patch("news_digest.scheduler._client", return_value=client):
        run_cycle(agent=agent)

    agent.generate_and_publish.assert_not_called()
    infos = [a[2] for (a, _) in log_calls if a[0] == "info"]
    assert any("no topics" in m.lower() for m in infos)


# ---------------------------------------------------------------------------
# main() — clean shutdown and startup-cycle guard
# ---------------------------------------------------------------------------


def test_signal_handlers_installed_for_sigterm_and_sigint(monkeypatch):
    """_install_signal_handlers registers handlers for SIGTERM and SIGINT."""
    registered: dict[int, object] = {}
    monkeypatch.setattr(
        sched_module.signal,
        "signal",
        lambda signum, handler: registered.setdefault(signum, handler),
    )

    scheduler = MagicMock()
    _install_signal_handlers(scheduler)

    assert signal.SIGTERM in registered
    assert signal.SIGINT in registered
    # Both signals route to the same handler.
    assert registered[signal.SIGTERM] is registered[signal.SIGINT]


def test_signal_handler_logs_and_shuts_down_cleanly(monkeypatch, log_calls):
    """The installed handler logs a schedule entry and calls shutdown(wait=True)."""
    registered: dict[int, object] = {}
    monkeypatch.setattr(
        sched_module.signal,
        "signal",
        lambda signum, handler: registered.setdefault(signum, handler),
    )

    scheduler = MagicMock()
    _install_signal_handlers(scheduler)

    registered[signal.SIGTERM](signal.SIGTERM, None)

    scheduler.shutdown.assert_called_once_with(wait=True)
    schedule_logs = [(a, k) for (a, k) in log_calls if a[1] == "schedule"]
    assert any("SIGTERM" in a[2] for (a, _) in schedule_logs)


def test_main_survives_startup_run_cycle_failure(monkeypatch, log_calls):
    """A crash in the synchronous startup run_cycle must not kill the daemon.

    The startup call runs outside APScheduler's executor protection; an
    exception there (e.g. agent init failing because Lemonade is down at boot)
    must be logged and the process must still reach scheduler.start().
    """
    fake_scheduler = MagicMock()
    monkeypatch.setattr(
        sched_module, "BlockingScheduler", lambda *a, **k: fake_scheduler
    )
    # Don't install real handlers into the test process.
    monkeypatch.setattr(sched_module, "_install_signal_handlers", lambda s: None)
    monkeypatch.setattr(
        sched_module,
        "run_cycle",
        MagicMock(side_effect=RuntimeError("lemonade down at boot")),
    )

    sched_main()

    fake_scheduler.start.assert_called_once()
    errors = [a for (a, _) in log_calls if a[0] == "error"]
    assert any("startup run_cycle failed" in a[2] for a in errors)


def test_main_registers_interval_job_with_max_instances_one(monkeypatch):
    """main() adds the 15-minute interval job with max_instances=1."""
    fake_scheduler = MagicMock()
    monkeypatch.setattr(
        sched_module, "BlockingScheduler", lambda *a, **k: fake_scheduler
    )
    monkeypatch.setattr(sched_module, "_install_signal_handlers", lambda s: None)
    monkeypatch.setattr(sched_module, "run_cycle", MagicMock())

    sched_main()

    fake_scheduler.add_job.assert_called_once()
    _, kwargs = fake_scheduler.add_job.call_args
    assert kwargs["minutes"] == 15
    assert kwargs["max_instances"] == 1


# ---------------------------------------------------------------------------
# _is_published_today — verification helper (issue #44)
# ---------------------------------------------------------------------------


def test_is_published_today_returns_true_when_date_matches_today(monkeypatch):
    """Returns True when last_date equals today's UTC date."""
    today_iso = datetime.now(UTC).date().isoformat()
    monkeypatch.setattr(
        sched_module,
        "get_last_digest_date",
        lambda slug: {"last_date": today_iso},
    )
    assert _is_published_today("ai_models") is True


def test_is_published_today_returns_false_when_date_is_yesterday(monkeypatch):
    """Returns False when last_date is before today."""
    from datetime import timedelta

    yesterday_iso = (datetime.now(UTC).date() - timedelta(days=1)).isoformat()
    monkeypatch.setattr(
        sched_module,
        "get_last_digest_date",
        lambda slug: {"last_date": yesterday_iso},
    )
    assert _is_published_today("ai_models") is False


def test_is_published_today_returns_false_when_no_prior_digest(monkeypatch):
    """Returns False when no digest has ever been published."""
    monkeypatch.setattr(
        sched_module,
        "get_last_digest_date",
        lambda slug: {"last_date": None},
    )
    assert _is_published_today("ai_models") is False


def test_is_published_today_returns_false_on_bad_date_format(monkeypatch):
    """Returns False (not an exception) when the stored date is malformed."""
    monkeypatch.setattr(
        sched_module,
        "get_last_digest_date",
        lambda slug: {"last_date": "not-a-date"},
    )
    assert _is_published_today("ai_models") is False


# ---------------------------------------------------------------------------
# _run_topic retry loop — issue #44
# ---------------------------------------------------------------------------


@pytest.fixture()
def _patch_not_published(monkeypatch):
    """Make _is_published_today always return False (digest never landed)."""
    monkeypatch.setattr(sched_module, "_is_published_today", lambda slug: False)


@pytest.fixture()
def _patch_published(monkeypatch):
    """Make _is_published_today always return True (digest confirmed)."""
    monkeypatch.setattr(sched_module, "_is_published_today", lambda slug: True)


def _topic_row(slug: str = "ai_models") -> dict:
    return {"slug": slug, "name": "AI Models", "cadence": "24h", "enabled": True}


def test_run_topic_succeeds_first_attempt_no_retry(
    monkeypatch, log_calls, _patch_published
):
    """When the digest is confirmed on the first attempt, no retry happens."""
    agent = MagicMock()
    agent.generate_and_publish.return_value = {
        "success": True,
        "id": "x",
        "digest_date": "2026-06-11",
    }
    _run_topic(_topic_row(), agent)
    assert agent.generate_and_publish.call_count == 1


def test_run_topic_retries_when_not_published_on_first_attempt(monkeypatch, log_calls):
    """When the first attempt produces no publish, it retries and succeeds on the second."""
    # First call: not published; second call: published.
    published_state = {"published": False}

    def _is_pub(slug):
        result = published_state["published"]
        published_state["published"] = True  # flip after first check
        return result

    monkeypatch.setattr(sched_module, "_is_published_today", _is_pub)

    agent = MagicMock()
    agent.generate_and_publish.return_value = {"success": True}

    _run_topic(_topic_row(), agent)

    assert agent.generate_and_publish.call_count == 2
    # A warn log must have been emitted for the retry.
    warns = [a for (a, _) in log_calls if a[0] == "warn"]
    assert any("retrying" in a[2] for a in warns)


def test_run_topic_gives_up_after_max_attempts_and_logs_error(
    monkeypatch, log_calls, _patch_not_published
):
    """After _MAX_RUN_ATTEMPTS failures, an error is logged (not success)."""
    from news_digest.scheduler import _MAX_RUN_ATTEMPTS

    agent = MagicMock()
    agent.generate_and_publish.return_value = {"success": False, "error": "parse_error"}

    _run_topic(_topic_row(), agent)

    assert agent.generate_and_publish.call_count == _MAX_RUN_ATTEMPTS
    errors = [a for (a, _) in log_calls if a[0] == "error"]
    assert any("failed to publish" in a[2] for a in errors)


def test_run_topic_skips_retry_on_lemonade_down(
    monkeypatch, log_calls, _patch_not_published
):
    """When generate_and_publish returns lemonade_down, no retry is attempted."""
    agent = MagicMock()
    agent.generate_and_publish.return_value = {
        "success": False,
        "error": "lemonade_down",
    }

    _run_topic(_topic_row(), agent)

    assert agent.generate_and_publish.call_count == 1
    warns = [a for (a, _) in log_calls if a[0] == "warn"]
    assert any("lemonade_down" in a[2] for a in warns)


def test_run_topic_exception_is_treated_as_unpublished_and_retried(
    monkeypatch, log_calls, _patch_not_published
):
    """An unexpected exception from generate_and_publish is caught; the retry loop continues."""
    from news_digest.scheduler import _MAX_RUN_ATTEMPTS

    agent = MagicMock()
    agent.generate_and_publish.side_effect = RuntimeError("unexpected crash")

    _run_topic(_topic_row(), agent)

    assert agent.generate_and_publish.call_count == _MAX_RUN_ATTEMPTS
    errors = [a for (a, _) in log_calls if a[0] == "error"]
    # At least one error per exception + one final "failed to publish" error.
    assert len(errors) >= _MAX_RUN_ATTEMPTS
