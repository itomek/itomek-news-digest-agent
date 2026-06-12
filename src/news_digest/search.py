"""Perplexity web search client for source curation (issue #98).

NOT a @tool — this is a curator-internal helper. Uses httpx directly with a
_make_client factory that tests can patch with httpx.MockTransport.

Usage:
    from news_digest.search import web_search, SearchError
    results = web_search("AI news RSS feeds", recency="month", max_results=8)
"""

from __future__ import annotations

import httpx

PPLX_URL = "https://api.perplexity.ai/chat/completions"
_TIMEOUT = 30.0


class SearchError(RuntimeError):
    """Raised on Perplexity API errors (401 auth failure, 429 rate limit)."""


def _make_client(transport: httpx.BaseTransport | None = None) -> httpx.Client:
    """Create an httpx.Client. Tests inject a MockTransport via monkeypatching."""
    return httpx.Client(transport=transport, timeout=httpx.Timeout(_TIMEOUT))


def web_search(
    query: str,
    *,
    recency: str = "month",
    max_results: int = 8,
) -> list[dict]:
    """Search via Perplexity API and return candidate source results.

    Returns a list of dicts with keys: title, url, date.
    Prefers top-level ``search_results``; falls back to ``citations`` (bare URLs).
    Results are deduped (by URL, order preserved) and truncated to max_results.

    Returns an empty list if ``perplexity_api_key`` is not configured.

    Args:
        query: The search query string.
        recency: Perplexity recency filter — 'day', 'week', 'month', 'year'.
        max_results: Maximum number of results to return.

    Raises:
        SearchError: On 401 (auth) or 429 (rate limit) responses.
    """
    from news_digest.config import get_settings

    settings = get_settings()
    if not settings.perplexity_api_key:
        return []

    headers = {
        "Authorization": f"Bearer {settings.perplexity_api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": settings.perplexity_model,
        "messages": [
            {
                "role": "system",
                "content": "List relevant RSS feeds or news page URLs for the topic. Be concise.",
            },
            {"role": "user", "content": query},
        ],
        "web_search_options": {"search_context_size": "low"},
        "search_recency_filter": recency,
        "max_tokens": 512,
        "temperature": 0.2,
        "stream": False,
    }

    with _make_client() as client:
        response = client.post(PPLX_URL, json=payload, headers=headers)

    if response.status_code == 401:
        raise SearchError("perplexity auth")
    if response.status_code == 429:
        raise SearchError("perplexity rate limit")
    response.raise_for_status()

    data = response.json()

    # Prefer top-level search_results (structured); fall back to citations (bare URLs)
    raw_results = data.get("search_results") or []
    if raw_results:
        candidates = [
            {"title": r.get("title"), "url": r.get("url"), "date": r.get("date")}
            for r in raw_results
            if r.get("url")
        ]
    else:
        citations = data.get("citations") or []
        candidates = [{"title": None, "url": u, "date": None} for u in citations if u]

    # Dedup by URL, preserving order
    seen: dict[str, dict] = {}
    for c in candidates:
        url = c.get("url") or ""
        if url and url not in seen:
            seen[url] = c

    return list(seen.values())[:max_results]
