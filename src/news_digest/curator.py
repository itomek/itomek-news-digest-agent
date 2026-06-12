"""Autonomous source curation pipeline (issue #98).

Detects persistently-failing configured sources from existing telemetry,
discovers validated alternates via Perplexity web search, auto-adopts
high-confidence finds and queues borderline ones for in-app approval.

Pipeline: detect → classify → discover → validate → judge → apply.

Usage (CLI):
    python -m news_digest.curator
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlparse

from news_digest.logging import log
from news_digest.search import SearchError
from news_digest.search import web_search as _web_search_real

# ---------------------------------------------------------------------------
# Module constants (tunable, no schema change)
# ---------------------------------------------------------------------------

RELEVANCE_AUTO_USE = 0.8  # >= → auto-use
RELEVANCE_CANDIDATE = 0.5  # [0.5, 0.8) → candidate; < 0.5 → reject
MIN_FEED_ENTRIES = 3  # K (RSS parse gate)
CANDIDATE_URL_CAP = 8  # discovery URLs per failing source
COOLDOWN_DAYS = 7
MAX_AUTO_ADDS_PER_RUN = 3  # global churn cap
MAX_SOURCES_PER_RUN = 10  # failing sources processed per run
STALE_SUCCESS_PCT = 50
STALE_HOURS = 72
MIN_ATTEMPTS = 3


@dataclass
class FailingSource:
    topic: dict
    source_obj: dict
    url: str
    type: str
    health_row: dict
    error: str = ""


# ---------------------------------------------------------------------------
# Seams (monkeypatched in tests)
# ---------------------------------------------------------------------------


def _get_supabase_client():
    from news_digest.supabase_client import get_client

    return get_client()


def _llm_complete(messages: list[dict]) -> str:
    """Thin seam around LemonadeClient.chat_completions — tests monkeypatch this."""
    from news_digest.config import get_settings

    settings = get_settings()
    model = settings.lemonade_light_model or settings.lemonade_heavy_model
    if not model:
        return ""

    from gaia.llm.lemonade_client import LemonadeClient

    client = LemonadeClient(base_url=settings.lemonade_base_url)
    result = client.chat_completions(
        model=model,
        messages=messages,
        temperature=0.0,
        max_completion_tokens=256,
        stream=False,
    )
    return result["choices"][0]["message"]["content"]


def _web_search(query: str, **kwargs) -> list[dict]:
    """Seam over web_search so tests can patch curator._web_search."""
    return _web_search_real(query, **kwargs)


def _fetch_rss(url: str, **kwargs) -> list[dict]:
    """Seam over fetch_rss so tests can patch without touching scraping module."""
    from news_digest.tools.scraping import fetch_rss

    return fetch_rss(url, **kwargs)


def _fetch_html(url: str, **kwargs) -> dict:
    """Seam over fetch_html so tests can patch without touching scraping module."""
    from news_digest.tools.scraping import fetch_html

    return fetch_html(url, **kwargs)


# ---------------------------------------------------------------------------
# detect
# ---------------------------------------------------------------------------


def is_stale(row: dict, now: datetime) -> bool:
    """Return True if a source health row indicates a stale/failing source.

    Stale = enough attempts AND (low success rate OR no recent success).
    """
    total = row.get("total_7d") or 0
    if total < MIN_ATTEMPTS:
        return False

    success_pct = row.get("success_pct_7d")
    # Treat None success_pct with zero successes as 0% stale
    if success_pct is None:
        success_pct = 0.0 if (row.get("success_7d") or 0) == 0 else 50.0

    low_rate = success_pct < STALE_SUCCESS_PCT

    last_success_str = row.get("last_success_at")
    if last_success_str is None:
        no_recent_success = True
    else:
        try:
            last_success = datetime.fromisoformat(
                last_success_str.replace("Z", "+00:00")
            )
            hours_since = (now - last_success).total_seconds() / 3600
            no_recent_success = hours_since > STALE_HOURS
        except (ValueError, TypeError):
            no_recent_success = True

    return low_rate or no_recent_success


def read_source_health(client) -> dict[str, dict]:
    """Read mv_source_health view; return {source_url: row}."""
    try:
        resp = client.table("mv_source_health").select("*").execute()
        return {r["source_url"]: r for r in (resp.data or [])}
    except Exception as exc:
        log("warn", "curator", f"read_source_health failed: {exc}")
        return {}


def load_topics(client) -> list[dict]:
    """Load all digest_topics rows (including disabled)."""
    try:
        resp = client.table("digest_topics").select("*").execute()
        return resp.data or []
    except Exception as exc:
        log("warn", "curator", f"load_topics failed: {exc}")
        return []


def load_pending_urls(client) -> set[str]:
    """Load URLs that already have a pending source_candidates row."""
    try:
        resp = (
            client.table("source_candidates")
            .select("url")
            .eq("status", "pending")
            .execute()
        )
        return {r["url"] for r in (resp.data or [])}
    except Exception as exc:
        log("warn", "curator", f"load_pending_urls failed: {exc}")
        return set()


def load_cooldown_urls(client, now: datetime) -> set[str]:
    """Load URLs that were processed by the curator within the cooldown window."""
    cutoff = (now - timedelta(days=COOLDOWN_DAYS)).isoformat()
    try:
        resp = (
            client.table("system_logs")
            .select("metadata")
            .eq("category", "curator")
            .gte("timestamp", cutoff)
            .execute()
        )
        urls: set[str] = set()
        for row in resp.data or []:
            meta = row.get("metadata") or {}
            url = meta.get("source_url")
            if url:
                urls.add(url)
        return urls
    except Exception as exc:
        log("warn", "curator", f"load_cooldown_urls failed: {exc}")
        return set()


def build_failing_sources(
    topics: list[dict],
    health: dict[str, dict],
    now: datetime,
    pending_urls: set[str],
    cooldown_urls: set[str],
) -> list[FailingSource]:
    """Identify enabled rss/html sources that are stale and not already being handled."""
    failing: list[FailingSource] = []
    for topic in topics:
        for src in topic.get("sources") or []:
            url = src.get("url", "")
            src_type = src.get("type", "")

            # Skip reddit sources (discovery is for feeds/pages)
            if src_type == "reddit":
                continue

            # Skip explicitly disabled sources
            if isinstance(src, dict) and src.get("enabled", True) is False:
                continue

            # Skip only rss and html types
            if src_type not in ("rss", "html"):
                continue

            # Skip if already pending or in cooldown
            if url in pending_urls or url in cooldown_urls:
                continue

            # Check health
            health_row = health.get(url)
            if health_row is None:
                continue

            if is_stale(health_row, now):
                last_error = health_row.get("last_error") or ""
                failing.append(
                    FailingSource(
                        topic=topic,
                        source_obj=src,
                        url=url,
                        type=src_type,
                        health_row=health_row,
                        error=last_error,
                    )
                )

    return failing


# ---------------------------------------------------------------------------
# classify
# ---------------------------------------------------------------------------

_DEAD_PATTERNS = re.compile(
    r"NXDOMAIN|DNS error|blocked unsafe url|HTTP 404|HTTP 410|Name or service not known",
    re.IGNORECASE,
)


def classify_failure(last_error: str) -> str:
    """Classify a failure string as 'dead' or 'blocked'. Default: 'blocked'."""
    if _DEAD_PATTERNS.search(last_error):
        return "dead"
    return "blocked"


# ---------------------------------------------------------------------------
# discover
# ---------------------------------------------------------------------------


def craft_query(topic: dict, source_obj: dict) -> str:
    """Use the LLM to craft a web search query for discovering alternate sources."""
    topic_name = topic.get("name", topic.get("slug", "news"))
    source_url = source_obj.get("url", "")
    messages = [
        {
            "role": "user",
            "content": (
                f"Write a short web search query (10 words max) to find alternative RSS feeds "
                f"or news pages for the topic: '{topic_name}'. "
                f"The current source '{source_url}' is failing. "
                f"Return ONLY the search query text, nothing else."
            ),
        }
    ]
    try:
        query = _llm_complete(messages).strip()
        if not query:
            raise ValueError("empty response")
        return query
    except Exception as exc:
        log("warn", "curator", f"craft_query LLM failed: {exc}; using fallback")
        return f"{topic_name} RSS feed news"


# ---------------------------------------------------------------------------
# validate
# ---------------------------------------------------------------------------


def _cadence_to_window(cadence: str) -> tuple[int, int]:
    """Return (fetch_since_hours, max_age_hours) for validation."""
    if cadence == "7d":
        return 7 * 24, 14 * 24  # use a 7-day window; recent = 14 days
    return 24, 3 * 24  # 24h cadence; recent = 3 days


def validate_candidate(
    url: str,
    topic: dict,
    existing_domains: set[str],
    now: datetime,
) -> dict:
    """Validate a candidate URL — try RSS first, then HTML.

    Returns a dict with:
        fetch_ok, type, item_count, newest_item_at, distinct_domain, parseable, recent
    """
    cadence = topic.get("cadence", "24h")
    since_hours, max_age_hours = _cadence_to_window(cadence)

    candidate_domain = urlparse(url).netloc.lower()
    distinct_domain = candidate_domain not in existing_domains

    base: dict[str, Any] = {
        "fetch_ok": False,
        "type": None,
        "item_count": 0,
        "newest_item_at": None,
        "distinct_domain": distinct_domain,
        "parseable": False,
        "recent": False,
    }

    # Try RSS first (uses scraping._fetch_rss → honest UA + throttle)
    try:
        items = _fetch_rss(url, since_hours=since_hours)
        if isinstance(items, list) and len(items) >= MIN_FEED_ENTRIES:
            # Check recency: look for any item published within max_age_hours
            recent_cutoff = now - timedelta(hours=max_age_hours)
            newest = None
            for item in items:
                pub = item.get("published")
                if pub:
                    try:
                        pub_dt = datetime.fromisoformat(pub.replace("Z", "+00:00"))
                        if newest is None or pub_dt > newest:
                            newest = pub_dt
                    except (ValueError, TypeError):
                        pass

            is_recent = newest is not None and newest >= recent_cutoff
            return {
                **base,
                "fetch_ok": True,
                "type": "rss",
                "item_count": len(items),
                "newest_item_at": newest.isoformat() if newest else None,
                "parseable": True,
                "recent": is_recent,
            }
        elif isinstance(items, list) and len(items) > 0:
            # Has some items but not enough — still fetch_ok, not parseable as good feed
            return {**base, "fetch_ok": True, "type": "rss", "parseable": False}
    except Exception:
        # RSS fetch raised/timed out → candidate blocks the bot → reject
        return {**base, "fetch_ok": False}

    # Fall back to HTML
    try:
        result = _fetch_html(url)
        if result.get("error"):
            return {**base, "fetch_ok": False}

        content = result.get("content", "")
        links = result.get("links", [])
        # Simple heuristic: has meaningful content
        parseable = len(content.strip()) > 200 or len(links) > 3

        return {
            **base,
            "fetch_ok": True,
            "type": "html",
            "item_count": len(links),
            "parseable": parseable,
            "recent": True,  # HTML pages are assumed current if fetchable
        }
    except Exception:
        return {**base, "fetch_ok": False}


# ---------------------------------------------------------------------------
# judge
# ---------------------------------------------------------------------------


def judge_relevance(topic: dict, sample_items: list[dict]) -> float:
    """Use the LLM to judge how relevant discovered content is to the topic.

    Returns a float [0, 1]. Returns 0.0 on parse failure (logged).
    """
    topic_name = topic.get("name", topic.get("slug", "news"))
    sample_texts = "\n".join(
        f"- {item.get('title', item.get('headline', ''))}" for item in sample_items[:5]
    )
    messages = [
        {
            "role": "user",
            "content": (
                f"Rate how relevant the following article titles are to the topic "
                f"'{topic_name}' on a scale from 0.0 to 1.0. "
                f"Return ONLY a decimal number, nothing else.\n\n"
                f"Articles:\n{sample_texts}"
            ),
        }
    ]
    try:
        raw = _llm_complete(messages).strip()
        score = float(re.search(r"[0-9]*\.?[0-9]+", raw).group())  # type: ignore[union-attr]
        return max(0.0, min(1.0, score))
    except Exception as exc:
        log("warn", "curator", f"judge_relevance parse failed: {exc}")
        return 0.0


# ---------------------------------------------------------------------------
# tier
# ---------------------------------------------------------------------------


def confidence_tier(validation: dict, relevance: float) -> str:
    """Assign a confidence tier: 'reject', 'candidate', or 'auto_use'."""
    fetch_ok = validation.get("fetch_ok", False)
    parseable = validation.get("parseable", False)
    recent = validation.get("recent", False)

    if not (fetch_ok and parseable and recent):
        return "reject"
    if relevance < RELEVANCE_CANDIDATE:
        return "reject"
    if relevance >= RELEVANCE_AUTO_USE:
        return "auto_use"
    return "candidate"


# ---------------------------------------------------------------------------
# apply
# ---------------------------------------------------------------------------


def _count_enabled(topic: dict) -> int:
    """Count enabled (or absent-enabled) sources in the topic."""
    count = 0
    for s in topic.get("sources") or []:
        if isinstance(s, dict) and s.get("enabled", True) is not False:
            count += 1
    return count


def would_strand(topic: dict, url: str, adding_replacement: bool) -> bool:
    """Return True if disabling `url` would leave the topic with 0 enabled sources."""
    if adding_replacement:
        return False
    enabled_count = _count_enabled(topic)
    # This source itself is currently enabled (we're about to disable it)
    return enabled_count <= 1


def quarantine_source(
    topic: dict,
    url: str,
    reason: str,
    now: datetime,
    client,
    adding_replacement: bool = False,
) -> None:
    """Disable a source in digest_topics.sources (never strands the last source)."""
    if would_strand(topic, url, adding_replacement):
        log(
            "warn",
            "curator",
            f"would strand topic {topic['slug']!r} — not disabling {url!r}",
            topic_slug=topic.get("slug"),
            metadata={
                "source_url": url,
                "topic_slug": topic.get("slug"),
                "action": "strand_guard",
            },
        )
        return

    # Re-read topic for freshness before mutating
    slug = topic["slug"]
    try:
        resp = (
            client.table("digest_topics").select("sources").eq("slug", slug).execute()
        )
        current_sources = (
            (resp.data or [{}])[0].get("sources") or topic.get("sources") or []
        )
    except Exception:
        current_sources = topic.get("sources") or []

    updated_sources = []
    for src in current_sources:
        if src.get("url") == url:
            src = {
                **src,
                "enabled": False,
                "disabled_reason": reason,
                "disabled_at": now.isoformat(),
            }
        updated_sources.append(src)

    try:
        client.table("digest_topics").update({"sources": updated_sources}).eq(
            "slug", slug
        ).execute()
        log(
            "info",
            "curator",
            f"quarantined {url!r} in topic {slug!r} ({reason})",
            topic_slug=slug,
            metadata={
                "source_url": url,
                "topic_slug": slug,
                "action": "quarantine",
                "reason": reason,
            },
        )
    except Exception as exc:
        log("warn", "curator", f"quarantine_source update failed for {url!r}: {exc}")


def add_source(topic: dict, new_obj: dict, client) -> bool:
    """Append a new source object to a topic's sources array.

    Returns True on a confirmed write, False on failure. The caller relies on
    this signal to decide whether it is safe to quarantine the failing source
    (never strand a topic by disabling its last source when the replacement
    write did not land).
    """
    slug = topic["slug"]

    # Re-read for freshness before appending
    try:
        resp = (
            client.table("digest_topics").select("sources").eq("slug", slug).execute()
        )
        current_sources = (
            (resp.data or [{}])[0].get("sources") or topic.get("sources") or []
        )
    except Exception:
        current_sources = topic.get("sources") or []

    updated_sources = list(current_sources) + [new_obj]

    try:
        client.table("digest_topics").update({"sources": updated_sources}).eq(
            "slug", slug
        ).execute()
        log(
            "info",
            "curator",
            f"added source {new_obj['url']!r} to topic {slug!r}",
            topic_slug=slug,
            metadata={
                "source_url": new_obj["url"],
                "topic_slug": slug,
                "action": "add_source",
                "added_by": new_obj.get("added_by"),
                "replaces": new_obj.get("replaces"),
            },
        )
        return True
    except Exception as exc:
        log(
            "warn", "curator", f"add_source update failed for {new_obj['url']!r}: {exc}"
        )
        return False


def insert_candidate(
    topic: dict,
    url: str,
    candidate_type: str,
    replaces_url: str | None,
    failure_class: str | None,
    relevance_score: float,
    validation: dict,
    client,
) -> None:
    """Insert a borderline candidate into source_candidates (pending)."""
    slug = topic["slug"]
    row = {
        "topic_slug": slug,
        "url": url,
        "type": candidate_type,
        "replaces_url": replaces_url,
        "failure_class": failure_class,
        "relevance_score": relevance_score,
        "validation": validation,
        "status": "pending",
    }
    try:
        client.table("source_candidates").insert(row).execute()
        log(
            "info",
            "curator",
            f"inserted candidate {url!r} for topic {slug!r}",
            topic_slug=slug,
            metadata={
                "source_url": url,
                "topic_slug": slug,
                "action": "insert_candidate",
                "relevance_score": relevance_score,
            },
        )
    except Exception as exc:
        log("warn", "curator", f"insert_candidate failed for {url!r}: {exc}")


# ---------------------------------------------------------------------------
# orchestrate
# ---------------------------------------------------------------------------


def run_curator_cycle() -> dict:
    """Run one full source curation cycle.

    Returns:
        {detected, processed, auto_added, candidates_created, rejected, alerts}
    """
    from news_digest.config import get_settings

    settings = get_settings()

    summary: dict[str, Any] = {
        "detected": 0,
        "processed": 0,
        "auto_added": 0,
        "candidates_created": 0,
        "rejected": 0,
        "alerts": [],
    }

    if not settings.perplexity_api_key:
        log(
            "warn",
            "curator",
            "PERPLEXITY_API_KEY not set — source curation skipped",
            metadata={"action": "no_op"},
        )
        return summary

    client = _get_supabase_client()
    now = datetime.now(UTC)

    # Detect
    health = read_source_health(client)
    topics = load_topics(client)
    pending_urls = load_pending_urls(client)
    cooldown_urls = load_cooldown_urls(client, now)

    failing = build_failing_sources(topics, health, now, pending_urls, cooldown_urls)
    summary["detected"] = len(failing)

    log(
        "info",
        "curator",
        f"curator cycle: {len(failing)} failing sources detected",
        metadata={"detected": len(failing)},
    )

    auto_added_count = 0

    for fs in failing[:MAX_SOURCES_PER_RUN]:
        try:
            _process_failing_source(fs, client, now, summary, auto_added_count, topics)
            if summary["auto_added"] > auto_added_count:
                auto_added_count = summary["auto_added"]
        except Exception as exc:
            log(
                "warn",
                "curator",
                f"error processing {fs.url!r}: {exc.__class__.__name__}: {exc}",
                topic_slug=fs.topic.get("slug"),
                metadata={
                    "source_url": fs.url,
                    "error": str(exc),
                    "action": "process_error",
                },
            )

    return summary


def _process_failing_source(
    fs: FailingSource,
    client,
    now: datetime,
    summary: dict,
    auto_added_count: int,
    all_topics: list[dict],
) -> None:
    """Process one failing source through the full pipeline."""
    topic = fs.topic
    slug = topic.get("slug", "")

    summary["processed"] += 1

    # Classify
    failure_class = classify_failure(fs.error)
    log(
        "info",
        "curator",
        f"classified {fs.url!r} as {failure_class!r}",
        topic_slug=slug,
        metadata={
            "source_url": fs.url,
            "topic_slug": slug,
            "action": "classify",
            "failure_class": failure_class,
        },
    )

    # Discover
    query = craft_query(topic, fs.source_obj)
    log(
        "info",
        "curator",
        f"searching for alternates for {fs.url!r}: {query!r}",
        topic_slug=slug,
        metadata={
            "source_url": fs.url,
            "topic_slug": slug,
            "action": "search",
            "query": query,
        },
    )

    try:
        results = _web_search(query, max_results=CANDIDATE_URL_CAP)
    except SearchError as exc:
        log("warn", "curator", f"web_search failed for {fs.url!r}: {exc}")
        return

    if not results:
        log(
            "info",
            "curator",
            f"no alternates found for {fs.url!r}",
            topic_slug=slug,
            metadata={"source_url": fs.url, "topic_slug": slug, "action": "no_results"},
        )
        return

    # Get existing domains for this topic
    existing_domains = {
        urlparse(s.get("url", "")).netloc.lower()
        for s in (topic.get("sources") or [])
        if s.get("enabled", True) is not False
    }

    # Validate and score each candidate; pick best
    best_candidate: dict | None = None
    best_relevance = -1.0
    best_validation: dict = {}
    best_tier = "reject"

    for result in results:
        cand_url = result.get("url")
        if not cand_url:
            continue

        # Skip if same as failing URL
        if cand_url == fs.url:
            continue

        # Skip if already configured for this topic
        configured_urls = {s.get("url") for s in (topic.get("sources") or [])}
        if cand_url in configured_urls:
            continue

        log(
            "info",
            "curator",
            f"validating candidate {cand_url!r} for topic {slug!r}",
            topic_slug=slug,
            metadata={"source_url": cand_url, "topic_slug": slug, "action": "validate"},
        )

        validation = validate_candidate(cand_url, topic, existing_domains, now)

        if not (validation.get("fetch_ok") and validation.get("parseable")):
            log(
                "info",
                "curator",
                f"candidate {cand_url!r} failed validation",
                topic_slug=slug,
                metadata={
                    "source_url": cand_url,
                    "topic_slug": slug,
                    "action": "validate_fail",
                },
            )
            summary["rejected"] += 1
            continue

        # Judge relevance using sampled items
        sample_items = [{"title": result.get("title", "")}]
        relevance = judge_relevance(topic, sample_items)

        tier = confidence_tier(validation, relevance)
        log(
            "info",
            "curator",
            f"candidate {cand_url!r}: relevance={relevance:.2f} tier={tier!r}",
            topic_slug=slug,
            metadata={
                "source_url": cand_url,
                "topic_slug": slug,
                "action": "judge",
                "relevance": relevance,
                "tier": tier,
            },
        )

        if tier == "reject":
            summary["rejected"] += 1
            continue

        # Keep best non-rejected candidate
        if relevance > best_relevance:
            best_relevance = relevance
            best_candidate = result
            best_validation = validation
            best_tier = tier

    if best_candidate is None:
        log(
            "info",
            "curator",
            f"no suitable replacement found for {fs.url!r}",
            topic_slug=slug,
            metadata={
                "source_url": fs.url,
                "topic_slug": slug,
                "action": "no_replacement",
            },
        )
        return

    cand_url = best_candidate["url"]
    cand_type = best_validation.get("type") or "rss"

    if best_tier == "auto_use" and auto_added_count < MAX_AUTO_ADDS_PER_RUN:
        # Auto-add: ADD the replacement FIRST, then quarantine the failing source
        # only if the add actually landed. Quarantining first with the strand
        # guard bypassed (adding_replacement=True) would strand the topic with
        # zero enabled sources if the add write then failed.
        new_source = {
            "type": cand_type,
            "url": cand_url,
            "enabled": True,
            "added_by": "curator",
            "replaces": fs.url,
            "discovered_at": now.isoformat(),
        }
        if add_source(topic, new_source, client):
            quarantine_source(
                topic, fs.url, failure_class, now, client, adding_replacement=True
            )
            summary["auto_added"] += 1
            log(
                "info",
                "curator",
                f"auto-added {cand_url!r} as replacement for {fs.url!r} in topic {slug!r}",
                topic_slug=slug,
                metadata={
                    "source_url": cand_url,
                    "topic_slug": slug,
                    "action": "auto_add",
                    "replaces": fs.url,
                },
            )
        else:
            # Replacement write failed — keep the failing source enabled rather
            # than strand the topic. Logged under category 'curator' so this run
            # still counts toward the source's cooldown (treated like a no-op
            # outcome, same as reject/no-candidate).
            log(
                "warn",
                "curator",
                f"replacement add failed for {fs.url!r}; leaving it enabled "
                f"(not quarantining) to avoid stranding topic {slug!r}",
                topic_slug=slug,
                metadata={
                    "source_url": fs.url,
                    "topic_slug": slug,
                    "action": "auto_add_failed",
                    "candidate_url": cand_url,
                },
            )
    else:
        # Candidate: quarantine old (or leave it if strand risk) + insert pending candidate
        quarantine_source(
            topic, fs.url, failure_class, now, client, adding_replacement=False
        )
        insert_candidate(
            topic=topic,
            url=cand_url,
            candidate_type=cand_type,
            replaces_url=fs.url,
            failure_class=failure_class,
            relevance_score=best_relevance,
            validation=best_validation,
            client=client,
        )
        summary["candidates_created"] += 1
        log(
            "info",
            "curator",
            f"created candidate {cand_url!r} for topic {slug!r} (awaiting approval)",
            topic_slug=slug,
            metadata={
                "source_url": cand_url,
                "topic_slug": slug,
                "action": "create_candidate",
                "relevance": best_relevance,
            },
        )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    result = run_curator_cycle()
    print(result)


if __name__ == "__main__":
    main()
