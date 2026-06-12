"""Tests for src/news_digest/search.py — Perplexity web search client.

Uses httpx.MockTransport patched via _make_client (same pattern as
test_scraping_tools.py). All tests are hermetic and offline.
"""

import json

import httpx
import pytest

from news_digest import search


@pytest.fixture(autouse=True)
def _valid_env(valid_env):
    """Ensure a clean settings env for every test."""
    return valid_env


def _make_transport(
    status: int,
    body: dict | None = None,
    text: str | None = None,
) -> httpx.MockTransport:
    raw = (text or json.dumps(body or {})).encode()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, content=raw)

    return httpx.MockTransport(handler)


def _patch_search_client(monkeypatch, transport: httpx.MockTransport):
    """Replace search._make_client with one that injects the mock transport."""
    real_make = search._make_client

    def _patched(transport=None):  # noqa: ARG001 — shadows param intentionally
        return real_make(transport=transport)

    # wrap to always inject our transport
    monkeypatch.setattr(
        search,
        "_make_client",
        lambda **_: real_make(transport=transport),
    )


# ---------------------------------------------------------------------------
# Empty key → return []
# ---------------------------------------------------------------------------


def test_empty_key_returns_empty(monkeypatch, valid_env):
    monkeypatch.setenv("PERPLEXITY_API_KEY", "")
    from news_digest.config import get_settings

    get_settings.cache_clear()
    result = search.web_search("test query")
    assert result == []
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# Parses search_results (preferred path)
# ---------------------------------------------------------------------------


def test_parses_search_results(monkeypatch, valid_env):
    monkeypatch.setenv("PERPLEXITY_API_KEY", "pplx-test")
    from news_digest.config import get_settings

    get_settings.cache_clear()

    body = {
        "search_results": [
            {"title": "Title A", "url": "https://a.example/feed", "date": "2026-06-01"},
            {"title": "Title B", "url": "https://b.example/feed", "date": "2026-06-02"},
        ]
    }
    transport = _make_transport(200, body)
    _patch_search_client(monkeypatch, transport)

    result = search.web_search("AI news RSS feeds")
    assert len(result) == 2
    assert result[0]["url"] == "https://a.example/feed"
    assert result[0]["title"] == "Title A"
    assert result[1]["url"] == "https://b.example/feed"
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# Falls back to citations when search_results absent
# ---------------------------------------------------------------------------


def test_falls_back_to_citations(monkeypatch, valid_env):
    monkeypatch.setenv("PERPLEXITY_API_KEY", "pplx-test")
    from news_digest.config import get_settings

    get_settings.cache_clear()

    body = {
        "citations": [
            "https://c.example/feed",
            "https://d.example/rss",
        ]
    }
    transport = _make_transport(200, body)
    _patch_search_client(monkeypatch, transport)

    result = search.web_search("local news feeds")
    assert len(result) == 2
    assert result[0]["url"] == "https://c.example/feed"
    assert result[0]["title"] is None
    assert result[0]["date"] is None
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# Deduplicate results (preserve order)
# ---------------------------------------------------------------------------


def test_deduplicates_results(monkeypatch, valid_env):
    monkeypatch.setenv("PERPLEXITY_API_KEY", "pplx-test")
    from news_digest.config import get_settings

    get_settings.cache_clear()

    body = {
        "search_results": [
            {"title": "A", "url": "https://dup.example/feed", "date": "2026-06-01"},
            {
                "title": "B",
                "url": "https://dup.example/feed",
                "date": "2026-06-01",
            },  # dup
            {"title": "C", "url": "https://unique.example/feed", "date": "2026-06-02"},
        ]
    }
    transport = _make_transport(200, body)
    _patch_search_client(monkeypatch, transport)

    result = search.web_search("news")
    # Only 2 unique URLs
    urls = [r["url"] for r in result]
    assert len(urls) == len(set(urls))
    assert "https://dup.example/feed" in urls
    assert "https://unique.example/feed" in urls
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# Truncate to max_results
# ---------------------------------------------------------------------------


def test_truncates_to_max_results(monkeypatch, valid_env):
    monkeypatch.setenv("PERPLEXITY_API_KEY", "pplx-test")
    from news_digest.config import get_settings

    get_settings.cache_clear()

    body = {
        "search_results": [
            {
                "title": f"Title {i}",
                "url": f"https://example{i}.com/feed",
                "date": "2026-06-01",
            }
            for i in range(20)
        ]
    }
    transport = _make_transport(200, body)
    _patch_search_client(monkeypatch, transport)

    result = search.web_search("news", max_results=5)
    assert len(result) == 5
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# 401 → SearchError
# ---------------------------------------------------------------------------


def test_401_raises_search_error(monkeypatch, valid_env):
    monkeypatch.setenv("PERPLEXITY_API_KEY", "bad-key")
    from news_digest.config import get_settings

    get_settings.cache_clear()

    transport = _make_transport(401, {"error": "Unauthorized"})
    _patch_search_client(monkeypatch, transport)

    with pytest.raises(search.SearchError, match="auth"):
        search.web_search("test")
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# 429 → SearchError
# ---------------------------------------------------------------------------


def test_429_raises_search_error(monkeypatch, valid_env):
    monkeypatch.setenv("PERPLEXITY_API_KEY", "pplx-test")
    from news_digest.config import get_settings

    get_settings.cache_clear()

    transport = _make_transport(429, {"error": "Rate limited"})
    _patch_search_client(monkeypatch, transport)

    with pytest.raises(search.SearchError, match="rate limit"):
        search.web_search("test")
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# Empty response body (no search_results, no citations) → []
# ---------------------------------------------------------------------------


def test_empty_response_returns_empty(monkeypatch, valid_env):
    monkeypatch.setenv("PERPLEXITY_API_KEY", "pplx-test")
    from news_digest.config import get_settings

    get_settings.cache_clear()

    body = {}
    transport = _make_transport(200, body)
    _patch_search_client(monkeypatch, transport)

    result = search.web_search("test")
    assert result == []
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# Integration test (excluded from CI — requires real key)
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_live_web_search():
    """Live test against Perplexity API. Requires PERPLEXITY_API_KEY in env."""
    result = search.web_search("AI news RSS feed", recency="week", max_results=3)
    assert isinstance(result, list)
    if result:  # May be empty if no results
        assert "url" in result[0]
