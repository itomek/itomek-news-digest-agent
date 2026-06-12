"""Tests for src/news_digest/curator.py — autonomous source curation (issue #98).

All tests are hermetic (no real network, no real Supabase, no real LLM).
Seams used:
  - curator._llm_complete: monkeypatched
  - news_digest.search.web_search: monkeypatched
  - curator._get_supabase_client: monkeypatched via MagicMock chain
  - curator.log: autouse monkeypatched
  - fetch_rss / fetch_html: monkeypatched directly
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock

import pytest

import news_digest.curator as curator
from news_digest.curator import (
    MIN_ATTEMPTS,
    MIN_FEED_ENTRIES,
    RELEVANCE_AUTO_USE,
    RELEVANCE_CANDIDATE,
    STALE_HOURS,
    STALE_SUCCESS_PCT,
    FailingSource,
    add_source,
    build_failing_sources,
    classify_failure,
    confidence_tier,
    is_stale,
    quarantine_source,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

NOW = datetime(2026, 6, 12, 12, 0, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def mock_log(monkeypatch):
    """Patch curator.log so no test touches Supabase/SQLite."""
    log_mock = MagicMock()
    monkeypatch.setattr(curator, "log", log_mock)
    return log_mock


@pytest.fixture(autouse=True)
def _valid_env(valid_env):
    return valid_env


def _make_health_row(
    source_url: str = "https://example.com/feed",
    success_7d: int = 0,
    failure_7d: int = 10,
    total_7d: int = 10,
    success_pct_7d: float | None = 0.0,
    last_success_at: datetime | None = None,
    last_error_at: datetime | None = None,
    last_error: str | None = "Connection reset",
) -> dict:
    return {
        "source_url": source_url,
        "success_7d": success_7d,
        "failure_7d": failure_7d,
        "total_7d": total_7d,
        "success_pct_7d": success_pct_7d,
        "last_success_at": last_success_at.isoformat() if last_success_at else None,
        "last_error_at": last_error_at.isoformat() if last_error_at else None,
        "last_error": last_error,
    }


def _make_topic(
    slug: str = "ai_models",
    name: str = "AI Models",
    cadence: str = "24h",
    sources: list[dict] | None = None,
) -> dict:
    if sources is None:
        sources = [{"type": "rss", "url": "https://example.com/feed"}]
    return {"slug": slug, "name": name, "cadence": cadence, "sources": sources}


def _make_client(
    *, health_rows=None, topics=None, pending_urls=None, cooldown_logs=None
):
    """Build a minimal mock Supabase client."""
    client = MagicMock()
    tbl = MagicMock()
    client.table.return_value = tbl
    tbl.select.return_value = tbl
    tbl.eq.return_value = tbl
    tbl.in_.return_value = tbl
    tbl.gte.return_value = tbl

    resp_health = MagicMock()
    resp_health.data = health_rows or []

    resp_topics = MagicMock()
    resp_topics.data = topics or []

    resp_pending = MagicMock()
    resp_pending.data = [{"url": u} for u in (pending_urls or [])]

    resp_cooldown = MagicMock()
    resp_cooldown.data = [
        {"metadata": {"source_url": u}} for u in (cooldown_logs or [])
    ]

    # Execute returns health by default; tests can override per scenario
    tbl.execute.return_value = resp_health

    return client, resp_health, resp_topics, resp_pending, resp_cooldown


# ---------------------------------------------------------------------------
# is_stale
# ---------------------------------------------------------------------------


class TestIsStale:
    def test_returns_true_when_success_pct_below_threshold(self):
        row = _make_health_row(
            total_7d=5,
            success_pct_7d=STALE_SUCCESS_PCT - 1,
            last_success_at=NOW - timedelta(hours=1),
        )
        assert is_stale(row, NOW) is True

    def test_returns_false_when_success_pct_at_threshold(self):
        row = _make_health_row(
            total_7d=5,
            success_pct_7d=STALE_SUCCESS_PCT,
            last_success_at=NOW - timedelta(hours=1),
        )
        # STALE_SUCCESS_PCT is strictly <50, so 50 is NOT stale
        assert is_stale(row, NOW) is False

    def test_returns_true_when_last_success_older_than_72h(self):
        row = _make_health_row(
            total_7d=10,
            success_pct_7d=80.0,
            last_success_at=NOW - timedelta(hours=STALE_HOURS + 1),
        )
        assert is_stale(row, NOW) is True

    def test_returns_false_when_last_success_recent(self):
        row = _make_health_row(
            total_7d=10,
            success_pct_7d=80.0,
            last_success_at=NOW - timedelta(hours=STALE_HOURS - 1),
        )
        assert is_stale(row, NOW) is False

    def test_returns_false_when_below_min_attempts(self):
        """Fewer than MIN_ATTEMPTS total fetches → not enough data → not stale."""
        row = _make_health_row(
            total_7d=MIN_ATTEMPTS - 1,
            success_pct_7d=0.0,
            last_success_at=None,
        )
        assert is_stale(row, NOW) is False

    def test_null_last_success_treated_as_very_stale(self):
        row = _make_health_row(
            total_7d=MIN_ATTEMPTS + 2,
            success_pct_7d=0.0,
            last_success_at=None,
        )
        assert is_stale(row, NOW) is True

    def test_null_success_pct_with_zero_successes_is_stale(self):
        row = _make_health_row(
            total_7d=MIN_ATTEMPTS + 2,
            success_7d=0,
            success_pct_7d=None,
            last_success_at=None,
        )
        assert is_stale(row, NOW) is True


# ---------------------------------------------------------------------------
# build_failing_sources
# ---------------------------------------------------------------------------


class TestBuildFailingSources:
    def test_maps_url_to_topic(self):
        url = "https://example.com/feed"
        topic = _make_topic(sources=[{"type": "rss", "url": url}])
        health = {
            url: _make_health_row(source_url=url, total_7d=10, success_pct_7d=0.0)
        }
        result = build_failing_sources([topic], health, NOW, set(), set())
        assert len(result) == 1
        assert result[0].url == url
        assert result[0].topic["slug"] == "ai_models"

    def test_reddit_sources_excluded(self):
        url = "https://reddit.com/r/artificial.rss"
        topic = _make_topic(sources=[{"type": "reddit", "url": url}])
        health = {
            url: _make_health_row(source_url=url, total_7d=10, success_pct_7d=0.0)
        }
        result = build_failing_sources([topic], health, NOW, set(), set())
        assert len(result) == 0

    def test_pending_urls_excluded(self):
        url = "https://stale.example/feed"
        topic = _make_topic(sources=[{"type": "rss", "url": url}])
        health = {
            url: _make_health_row(source_url=url, total_7d=10, success_pct_7d=0.0)
        }
        result = build_failing_sources([topic], health, NOW, {url}, set())
        assert len(result) == 0

    def test_cooldown_urls_excluded(self):
        url = "https://stale.example/feed"
        topic = _make_topic(sources=[{"type": "rss", "url": url}])
        health = {
            url: _make_health_row(source_url=url, total_7d=10, success_pct_7d=0.0)
        }
        result = build_failing_sources([topic], health, NOW, set(), {url})
        assert len(result) == 0

    def test_disabled_sources_excluded(self):
        url = "https://disabled.example/feed"
        topic = _make_topic(sources=[{"type": "rss", "url": url, "enabled": False}])
        health = {
            url: _make_health_row(source_url=url, total_7d=10, success_pct_7d=0.0)
        }
        result = build_failing_sources([topic], health, NOW, set(), set())
        assert len(result) == 0

    def test_healthy_source_not_failing(self):
        url = "https://healthy.example/feed"
        topic = _make_topic(sources=[{"type": "rss", "url": url}])
        health = {
            url: _make_health_row(
                source_url=url,
                total_7d=10,
                success_pct_7d=100.0,
                last_success_at=NOW - timedelta(hours=1),
            )
        }
        result = build_failing_sources([topic], health, NOW, set(), set())
        assert len(result) == 0

    def test_multiple_sources_multiple_topics(self):
        url1 = "https://stale1.example/feed"
        url2 = "https://stale2.example/feed"
        topic1 = _make_topic(slug="ai_models", sources=[{"type": "rss", "url": url1}])
        topic2 = _make_topic(
            slug="ai_updates",
            name="AI Updates",
            sources=[{"type": "rss", "url": url2}],
        )
        health = {
            url1: _make_health_row(source_url=url1, total_7d=10, success_pct_7d=0.0),
            url2: _make_health_row(source_url=url2, total_7d=10, success_pct_7d=0.0),
        }
        result = build_failing_sources([topic1, topic2], health, NOW, set(), set())
        assert len(result) == 2


# ---------------------------------------------------------------------------
# classify_failure
# ---------------------------------------------------------------------------


class TestClassifyFailure:
    @pytest.mark.parametrize(
        "error",
        [
            "NXDOMAIN",
            "DNS error",
            "blocked unsafe url",
            "HTTP 404 for https://x.com",
            "HTTP 410 for https://x.com",
            "Name or service not known",
        ],
    )
    def test_dead_signals(self, error):
        assert classify_failure(error) == "dead"

    @pytest.mark.parametrize(
        "error",
        [
            "HTTP 403 for https://x.com",
            "HTTP 429 for https://x.com",
            "timeout",
            "ReadTimeout",
            "Connection reset",
            "reset by peer",
        ],
    )
    def test_blocked_signals(self, error):
        assert classify_failure(error) == "blocked"

    def test_default_is_blocked(self):
        assert classify_failure("something unexpected") == "blocked"


# ---------------------------------------------------------------------------
# confidence_tier
# ---------------------------------------------------------------------------


class TestConfidenceTier:
    def _good_validation(self):
        return {
            "fetch_ok": True,
            "parseable": True,
            "recent": True,
            "type": "rss",
            "item_count": 5,
        }

    def test_auto_use_when_high_relevance(self):
        val = self._good_validation()
        assert confidence_tier(val, RELEVANCE_AUTO_USE) == "auto_use"

    def test_auto_use_just_at_threshold(self):
        val = self._good_validation()
        assert confidence_tier(val, RELEVANCE_AUTO_USE) == "auto_use"

    def test_candidate_when_mid_relevance(self):
        val = self._good_validation()
        mid = (RELEVANCE_AUTO_USE + RELEVANCE_CANDIDATE) / 2
        assert confidence_tier(val, mid) == "candidate"

    def test_reject_when_low_relevance(self):
        val = self._good_validation()
        assert confidence_tier(val, RELEVANCE_CANDIDATE - 0.01) == "reject"

    def test_reject_when_fetch_failed(self):
        val = {**self._good_validation(), "fetch_ok": False}
        assert confidence_tier(val, RELEVANCE_AUTO_USE) == "reject"

    def test_reject_when_not_parseable(self):
        val = {**self._good_validation(), "parseable": False}
        assert confidence_tier(val, RELEVANCE_AUTO_USE) == "reject"

    def test_reject_when_not_recent(self):
        val = {**self._good_validation(), "recent": False}
        assert confidence_tier(val, RELEVANCE_AUTO_USE) == "reject"

    def test_reject_at_exactly_candidate_threshold(self):
        val = self._good_validation()
        # Exactly at RELEVANCE_CANDIDATE → candidate (not reject)
        assert confidence_tier(val, RELEVANCE_CANDIDATE) == "candidate"


# ---------------------------------------------------------------------------
# quarantine_source
# ---------------------------------------------------------------------------


class TestQuarantineSource:
    def test_sets_enabled_false_and_reason(self):
        sources = [
            {"type": "rss", "url": "https://bad.example/feed"},
            {"type": "rss", "url": "https://good.example/feed"},
        ]
        topic = {"slug": "ai_models", "sources": sources}

        # Track update calls separately
        update_calls = []

        def make_chain(return_data):
            """Build a fluent chain that ends with execute() -> data."""
            chain = MagicMock()
            chain.select.return_value = chain
            chain.eq.return_value = chain
            chain.update.side_effect = lambda payload: _capture_update(
                payload, update_calls, chain
            )
            resp = MagicMock()
            resp.data = return_data
            chain.execute.return_value = resp
            return chain

        def _capture_update(payload, calls, chain):
            calls.append(payload)
            return chain

        client = MagicMock()
        chain = make_chain([dict(topic)])
        client.table.return_value = chain

        quarantine_source(topic, "https://bad.example/feed", "blocked", NOW, client)

        # Should have captured one update call
        assert len(update_calls) == 1
        updated_sources = update_calls[0]["sources"]
        bad = next(s for s in updated_sources if s["url"] == "https://bad.example/feed")
        good = next(
            s for s in updated_sources if s["url"] == "https://good.example/feed"
        )
        assert bad["enabled"] is False
        assert "disabled_reason" in bad
        assert good.get("enabled", True) is not False

    def test_never_strand_last_source(self, mock_log):
        """If disabling the source would leave 0 enabled sources, skip and warn."""
        sources = [{"type": "rss", "url": "https://only.example/feed"}]
        topic = {"slug": "ai_models", "sources": sources}

        client = MagicMock()

        quarantine_source(
            topic,
            "https://only.example/feed",
            "blocked",
            NOW,
            client,
            adding_replacement=False,
        )

        # Should NOT call update
        client.table.assert_not_called()
        # Should have logged a warning
        calls = [a for (a, _) in mock_log.call_args_list]
        assert any(a[0] == "warn" for a in calls)


# ---------------------------------------------------------------------------
# add_source
# ---------------------------------------------------------------------------


class TestAddSource:
    def test_appends_with_provenance(self):
        topic = {
            "slug": "ai_models",
            "sources": [{"type": "rss", "url": "https://old.example/feed"}],
        }

        update_calls = []

        def _cap(payload, chain):
            update_calls.append(payload)
            return chain

        chain = MagicMock()
        chain.select.return_value = chain
        chain.eq.return_value = chain
        chain.update.side_effect = lambda p: _cap(p, chain)
        resp = MagicMock()
        resp.data = [dict(topic)]
        chain.execute.return_value = resp

        client = MagicMock()
        client.table.return_value = chain

        new_obj = {
            "type": "rss",
            "url": "https://new.example/feed",
            "enabled": True,
            "added_by": "curator",
            "replaces": "https://old.example/feed",
            "discovered_at": NOW.isoformat(),
        }
        ok = add_source(topic, new_obj, client)

        assert ok is True
        assert len(update_calls) == 1
        updated_sources = update_calls[0]["sources"]
        urls = [s["url"] for s in updated_sources]
        assert "https://new.example/feed" in urls
        added = next(
            s for s in updated_sources if s["url"] == "https://new.example/feed"
        )
        assert added.get("added_by") == "curator"

    def test_returns_false_when_write_fails(self):
        """A failed Supabase write returns False (caller must be able to tell)."""
        topic = {
            "slug": "ai_models",
            "sources": [{"type": "rss", "url": "https://old.example/feed"}],
        }

        chain = MagicMock()
        chain.select.return_value = chain
        chain.eq.return_value = chain
        chain.update.return_value = chain
        # select().execute() returns the row; update().execute() raises.
        select_resp = MagicMock()
        select_resp.data = [dict(topic)]
        chain.execute.side_effect = [select_resp, RuntimeError("supabase write error")]

        client = MagicMock()
        client.table.return_value = chain

        ok = add_source(
            topic,
            {"type": "rss", "url": "https://new.example/feed", "added_by": "curator"},
            client,
        )
        assert ok is False


# ---------------------------------------------------------------------------
# run_curator_cycle — no-key guard
# ---------------------------------------------------------------------------


class TestRunCuratorCycleNoKey:
    def test_no_key_returns_no_op(self, monkeypatch, mock_log, valid_env):
        monkeypatch.setenv("PERPLEXITY_API_KEY", "")
        from news_digest.config import get_settings

        get_settings.cache_clear()

        result = curator.run_curator_cycle()

        assert result["auto_added"] == 0
        assert result["candidates_created"] == 0
        calls = [a for (a, _) in mock_log.call_args_list]
        assert any(a[1] == "curator" for a in calls)
        get_settings.cache_clear()


# ---------------------------------------------------------------------------
# run_curator_cycle — happy path end-to-end (all seams mocked)
# ---------------------------------------------------------------------------


class TestRunCuratorCycleHappyPath:
    def test_detects_quarantines_and_adds(self, monkeypatch, mock_log, valid_env):
        """One stale source → quarantine + auto-add from discovered replacement."""
        monkeypatch.setenv("PERPLEXITY_API_KEY", "pplx-test")
        from news_digest.config import get_settings

        get_settings.cache_clear()

        stale_url = "https://stale.amd.com/feed"
        new_url = "https://new.example.com/rss"
        topic_data = {
            "slug": "ai_models",
            "name": "AI Models",
            "cadence": "24h",
            "sources": [{"type": "rss", "url": stale_url}],
        }

        # Mock Supabase client
        client = MagicMock()
        tbl = MagicMock()
        client.table.return_value = tbl
        tbl.select.return_value = tbl
        tbl.eq.return_value = tbl
        tbl.gte.return_value = tbl
        tbl.update.return_value = tbl
        tbl.insert.return_value = tbl
        tbl.execute.return_value = MagicMock(data=[])

        # mv_source_health
        health_resp = MagicMock()
        health_resp.data = [
            _make_health_row(source_url=stale_url, total_7d=10, success_pct_7d=0.0)
        ]

        # digest_topics
        topics_resp = MagicMock()
        topics_resp.data = [topic_data]

        # pending candidates (empty)
        pending_resp = MagicMock()
        pending_resp.data = []

        # cooldown logs (empty)
        cooldown_resp = MagicMock()
        cooldown_resp.data = []

        call_count = [0]

        def multi_execute():
            n = call_count[0]
            call_count[0] += 1
            mapping = {
                0: health_resp,
                1: topics_resp,
                2: pending_resp,
                3: cooldown_resp,
            }
            return mapping.get(n, MagicMock(data=[]))

        tbl.execute.side_effect = lambda: multi_execute()

        monkeypatch.setattr(curator, "_get_supabase_client", lambda: client)

        # Mock LLM completions
        def fake_llm(messages):
            # For query crafting return a search query
            if any("craft" in str(m) or "search" in str(m).lower() for m in messages):
                return "AI models RSS feed site"
            # For relevance judgment return high score
            return "0.9"

        monkeypatch.setattr(curator, "_llm_complete", fake_llm)

        # Mock web_search
        monkeypatch.setattr(
            curator,
            "_web_search",
            lambda *a, **kw: [
                {"url": new_url, "title": "New AI RSS", "date": "2026-06-01"}
            ],
        )

        # Mock fetch_rss for validation
        good_items = [
            {
                "title": f"Item {i}",
                "url": f"https://new.example.com/{i}",
                "published": NOW.isoformat(),
            }
            for i in range(MIN_FEED_ENTRIES + 1)
        ]
        monkeypatch.setattr(curator, "_fetch_rss", lambda url, **kw: good_items)
        monkeypatch.setattr(
            curator, "_fetch_html", lambda url, **kw: {"content": "", "error": "unused"}
        )

        result = curator.run_curator_cycle()

        # Should have processed the stale source
        assert result["detected"] >= 1
        assert result["processed"] >= 1
        get_settings.cache_clear()


# ---------------------------------------------------------------------------
# auto_use path — strand guard on a failed replacement write
# ---------------------------------------------------------------------------


class TestAutoUseStrandGuard:
    def _setup_auto_use(self, monkeypatch, add_succeeds: bool):
        """Wire up _process_failing_source for the auto_use branch.

        Returns (fs, client, summary, quarantine_calls, add_calls).
        add_source is stubbed to return add_succeeds; quarantine_source is
        stubbed to record whether it was invoked.
        """
        stale_url = "https://stale.amd.com/feed"
        new_url = "https://new.example.com/rss"
        topic = {
            "slug": "ai_models",
            "name": "AI Models",
            "cadence": "24h",
            "sources": [{"type": "rss", "url": stale_url}],
        }
        fs = FailingSource(
            topic=topic,
            source_obj=topic["sources"][0],
            url=stale_url,
            type="rss",
            health_row=_make_health_row(source_url=stale_url),
            error="Connection reset",
        )

        client = MagicMock()

        # LLM: craft query + judge high relevance → auto_use tier
        monkeypatch.setattr(curator, "_llm_complete", lambda messages: "0.95")
        monkeypatch.setattr(
            curator,
            "_web_search",
            lambda *a, **kw: [
                {"url": new_url, "title": "New AI RSS", "date": "2026-06-01"}
            ],
        )
        # Validation passes (good RSS feed, recent items)
        good_items = [
            {
                "title": f"Item {i}",
                "url": f"{new_url}/{i}",
                "published": NOW.isoformat(),
            }
            for i in range(MIN_FEED_ENTRIES + 1)
        ]
        monkeypatch.setattr(curator, "_fetch_rss", lambda url, **kw: good_items)

        quarantine_calls = []
        add_calls = []

        def fake_quarantine(*a, **kw):
            quarantine_calls.append((a, kw))

        def fake_add(topic_arg, new_obj, client_arg):
            add_calls.append(new_obj)
            return add_succeeds

        monkeypatch.setattr(curator, "quarantine_source", fake_quarantine)
        monkeypatch.setattr(curator, "add_source", fake_add)

        summary = {
            "detected": 1,
            "processed": 0,
            "auto_added": 0,
            "candidates_created": 0,
            "rejected": 0,
            "alerts": [],
        }
        return fs, client, summary, quarantine_calls, add_calls

    def test_add_failure_does_not_quarantine_and_warns(self, monkeypatch, mock_log):
        """When add_source fails in auto_use, the failing source stays enabled.

        No quarantine, auto_added unchanged, and a warn is logged.
        """
        fs, client, summary, quarantine_calls, add_calls = self._setup_auto_use(
            monkeypatch, add_succeeds=False
        )

        curator._process_failing_source(fs, client, NOW, summary, 0, [fs.topic])

        # add was attempted, but the failing source was NOT quarantined
        assert len(add_calls) == 1
        assert quarantine_calls == []
        # auto_added must not have been incremented
        assert summary["auto_added"] == 0
        # a warning was logged about the failed replacement
        warns = [(a, k) for (a, k) in mock_log.call_args_list if a and a[0] == "warn"]
        assert any("replacement add failed" in a[2] for (a, k) in warns if len(a) >= 3)

    def test_add_success_quarantines_and_increments(self, monkeypatch, mock_log):
        """When add_source succeeds in auto_use, quarantine fires and auto_added++."""
        fs, client, summary, quarantine_calls, add_calls = self._setup_auto_use(
            monkeypatch, add_succeeds=True
        )

        curator._process_failing_source(fs, client, NOW, summary, 0, [fs.topic])

        assert len(add_calls) == 1
        assert len(quarantine_calls) == 1
        # quarantine was called with adding_replacement=True
        _, q_kwargs = quarantine_calls[0]
        assert q_kwargs.get("adding_replacement") is True
        assert summary["auto_added"] == 1


# ---------------------------------------------------------------------------
# Honest UA guard
# ---------------------------------------------------------------------------


def test_honest_user_agent_unchanged():
    """AC #3: scraping._USER_AGENT must remain the honest bot UA."""
    from news_digest.tools import scraping

    expected = (
        "news-digest-agent/0.1 (+https://github.com/itomek/itomek-news-digest-agent)"
    )
    assert scraping._USER_AGENT == expected
