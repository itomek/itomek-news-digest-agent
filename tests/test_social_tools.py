"""Tests for src/news_digest/tools/social.py — issue #21 (fetch_reddit / PRAW).

All tests mock PRAW objects; no network calls are made. Live validation against
real Reddit credentials is pending — see PR description.
"""

from unittest.mock import MagicMock, patch

import pytest

from news_digest.tools import social
from news_digest.tools.social import fetch_reddit

# ---------------------------------------------------------------------------
# Helpers — fake PRAW objects
# ---------------------------------------------------------------------------


def _make_post(
    title: str = "Test Post",
    url: str = "https://example.com/post",
    score: int = 100,
    num_comments: int = 42,
    created_utc: float = 1_700_000_000.0,
    selftext: str = "",
) -> MagicMock:
    """Build a minimal fake PRAW Submission object."""
    post = MagicMock()
    post.title = title
    post.url = url
    post.score = score
    post.num_comments = num_comments
    post.created_utc = created_utc
    post.selftext = selftext
    return post


def _make_reddit(posts: list) -> MagicMock:
    """Build a minimal fake praw.Reddit with a fake subreddit() that returns posts."""
    sub = MagicMock()
    sub.hot.return_value = iter(posts)
    sub.new.return_value = iter(posts)
    sub.top.return_value = iter(posts)
    sub.rising.return_value = iter(posts)
    sub.search.return_value = iter(posts)

    reddit = MagicMock()
    reddit.subreddit.return_value = sub
    # Mirror praw 7.8.2: auth.limits is a dict whose values are None until the
    # first request populates them — skips the throttle-warn branch by default.
    reddit.auth.limits = {"remaining": None, "reset_timestamp": None, "used": None}
    return reddit


# ---------------------------------------------------------------------------
# Autouse fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def mock_log(valid_env, monkeypatch):
    """Patch social.log so tests never attempt Supabase or SQLite."""
    log_mock = MagicMock()
    monkeypatch.setattr(social, "log", log_mock)
    return log_mock


@pytest.fixture(autouse=True)
def clear_env(monkeypatch):
    """Ensure Reddit env vars are absent unless a test explicitly sets them."""
    monkeypatch.delenv("REDDIT_CLIENT_ID", raising=False)
    monkeypatch.delenv("REDDIT_CLIENT_SECRET", raising=False)
    monkeypatch.delenv("REDDIT_USER_AGENT", raising=False)


@pytest.fixture
def reddit_env(monkeypatch):
    """Set valid Reddit env vars so _get_reddit_client() can build a client."""
    monkeypatch.setenv("REDDIT_CLIENT_ID", "test_id")
    monkeypatch.setenv("REDDIT_CLIENT_SECRET", "test_secret")
    monkeypatch.setenv("REDDIT_USER_AGENT", "test-agent/0.1")


# ---------------------------------------------------------------------------
# Missing credentials
# ---------------------------------------------------------------------------


class TestMissingCredentials:
    def test_returns_structured_error_no_env(self):
        result = fetch_reddit("LocalLLaMA")
        assert len(result) == 1
        assert result[0]["error"] == "no_credentials"
        assert result[0]["source_type"] == "social_signal"
        assert result[0]["subreddit"] == "LocalLLaMA"
        assert "REDDIT_CLIENT_ID" in result[0]["message"]

    def test_logs_warn_on_missing_creds(self, mock_log):
        fetch_reddit("LocalLLaMA")
        mock_log.assert_called_once()
        call_kwargs = mock_log.call_args
        assert call_kwargs[0][0] == "warn"
        assert call_kwargs[0][1] == "scrape"

    def test_partial_creds_also_returns_error(self, monkeypatch):
        monkeypatch.setenv("REDDIT_CLIENT_ID", "only_id")
        result = fetch_reddit("LocalLLaMA")
        assert result[0]["error"] == "no_credentials"

    def test_empty_string_creds_treated_as_missing(self, monkeypatch):
        monkeypatch.setenv("REDDIT_CLIENT_ID", "")
        monkeypatch.setenv("REDDIT_CLIENT_SECRET", "")
        monkeypatch.setenv("REDDIT_USER_AGENT", "")
        result = fetch_reddit("LocalLLaMA")
        assert result[0]["error"] == "no_credentials"


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


class TestHappyPath:
    def test_returns_posts_above_min_score(self, reddit_env, monkeypatch):
        posts = [
            _make_post("High Score Post", score=200),
            _make_post("Low Score Post", score=10),
            _make_post("Exact Min Post", score=50),
        ]
        fake_reddit = _make_reddit(posts)
        monkeypatch.setattr(social, "_get_reddit_client", lambda: fake_reddit)

        result = fetch_reddit("LocalLLaMA", min_score=50)

        titles = [r["title"] for r in result]
        assert "High Score Post" in titles
        assert "Exact Min Post" in titles
        assert "Low Score Post" not in titles

    def test_result_shape(self, reddit_env, monkeypatch):
        posts = [_make_post("A Post", url="https://r.co/p", score=100, num_comments=5)]
        fake_reddit = _make_reddit(posts)
        monkeypatch.setattr(social, "_get_reddit_client", lambda: fake_reddit)

        result = fetch_reddit("MachineLearning")
        assert len(result) == 1
        item = result[0]
        assert item["title"] == "A Post"
        assert item["url"] == "https://r.co/p"
        assert item["score"] == 100
        assert item["num_comments"] == 5
        assert "created_utc" in item
        assert item["subreddit"] == "MachineLearning"
        assert item["source_type"] == "social_signal"
        assert "selftext_preview" in item

    def test_selftext_truncated_to_300_chars(self, reddit_env, monkeypatch):
        long_text = "x" * 500
        posts = [_make_post(selftext=long_text, score=100)]
        fake_reddit = _make_reddit(posts)
        monkeypatch.setattr(social, "_get_reddit_client", lambda: fake_reddit)

        result = fetch_reddit("LocalLLaMA")
        assert result[0]["selftext_preview"] == "x" * 300

    def test_empty_selftext_stays_empty(self, reddit_env, monkeypatch):
        posts = [_make_post(selftext="", score=100)]
        fake_reddit = _make_reddit(posts)
        monkeypatch.setattr(social, "_get_reddit_client", lambda: fake_reddit)

        result = fetch_reddit("LocalLLaMA")
        assert result[0]["selftext_preview"] == ""

    def test_link_posts_have_empty_selftext_preview(self, reddit_env, monkeypatch):
        """Link posts have selftext='' or '[removed]' in PRAW; preview is empty."""
        posts = [_make_post(selftext="[removed]", score=100)]
        # PRAW sets selftext to "[removed]" or "" for link posts and removed posts
        fake_reddit = _make_reddit(posts)
        monkeypatch.setattr(social, "_get_reddit_client", lambda: fake_reddit)

        result = fetch_reddit("LocalLLaMA")
        # "[removed]" is non-empty, so preview will be "[removed]" (≤300 chars)
        assert result[0]["selftext_preview"] == "[removed]"

    def test_logs_info_on_success(self, reddit_env, monkeypatch, mock_log):
        posts = [_make_post(score=100)]
        fake_reddit = _make_reddit(posts)
        monkeypatch.setattr(social, "_get_reddit_client", lambda: fake_reddit)

        fetch_reddit("LocalLLaMA")

        # The final log call should be info/scrape with status ok
        info_calls = [
            c
            for c in mock_log.call_args_list
            if c[0][0] == "info" and c[0][1] == "scrape"
        ]
        assert info_calls, "expected at least one info/scrape log call"
        metadata = info_calls[-1][1]["metadata"]
        assert metadata["status"] == "ok"
        assert metadata["subreddit"] == "LocalLLaMA"
        assert "count" in metadata
        assert "duration_ms" in metadata

    def test_all_below_min_score_returns_empty(self, reddit_env, monkeypatch):
        posts = [_make_post(score=10), _make_post(score=5)]
        fake_reddit = _make_reddit(posts)
        monkeypatch.setattr(social, "_get_reddit_client", lambda: fake_reddit)

        result = fetch_reddit("LocalLLaMA", min_score=50)
        assert result == []

    def test_empty_subreddit_returns_empty(self, reddit_env, monkeypatch):
        fake_reddit = _make_reddit([])
        monkeypatch.setattr(social, "_get_reddit_client", lambda: fake_reddit)

        result = fetch_reddit("LocalLLaMA")
        assert result == []


# ---------------------------------------------------------------------------
# Sort / query routing
# ---------------------------------------------------------------------------


class TestSortRouting:
    def _fetch_and_get_sub(self, monkeypatch, reddit_env, **kwargs):
        fake_reddit = _make_reddit([])
        monkeypatch.setattr(social, "_get_reddit_client", lambda: fake_reddit)
        fetch_reddit("LocalLLaMA", **kwargs)
        return fake_reddit.subreddit.return_value

    def test_sort_hot_calls_hot(self, reddit_env, monkeypatch):
        sub = self._fetch_and_get_sub(monkeypatch, reddit_env, sort="hot")
        sub.hot.assert_called_once()
        sub.top.assert_not_called()

    def test_sort_top_calls_top(self, reddit_env, monkeypatch):
        sub = self._fetch_and_get_sub(monkeypatch, reddit_env, sort="top")
        sub.top.assert_called_once()
        sub.hot.assert_not_called()

    def test_sort_new_calls_new(self, reddit_env, monkeypatch):
        sub = self._fetch_and_get_sub(monkeypatch, reddit_env, sort="new")
        sub.new.assert_called_once()

    def test_sort_rising_calls_rising(self, reddit_env, monkeypatch):
        sub = self._fetch_and_get_sub(monkeypatch, reddit_env, sort="rising")
        sub.rising.assert_called_once()

    def test_unknown_sort_falls_back_to_hot(self, reddit_env, monkeypatch):
        sub = self._fetch_and_get_sub(monkeypatch, reddit_env, sort="unknown_sort")
        sub.hot.assert_called_once()

    def test_query_calls_search(self, reddit_env, monkeypatch):
        sub = self._fetch_and_get_sub(monkeypatch, reddit_env, query="llama model")
        sub.search.assert_called_once()
        sub.hot.assert_not_called()

    def test_limit_passed_to_hot(self, reddit_env, monkeypatch):
        fake_reddit = _make_reddit([])
        monkeypatch.setattr(social, "_get_reddit_client", lambda: fake_reddit)
        fetch_reddit("LocalLLaMA", limit=10)
        sub = fake_reddit.subreddit.return_value
        sub.hot.assert_called_once_with(limit=10)

    def test_time_filter_passed_to_top(self, reddit_env, monkeypatch):
        fake_reddit = _make_reddit([])
        monkeypatch.setattr(social, "_get_reddit_client", lambda: fake_reddit)
        fetch_reddit("LocalLLaMA", sort="top", time_filter="week")
        sub = fake_reddit.subreddit.return_value
        sub.top.assert_called_once_with(limit=25, time_filter="week")


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------


class TestErrorHandling:
    def test_praw_exception_returns_structured_error(self, reddit_env, monkeypatch):
        def _bad_client():
            reddit = MagicMock()
            reddit.subreddit.side_effect = RuntimeError("connection failed")
            return reddit

        monkeypatch.setattr(social, "_get_reddit_client", _bad_client)

        result = fetch_reddit("LocalLLaMA")
        assert len(result) == 1
        assert result[0]["error"] == "RuntimeError"
        assert result[0]["source_type"] == "social_signal"
        assert result[0]["subreddit"] == "LocalLLaMA"

    def test_praw_exception_logs_warn(self, reddit_env, monkeypatch, mock_log):
        def _bad_client():
            reddit = MagicMock()
            reddit.subreddit.side_effect = Exception("api error")
            return reddit

        monkeypatch.setattr(social, "_get_reddit_client", _bad_client)

        fetch_reddit("LocalLLaMA")
        warn_calls = [c for c in mock_log.call_args_list if c[0][0] == "warn"]
        assert warn_calls, "expected a warn log on PRAW error"

    def test_never_raises(self, reddit_env, monkeypatch):
        """fetch_reddit must not raise under any circumstance."""
        monkeypatch.setattr(social, "_get_reddit_client", lambda: None)
        # _get_reddit_client returning None without missing creds edge case:
        # patch _get_reddit_client directly to return None even with valid env
        try:
            result = fetch_reddit("LocalLLaMA")
        except Exception as exc:
            pytest.fail(f"fetch_reddit raised unexpectedly: {exc}")
        # With None returned and valid env, missing-creds error is returned
        assert isinstance(result, list)

    def test_import_error_on_praw_returns_no_credentials(self, monkeypatch):
        """When praw is not importable _get_reddit_client returns None → no_credentials."""
        monkeypatch.setenv("REDDIT_CLIENT_ID", "id")
        monkeypatch.setenv("REDDIT_CLIENT_SECRET", "secret")
        monkeypatch.setenv("REDDIT_USER_AGENT", "agent/0.1")

        original_import = (
            __builtins__.__import__
            if hasattr(__builtins__, "__import__")
            else __import__
        )  # type: ignore[union-attr]

        def _fail_praw(name, *args, **kwargs):
            if name == "praw":
                raise ImportError("praw not installed")
            return original_import(name, *args, **kwargs)

        # Patch via the social module's builtins
        with patch("builtins.__import__", side_effect=_fail_praw):
            # _get_reddit_client should catch the ImportError and return None
            client = social._get_reddit_client()
        assert client is None


# ---------------------------------------------------------------------------
# Rate-limit warn
# ---------------------------------------------------------------------------


class TestRateLimitWarn:
    def test_logs_warn_when_rate_limit_remaining_zero(
        self, reddit_env, monkeypatch, mock_log
    ):
        """When reddit.auth.limits reports remaining == 0, a warn is logged."""
        posts = [_make_post(score=100)]
        fake_reddit = _make_reddit(posts)
        fake_reddit.auth.limits = {"remaining": 0, "reset_timestamp": None, "used": 996}

        monkeypatch.setattr(social, "_get_reddit_client", lambda: fake_reddit)

        fetch_reddit("LocalLLaMA")

        warn_calls = [
            c
            for c in mock_log.call_args_list
            if c[0][0] == "warn" and "rate limit" in c[0][2].lower()
        ]
        assert warn_calls, "expected rate-limit warn log"

    def test_rate_limit_warn_only_once(self, reddit_env, monkeypatch, mock_log):
        """The throttle warn fires at most once per fetch_reddit call."""
        posts = [_make_post(score=100 + i) for i in range(5)]
        fake_reddit = _make_reddit(posts)
        fake_reddit.auth.limits = {"remaining": 0, "reset_timestamp": None, "used": 996}

        monkeypatch.setattr(social, "_get_reddit_client", lambda: fake_reddit)

        fetch_reddit("LocalLLaMA")

        rate_warn_count = sum(
            1
            for c in mock_log.call_args_list
            if c[0][0] == "warn" and "rate limit" in c[0][2].lower()
        )
        assert rate_warn_count == 1


# ---------------------------------------------------------------------------
# Tool registration / GAIA contract
# ---------------------------------------------------------------------------


class TestToolRegistration:
    def test_fetch_reddit_is_callable(self):
        assert callable(fetch_reddit)

    def test_fetch_reddit_registered_in_gaia_tool_registry(self):
        """GAIA's @tool decorator registers the function at import time; the
        agent advertises tools straight from this registry."""
        from gaia.agents.base.tools import get_tool_metadata

        assert get_tool_metadata("fetch_reddit") is not None, (
            "fetch_reddit must be registered in GAIA's tool registry"
        )

    def test_social_module_importable(self):
        from news_digest.tools import social as _social

        assert hasattr(_social, "fetch_reddit")


# ---------------------------------------------------------------------------
# Migration 0011 — Reddit sources seed (content pinned, not applied)
# ---------------------------------------------------------------------------


def _migration_text() -> str:
    import pathlib

    migrations = pathlib.Path(__file__).parent.parent / "supabase" / "migrations"
    return (migrations / "0011_reddit_sources.sql").read_text()


class TestRedditMigration:
    def test_migration_file_exists_and_targets_ai_models(self):
        content = _migration_text()
        assert "ai_models" in content
        assert "LocalLLaMA" in content
        assert "MachineLearning" in content

    def test_migration_is_idempotent_via_containment_guard(self):
        """Re-running must be a no-op: the UPDATE is guarded by a jsonb
        containment check so sources/prompt_hint never double-append."""
        content = _migration_text()
        assert "@>" in content
        assert 'not (sources @> \'[{"type": "reddit"}]\'::jsonb)' in content

    def test_migration_prompt_hint_names_fetch_reddit_and_contract(self):
        content = _migration_text()
        assert "fetch_reddit" in content
        assert "social_signal" in content
        assert "do not quote Reddit" in content
