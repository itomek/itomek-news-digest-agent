"""Social signal tools for the News Digest Agent.

Provides Reddit integration via PRAW as a supplementary signal source.
Reddit results are secondary context (tagged social_signal) used by the agent
to surface stories that primary RSS sources missed, or to add community context.
The agent should NOT quote Reddit posts directly.

Tools:
    fetch_reddit: Fetch top/hot/new posts from a subreddit via PRAW.

Authentication:
    Script-type OAuth via PRAW; credentials read from environment variables
    REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USER_AGENT.
    Missing credentials → structured error return, no exception raised.
    The agent continues without Reddit when credentials are absent.
"""

import os
import time
from typing import Any

from gaia.agents.base.tools import tool

from news_digest.logging import log

_SELFTEXT_PREVIEW_CHARS = 300


def _get_reddit_client():
    """Build and return a PRAW Reddit client from environment variables.

    Returns:
        praw.Reddit instance on success.
        None when credentials are missing or PRAW is unavailable.
    """
    client_id = os.environ.get("REDDIT_CLIENT_ID", "").strip()
    client_secret = os.environ.get("REDDIT_CLIENT_SECRET", "").strip()
    user_agent = os.environ.get("REDDIT_USER_AGENT", "").strip()

    if not (client_id and client_secret and user_agent):
        return None

    try:
        import praw  # noqa: PLC0415 — optional dependency

        return praw.Reddit(
            client_id=client_id,
            client_secret=client_secret,
            user_agent=user_agent,
        )
    except Exception:
        return None


def _rate_limit_remaining(reddit) -> float | None:
    """Read PRAW's remaining-request budget via the supported public API.

    Uses ``reddit.auth.limits`` — a dict whose values are None until the first
    request populates them. Defensive: returns None unless the value is a real
    number, and never raises.
    """
    try:
        limits = reddit.auth.limits
        remaining = limits.get("remaining") if hasattr(limits, "get") else None
        return remaining if isinstance(remaining, int | float) else None
    except Exception:
        return None


def _missing_creds_error(subreddit: str) -> list[dict]:
    """Return a structured error payload for missing Reddit credentials."""
    log(
        "warn",
        "scrape",
        "fetch_reddit: missing credentials (REDDIT_CLIENT_ID / "
        "REDDIT_CLIENT_SECRET / REDDIT_USER_AGENT) — skipping Reddit",
        metadata={"subreddit": subreddit, "status": "no_credentials"},
    )
    return [
        {
            "error": "no_credentials",
            "message": (
                "Reddit credentials not configured. "
                "Set REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, "
                "and REDDIT_USER_AGENT to enable Reddit fetching."
            ),
            "subreddit": subreddit,
            "source_type": "social_signal",
        }
    ]


@tool
def fetch_reddit(
    subreddit: str,
    query: str | None = None,
    sort: str = "hot",
    limit: int = 25,
    min_score: int = 50,
    time_filter: str = "day",
) -> list[dict[str, Any]]:
    """Fetch posts from a subreddit as supplementary community signal.

    Results are SECONDARY context (source_type="social_signal"). The agent
    should use them only to surface stories that primary RSS sources missed,
    or to add community context. Do not quote Reddit posts directly.

    Args:
        subreddit: Subreddit name without the leading "r/" (e.g. "LocalLLaMA").
        query: Optional search query. When provided, uses subreddit.search()
            instead of the top-level sort listing.
        sort: Listing sort; one of "hot", "new", "top", "rising".
            Ignored when query is set (search uses relevance by default).
        limit: Maximum number of posts to retrieve before applying min_score.
            PRAW caps this at 1000.
        min_score: Minimum Reddit score (upvotes minus downvotes). Posts below
            this threshold are filtered out to reduce noise. Default 50.
        time_filter: Time window for "top" and "search" listings.
            One of "hour", "day", "week", "month", "year", "all".
            Ignored for "hot", "new", and "rising" sorts.

    Returns:
        List of post dicts on success. Each dict has keys:
            title (str), url (str), score (int), num_comments (int),
            created_utc (float — Unix timestamp),
            selftext_preview (str — first 300 chars of self-post body, or ""),
            subreddit (str), source_type ("social_signal").
        Returns a single-element list with an "error" key when credentials are
        missing or a fetch error occurs. The call never raises.
    """
    t_start = time.monotonic()

    reddit = _get_reddit_client()
    if reddit is None:
        return _missing_creds_error(subreddit)

    try:
        sub = reddit.subreddit(subreddit)

        if query:
            posts_iter = sub.search(query, sort=sort, time_filter=time_filter)
        elif sort == "hot":
            posts_iter = sub.hot(limit=limit)
        elif sort == "new":
            posts_iter = sub.new(limit=limit)
        elif sort == "rising":
            posts_iter = sub.rising(limit=limit)
        elif sort == "top":
            posts_iter = sub.top(limit=limit, time_filter=time_filter)
        else:
            posts_iter = sub.hot(limit=limit)

        results: list[dict[str, Any]] = []
        seen_throttle_warn = False

        for post in posts_iter:
            # PRAW transparently fetches additional pages; warn once if throttled.
            if not seen_throttle_warn:
                remaining = _rate_limit_remaining(reddit)
                if remaining is not None and remaining <= 0:
                    log(
                        "warn",
                        "scrape",
                        f"fetch_reddit: PRAW rate limit reached for r/{subreddit}",
                        metadata={"subreddit": subreddit, "remaining": remaining},
                    )
                    seen_throttle_warn = True

            if post.score < min_score:
                continue

            selftext = (post.selftext or "").strip()
            selftext_preview = selftext[:_SELFTEXT_PREVIEW_CHARS] if selftext else ""

            results.append(
                {
                    "title": post.title,
                    "url": post.url,
                    "score": post.score,
                    "num_comments": post.num_comments,
                    "created_utc": post.created_utc,
                    "selftext_preview": selftext_preview,
                    "subreddit": subreddit,
                    "source_type": "social_signal",
                }
            )

        duration_ms = round((time.monotonic() - t_start) * 1000)
        log(
            "info",
            "scrape",
            f"fetch_reddit: returned {len(results)} posts from r/{subreddit}",
            metadata={
                "subreddit": subreddit,
                "query": query,
                "sort": sort,
                "limit": limit,
                "min_score": min_score,
                "time_filter": time_filter,
                "status": "ok",
                "count": len(results),
                "duration_ms": duration_ms,
            },
        )
        return results

    except Exception as exc:
        duration_ms = round((time.monotonic() - t_start) * 1000)
        log(
            "warn",
            "scrape",
            f"fetch_reddit: error fetching r/{subreddit}: "
            f"{exc.__class__.__name__}: {exc}",
            metadata={
                "subreddit": subreddit,
                "query": query,
                "sort": sort,
                "status": "error",
                "error_class": exc.__class__.__name__,
                "error": str(exc),
                "duration_ms": duration_ms,
            },
        )
        return [
            {
                "error": exc.__class__.__name__,
                "message": str(exc),
                "subreddit": subreddit,
                "source_type": "social_signal",
            }
        ]
