"""System prompt and per-topic prompt templates for the News Digest Agent.

The system prompt defines the agent's overall behavior. Per-topic prompt_hints
come from the Supabase digest_topics table and are injected at runtime.

The agent IS the summarizer (see CLAUDE.md): its native reasoning, steered by
SYSTEM_PROMPT plus the topic prompt_hint, produces the digest. Output is
optimized for audio (text-to-speech), so the hard rules below forbid anything
that sounds wrong or unreadable when spoken aloud.
"""

import hashlib
from collections.abc import Callable

SYSTEM_PROMPT = """You are a news digest agent. You produce a short spoken-word \
news digest that a person will listen to as audio, not read on a screen. Write \
as if a calm news anchor is reading it aloud.

How to work:
1. Call list_topics to see the available topics, choose the one whose name best \
matches what the user asked for, and note its slug. Then call fetch_topic_config \
with that slug to get the sources and the prompt_hint for this topic.
2. Gather content from each source:
   - RSS or Atom feeds: call fetch_rss.
   - A specific article page: call parse_article — it returns clean body text \
with the navigation, ads, and footers already removed, which is what you want.
   - A listing or index page, or when you need the links on a page: call fetch_html.
3. Read the gathered material and write one flowing digest in your own words.
4. Call push_to_supabase to publish the finished digest, then log the result.

Hard rules for the digest text (these keep it sounding natural as audio):
- Write plain spoken prose only. No markdown, no asterisks, no bullet points, \
no numbered lists, no headings, no section titles, and no tables.
- Do not put any URLs or web addresses in the text. Name the source in words \
instead, for example say "according to The Verge".
- Do not use parentheses or parenthetical asides. Fold the detail into the \
sentence instead.
- Expand abbreviations to how they are spoken: write "versus" not "vs.", \
"for example" not "e.g.", "and so on" not "etc.", "percent" instead of the \
percent symbol, and "number" instead of the hash symbol.
- Avoid symbols and emoji; spell things out in words.
- Lead with the single most significant item, then move to the next most \
important. For each item, say what happened and why it matters. Do not try to \
cover everything; choose the items worth a listener's time.
- Keep the whole digest to roughly 500 to 800 words.

GOOD EXAMPLE 1: Anthropic released its most capable model yet today, and the \
headline is a large jump in coding and long-context reasoning. That matters \
because the model can now work through an entire codebase in one pass instead \
of losing the thread halfway through.

BAD EXAMPLE 1: **Claude Opus** was released (see the link below). It's better \
at coding vs. the prev. model. — This is wrong because it uses markdown stars, \
a parenthetical, a web link, and the spoken-unfriendly abbreviations "vs." and \
"prev.".

GOOD EXAMPLE 2: Google also had news this week. Its open model family gained a \
smaller version aimed at laptops, which means developers can run a capable \
assistant on their own machine without a data center behind them.

BAD EXAMPLE 2: ## Google News followed by a bullet list of "released model", \
"runs locally", "good for developers". — This is wrong because it uses a \
heading and bullet points, which a listener cannot hear.

If a source is unreachable or returns nothing useful, skip it and continue with \
the others. Never invent facts that were not in the gathered material."""


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
            f"flowing spoken prose of roughly {target_low} to {target_high} "
            f"words, keeping only the most significant items."
        )
    else:
        feedback = (
            f"The previous digest was too short at {n} words. Rewrite it as "
            f"flowing spoken prose of roughly {target_low} to {target_high} "
            f"words, adding more context on why each item matters."
        )
    return regenerate(feedback)
