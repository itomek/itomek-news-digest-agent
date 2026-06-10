"""Publishing tools for the News Digest Agent.

Reads topic configuration from Supabase and writes finished digests back. These
close the data loop: config in (digest_topics) -> digest out (digests).

Tools:
    fetch_topic_config: Get a topic's sources, prompt_hint, cadence, enabled flag.
    push_to_supabase: Upsert a completed digest (idempotent per topic per day).
    get_last_digest_date: Most recent digest date for a topic (None if never).
    get_recent_digests: Fetch recent digest content for a topic (deduplication).

Auth follows the project's RLS design: reads use the anon key, the digest write
uses the service-role key. Every tool logs to system_logs and never raises — on
failure it logs and returns a failure/empty status so the agent loop continues.
"""

import time
from datetime import UTC, datetime

from gaia.agents.base.tools import tool

from news_digest.config import get_settings
from news_digest.logging import log
from news_digest.prompts import PROMPT_VERSION, flatten_digest
from supabase import Client, create_client

_CONFIG_CACHE_TTL: float = 300.0  # 5 minutes (issue #8)
# slug -> (monotonic_timestamp, config_row)
_config_cache: dict[str, tuple[float, dict]] = {}


def _now() -> float:
    """Monotonic clock seam so tests can drive cache expiry deterministically."""
    return time.monotonic()


def _client(write: bool = False) -> Client:
    """Build a Supabase client. Writes use the service-role key; reads the anon key."""
    settings = get_settings()
    key = settings.supabase_service_key if write else settings.supabase_anon_key
    return create_client(settings.supabase_url, key)


@tool
def fetch_topic_config(slug: str) -> dict:
    """Fetch a topic's configuration from the Supabase digest_topics table.

    Results are cached in-process for five minutes to avoid refetching the same
    topic repeatedly within a run.

    Args:
        slug: The topic slug, for example 'ai_models'.

    Returns:
        The topic row as a dict (name, slug, sources, prompt_hint, cadence,
        enabled, ...) on success, or a dict with an 'error' key if the topic is
        not found or Supabase is unreachable.
    """
    cached = _config_cache.get(slug)
    if cached is not None and (_now() - cached[0]) < _CONFIG_CACHE_TTL:
        return dict(cached[1])  # copy so callers can't mutate the cached row

    try:
        resp = (
            _client()
            .table("digest_topics")
            .select("*")
            .eq("slug", slug)
            .limit(1)
            .execute()
        )
    except Exception as exc:
        log(
            "warn",
            "publish",
            f"fetch_topic_config: error for {slug!r}: {exc.__class__.__name__}",
            topic_slug=slug,
            metadata={"slug": slug, "error": str(exc)},
        )
        return {"error": exc.__class__.__name__, "slug": slug}

    rows = resp.data or []
    if not rows:
        log(
            "warn",
            "publish",
            f"fetch_topic_config: no topic for slug {slug!r}",
            topic_slug=slug,
            metadata={"slug": slug},
        )
        return {"error": "not_found", "slug": slug}

    config = rows[0]
    _config_cache[slug] = (_now(), config)
    log(
        "info",
        "publish",
        f"fetch_topic_config: loaded {slug!r}",
        topic_slug=slug,
        metadata={"slug": slug, "enabled": config.get("enabled")},
    )
    return dict(config)


@tool
def list_topics() -> dict:
    """List the enabled digest topics so the agent can map a user's described
    topic (for example 'AI model releases') to its exact slug.

    Returns:
        {"topics": [{"slug", "name", "cadence"}, ...]} on success, or
        {"topics": [], "error": <reason>} on failure.
    """
    try:
        resp = (
            _client()
            .table("digest_topics")
            .select("slug,name,cadence")
            .eq("enabled", True)
            .execute()
        )
    except Exception as exc:
        log(
            "warn",
            "publish",
            f"list_topics: error: {exc.__class__.__name__}",
            metadata={"error": str(exc)},
        )
        return {"topics": [], "error": exc.__class__.__name__}

    topics = resp.data or []
    log(
        "info",
        "publish",
        f"list_topics: {len(topics)} enabled topics",
        metadata={"count": len(topics)},
    )
    return {"topics": topics}


@tool
def push_to_supabase(
    topic_slug: str,
    summary: str,
    items: list[dict],
    sources_used: list[str],
    token_count: int,
    content: str | None = None,
) -> dict:
    """Publish a finished structured digest to the Supabase digests table.

    Idempotent per topic per day: upserts on the unique (topic_slug, digest_date)
    pair, so re-running the same day updates the existing row instead of creating
    a duplicate. The digest date is today in UTC; cadence is taken from the topic
    config; prompt_version records which system prompt produced the text.

    The ``content`` column is derived via ``flatten_digest(summary, items)`` when
    not explicitly provided. It is kept as the flat TTS-safe fallback and
    deduplication source.

    Each element of ``items`` must follow the canonical item shape::

        {
            "headline": "one-line description",
            "blurb":    "1-2 sentences — what happened",
            "detail":   "fuller prose — why it matters, specifics/numbers",
            "metadata": {
                "sources": [{"title": "Source Name", "url": "https://..."}],
                "tags":    ["optional", "tags"],
            }
        }

    Args:
        topic_slug: The topic slug, for example 'ai_models'.
        summary: Short top-level overview (one or two sentences).
        items: Ranked list of digest items (canonical shape above).
        sources_used: URLs that were scraped for this digest.
        token_count: Approximate token count of the generated digest.
        content: Flat prose override. When omitted, derived from summary+items
            via ``flatten_digest`` (no raw URLs, TTS-safe).

    Returns:
        {'success': True, 'id': <row id>, 'digest_date': <iso date>} on success,
        or {'success': False, 'error': <reason>} on failure.
    """
    digest_date = datetime.now(UTC).date().isoformat()

    config = fetch_topic_config(topic_slug)
    cadence = config.get("cadence")
    if cadence is None:
        log(
            "error",
            "publish",
            f"push_to_supabase: cannot resolve cadence for {topic_slug!r}; aborting",
            topic_slug=topic_slug,
            metadata={"topic_slug": topic_slug, "config_error": config.get("error")},
        )
        return {"success": False, "error": "unknown_topic"}

    derived_content = content or flatten_digest(summary, items)

    row = {
        "topic_slug": topic_slug,
        "summary": summary,
        "items": items,
        "content": derived_content,
        "cadence": cadence,
        "digest_date": digest_date,
        "sources_used": sources_used,
        "token_count": token_count,
        "prompt_version": PROMPT_VERSION,
    }
    try:
        resp = (
            _client(write=True)
            .table("digests")
            .upsert(row, on_conflict="topic_slug,digest_date")
            .execute()
        )
    except Exception as exc:
        log(
            "error",
            "publish",
            f"push_to_supabase: failed for {topic_slug!r}: {exc.__class__.__name__}: {exc}",
            topic_slug=topic_slug,
            metadata={
                "topic_slug": topic_slug,
                "digest_date": digest_date,
                "error": str(exc),
            },
        )
        return {"success": False, "error": exc.__class__.__name__}

    data = resp.data or []
    digest_id = data[0].get("id") if data else None
    log(
        "info",
        "publish",
        f"push_to_supabase: upserted digest for {topic_slug!r} on {digest_date}",
        topic_slug=topic_slug,
        metadata={
            "topic_slug": topic_slug,
            "digest_date": digest_date,
            "id": digest_id,
            "token_count": token_count,
            "prompt_version": PROMPT_VERSION,
            "sources_used": len(sources_used),
        },
    )
    return {"success": True, "id": digest_id, "digest_date": digest_date}


@tool
def get_recent_digests(topic_slug: str, limit: int = 1) -> dict:
    """Fetch the most recent digest(s) for a topic, including their full content.

    Useful for deduplication: the agent calls this for a sibling topic before
    writing its own digest, then avoids repeating items already covered there.
    The limit parameter is kept generic so future topics can retrieve multiple
    prior digests (e.g. limit=2 for a weekly rolling window).

    Args:
        topic_slug: The topic slug whose recent digests to fetch.
        limit: Maximum number of digests to return, ordered most-recent-first.

    Returns:
        {"digests": [{"date": <iso date>, "content": <text>}, ...]} on success
        (empty list when no prior digests exist), or
        {"digests": [], "error": <exception class name>} on failure.
    """
    try:
        resp = (
            _client()
            .table("digests")
            .select("digest_date,content")
            .eq("topic_slug", topic_slug)
            .order("digest_date", desc=True)
            .limit(limit)
            .execute()
        )
    except Exception as exc:
        log(
            "warn",
            "publish",
            f"get_recent_digests: error for {topic_slug!r}: {exc.__class__.__name__}",
            topic_slug=topic_slug,
            metadata={"topic_slug": topic_slug, "error": str(exc)},
        )
        return {"digests": [], "error": exc.__class__.__name__}

    rows = resp.data or []
    digests = [{"date": r["digest_date"], "content": r["content"]} for r in rows]
    log(
        "info",
        "publish",
        f"get_recent_digests: {topic_slug!r} -> {len(digests)} digest(s)",
        topic_slug=topic_slug,
        metadata={"topic_slug": topic_slug, "count": len(digests)},
    )
    return {"digests": digests}


@tool
def get_last_digest_date(topic_slug: str) -> dict:
    """Get the date of the most recent digest published for a topic.

    Used by the scheduler (Epic 4) to decide whether a run is due.

    Args:
        topic_slug: The topic slug, for example 'ai_models'.

    Returns:
        {'last_date': <iso date string>} for the latest digest, or
        {'last_date': None} when no prior digest exists or on failure.
    """
    try:
        resp = (
            _client()
            .table("digests")
            .select("digest_date")
            .eq("topic_slug", topic_slug)
            .order("digest_date", desc=True)
            .limit(1)
            .execute()
        )
    except Exception as exc:
        log(
            "warn",
            "publish",
            f"get_last_digest_date: error for {topic_slug!r}: {exc.__class__.__name__}",
            topic_slug=topic_slug,
            metadata={"topic_slug": topic_slug, "error": str(exc)},
        )
        return {"last_date": None, "error": exc.__class__.__name__}

    rows = resp.data or []
    last_date = rows[0]["digest_date"] if rows else None
    log(
        "info",
        "publish",
        f"get_last_digest_date: {topic_slug!r} -> {last_date}",
        topic_slug=topic_slug,
        metadata={"topic_slug": topic_slug, "last_date": last_date},
    )
    return {"last_date": last_date}
