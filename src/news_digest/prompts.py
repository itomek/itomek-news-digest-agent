"""System prompt and per-topic prompt templates for the News Digest Agent.

The system prompt defines the agent's overall behavior. Per-topic prompt_hints
come from the Supabase digest_topics table and are injected at runtime.

The agent IS the summarizer (see CLAUDE.md): its native reasoning, steered by
SYSTEM_PROMPT plus the topic prompt_hint, produces the digest. enforce_length
keeps the output within a target word range. Output is plain text; the delivery
and formatting concern is intentionally deferred (CLAUDE.md), so the prompt does
not optimize for any particular medium.
"""

import hashlib
from collections.abc import Callable

SYSTEM_PROMPT = """You are a news digest agent. You produce a concise, readable \
news digest from a set of curated sources.

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
4. Read the gathered material and write one coherent digest in your own words.
5. Call push_to_supabase to publish the finished digest, then log the result.

Writing guidelines:
- Write in clear, well-organized prose.
- Lead with the most significant item, then move to the next most important. For \
each item, explain what happened and why it matters. Do not try to cover \
everything; choose the items worth the reader's time.
- Stay factual and grounded in the gathered material. Never invent facts that \
were not in the sources.
- Aim for roughly 500 to 800 words.
- If a source is unreachable or returns nothing useful, skip it and continue with \
the others."""


PROMPT_VERSION = "sp-" + hashlib.sha256(SYSTEM_PROMPT.encode()).hexdigest()[:12]


def count_words(text: str) -> int:
    """Count whitespace-separated words in text."""
    return len(text.split())


def enforce_length(
    text: str,
    regenerate: Callable[[str], str],
    *,
    min_words: int = 400,
    max_words: int = 960,
    target_low: int = 500,
    target_high: int = 800,
) -> str:
    """Enforce the digest word-count target with a single corrective re-prompt.

    The target is roughly 500-800 words; the accepted band is 400-960 (±20%).
    If text is within band, it is returned unchanged. Otherwise regenerate is
    called exactly once with a short feedback instruction (never looping), and
    its result is returned as-is.

    Args:
        text: The generated digest.
        regenerate: Callable taking a feedback string and returning new text
            (e.g. a closure that re-invokes the LLM with the feedback appended).
        min_words: Lower bound of the accepted band.
        max_words: Upper bound of the accepted band.
        target_low: Lower bound named in the re-prompt feedback.
        target_high: Upper bound named in the re-prompt feedback.

    Returns:
        The original text when in band, otherwise the single regenerated result.
    """
    n = count_words(text)
    if min_words <= n <= max_words:
        return text
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
    return regenerate(feedback)
