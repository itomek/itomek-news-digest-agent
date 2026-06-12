"""System prompt and per-topic prompt templates for the News Digest Agent.

The system prompt defines the agent's overall behavior. Per-topic prompt_hints
come from the Supabase digest_topics table and are injected at runtime.

The agent IS the summarizer (see CLAUDE.md): its native reasoning, steered by
SYSTEM_PROMPT plus the topic prompt_hint, produces the structured digest.
enforce_length keeps the output within a target word range, measuring over the
flattened prose representation. Output is plain text; the delivery and
formatting concern is intentionally deferred (CLAUDE.md), so the prompt does
not optimize for any particular medium.
"""

import hashlib
from collections.abc import Callable

SYSTEM_PROMPT = """You are a news digest agent. You produce a structured, \
readable news digest from a set of curated sources.

How to work:
1. Call list_topics to see the available topics, choose the one whose name best \
matches what the user asked for, and note its slug. Then call fetch_topic_config \
with that slug to get the sources and the prompt_hint for this topic.
2. If the topic's prompt_hint instructs you to deduplicate against another topic, \
call get_recent_digests with that topic's slug to retrieve its most recent digest. \
Do not repeat items already covered there.
3. Gather content from each source:
   - RSS or Atom feeds: call fetch_rss.
   - A specific article page: call parse_article — it returns clean body text \
with the navigation, ads, and footers already removed, which is what you want.
   - A listing or index page, or when you need the links on a page: call fetch_html.
   - Reddit sources ("type": "reddit"): call fetch_reddit with the subreddit, \
passing sort, limit, min_score, and time_filter when the source object has them. \
Reddit posts are secondary social_signal context: use them only to surface \
stories the primary sources missed, or to add a one-sentence community-reaction \
note in an item's detail. Never quote Reddit posts.
4. Read the gathered material and compose a structured digest:
   - A short top-level summary: one or two sentences capturing the most important \
theme or development across all items.
   - A ranked list of items. Each item must have:
     - "headline": a single descriptive line.
     - "blurb": one or two sentences describing what happened (shown to the reader \
in the collapsed view).
     - "detail": a fuller paragraph explaining why it matters, with specifics and \
numbers where available (shown when the reader expands the item).
     - "metadata": an object with a "sources" array of objects, each with a "title" \
and a "url" (for example: [{"title": "AI Blog", "url": "https://example.com"}]). \
Put source links only here — keep summary, blurb, and detail as clean prose with \
no raw URLs. You may also include an optional "tags" array of short strings.
   Rank items by significance. Explain why each item matters in the detail field. \
Stay factual and grounded in the gathered material. Never invent facts that \
were not in the sources. Skip dead sources and continue with the others.
5. When the digest is composed, you MUST call push_to_supabase to publish it. \
Call push_to_supabase with these arguments:
   - topic_slug: the slug from fetch_topic_config.
   - summary: the short top-level overview (one or two sentences).
   - items: the ranked list of items using the same item shape above \
(headline, blurb, detail, metadata.sources).
   - sources_used: the list of source URLs you actually used.
   - token_count: 0 (leave at zero; it will be updated automatically).
   - content: the full digest as a single prose string (summary followed by each \
item's headline, blurb, and detail joined with newlines). \
You MUST call push_to_supabase — do NOT put the digest or the intent to publish \
inside an answer field. The run is not complete until push_to_supabase succeeds.

Writing guidelines:
- Lead with the most significant item.
- Aim for a summary of one to two sentences and roughly three to seven items.
- Keep blurb concise (one to two sentences); use detail for context and numbers.
- If a source is unreachable or returns nothing useful, skip it and continue with \
the others."""


PROMPT_VERSION = "sp-" + hashlib.sha256(SYSTEM_PROMPT.encode()).hexdigest()[:12]


def count_words(text: str) -> int:
    """Count whitespace-separated words in text."""
    return len(text.split())


def flatten_digest(summary: str, items: list[dict]) -> str:
    """Produce a flat TTS-safe prose string from structured digest data.

    Generates the summary paragraph followed by one short paragraph per item
    (headline and blurb, with detail appended where present). Plain prose only —
    no URLs, no markdown. This is the canonical source of the ``content`` column.

    Args:
        summary: The top-level overview sentence(s).
        items: Ranked list of digest item dicts, each optionally containing
            ``headline``, ``blurb``, and ``detail`` keys.

    Returns:
        A single plain-prose string suitable for TTS consumption.
    """
    parts: list[str] = []
    if summary:
        parts.append(summary.strip())
    for item in items:
        headline = item.get("headline", "")
        blurb = item.get("blurb", "")
        detail = item.get("detail", "")
        segments = [s.strip() for s in (headline, blurb, detail) if s and s.strip()]
        if segments:
            parts.append(" ".join(segments))
    return "\n\n".join(parts)


def enforce_length(
    summary: str,
    items: list[dict],
    regenerate: Callable[[str], dict],
    *,
    min_words: int = 400,
    max_words: int = 960,
    target_low: int = 500,
    target_high: int = 800,
) -> tuple[str, list[dict]]:
    """Enforce the digest word-count target with a single corrective re-prompt.

    Measures word count over the flattened prose (``flatten_digest``) so the
    threshold applies to the reader-facing text. The target is roughly 500-800
    words; the accepted band is 400-960 (±20%). If the flattened text is within
    band it is returned unchanged. Otherwise ``regenerate`` is called exactly once
    with a short feedback instruction (never looping), and its result is returned.

    Args:
        summary: The top-level overview from the LLM.
        items: The ranked item list from the LLM.
        regenerate: Callable taking a feedback string and returning a dict with
            ``summary`` and ``items`` keys (e.g. a closure that re-invokes the
            LLM with the feedback appended).
        min_words: Lower bound of the accepted band.
        max_words: Upper bound of the accepted band.
        target_low: Lower bound named in the re-prompt feedback.
        target_high: Upper bound named in the re-prompt feedback.

    Returns:
        A ``(summary, items)`` tuple — original when in band, otherwise from the
        single regenerated result.
    """
    flat = flatten_digest(summary, items)
    n = count_words(flat)
    if min_words <= n <= max_words:
        return summary, items
    if n > max_words:
        feedback = (
            f"The previous digest was too long at {n} words. Rewrite it as "
            f"clear prose of roughly {target_low} to {target_high} words, "
            f"keeping only the most significant items."
        )
    else:
        feedback = (
            f"The previous digest was too short at {n} words. Rewrite it as "
            f"clear prose of roughly {target_low} to {target_high} words, "
            f"adding more context on why each item matters."
        )
    result = regenerate(feedback)
    return result.get("summary", ""), result.get("items", [])


# ---------------------------------------------------------------------------
# Per-item sentiment — world_news topic (issue #19)
# ---------------------------------------------------------------------------

#: Canonical sentiment values for the world_news topic, stored per item in
#: ``items[].metadata.sentiment`` (docs/architecture.md §7.2). Defined once
#: here so tests and any consumer share a single source of truth with the
#: prompt_hint in migration 0010 and the web renderer's badge whitelist.
SENTIMENT_TAGS: frozenset[str] = frozenset(
    {"positive", "negative", "neutral", "concerning"}
)


def extract_sentiment_tag(item: dict) -> str | None:
    """Extract the validated sentiment value from a digest item's metadata.

    Reads ``item["metadata"]["sentiment"]`` per the world_news contract
    (docs/architecture.md §7.2). Returns ``None`` when the item has no
    ``metadata``, no ``sentiment`` key, or a value outside ``SENTIMENT_TAGS``
    — never raises, so a malformed LLM answer degrades to "no sentiment".

    Args:
        item: A digest item dict (``headline``, ``blurb``, ``detail``,
            ``metadata`` keys).

    Returns:
        One of the four canonical sentiment strings, or ``None``.
    """
    metadata = item.get("metadata") or {}
    sentiment = metadata.get("sentiment")
    return sentiment if sentiment in SENTIMENT_TAGS else None
