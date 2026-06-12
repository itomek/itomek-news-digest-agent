"""Tests for src/news_digest/prompts.py — issue #7 (audio-first prompts), #58 (structured output)."""

import hashlib

from news_digest.prompts import (
    PROMPT_VERSION,
    SENTIMENT_TAGS,
    SYSTEM_PROMPT,
    count_words,
    enforce_length,
    extract_sentiment_tag,
    flatten_digest,
)

# ---------------------------------------------------------------------------
# count_words
# ---------------------------------------------------------------------------


def test_count_words_counts_whitespace_separated_tokens():
    assert count_words("one two three") == 3
    assert count_words("  leading and   trailing  ") == 3
    assert count_words("") == 0
    assert count_words("   ") == 0


# ---------------------------------------------------------------------------
# flatten_digest — issue #58
# ---------------------------------------------------------------------------


def _sample_items() -> list[dict]:
    return [
        {
            "headline": "AI Corp releases Model X",
            "blurb": "AI Corp announced Model X today. It beats previous benchmarks.",
            "detail": "Model X scores 95 on MMLU. The team trained for six months.",
            "metadata": {
                "sources": [{"title": "AI Blog", "url": "https://example.com/blog"}],
            },
        },
        {
            "headline": "Open Source rival emerges",
            "blurb": "A new open-source model matches commercial offerings.",
            "detail": "Released under Apache 2. Fine-tuning kits ship next week.",
            "metadata": {
                "sources": [{"title": "GitHub", "url": "https://github.com/org/repo"}],
                "tags": ["open-source"],
            },
        },
    ]


def test_flatten_digest_includes_headlines_and_blurbs():
    items = _sample_items()
    result = flatten_digest("Top summary here.", items)
    assert "AI Corp releases Model X" in result
    assert "beats previous benchmarks" in result
    assert "open-source model matches" in result


def test_flatten_digest_contains_no_urls():
    items = _sample_items()
    result = flatten_digest("Summary.", items)
    assert "http" not in result
    assert "https" not in result


def test_flatten_digest_is_deterministic():
    items = _sample_items()
    assert flatten_digest("S", items) == flatten_digest("S", items)


def test_flatten_digest_empty_items_returns_summary():
    result = flatten_digest("Only summary text.", [])
    assert "Only summary text" in result


def test_flatten_digest_handles_missing_optional_keys():
    # item with no 'detail', no 'metadata'
    items = [{"headline": "A thing happened", "blurb": "It was notable."}]
    result = flatten_digest("Summary.", items)
    assert "A thing happened" in result
    assert "It was notable." in result


def test_flatten_digest_contains_no_markdown():
    items = _sample_items()
    result = flatten_digest("Summary.", items)
    assert "**" not in result
    assert "#" not in result
    assert "[" not in result


# ---------------------------------------------------------------------------
# enforce_length — adapted for structured shape (issue #58)
# ---------------------------------------------------------------------------


def _make_items(total_blurb_words: int) -> list[dict]:
    """Build a list of items whose flattened blurb fills roughly total_blurb_words words."""
    word = "word"
    blurb = " ".join([word] * (total_blurb_words // 2))
    detail = " ".join([word] * (total_blurb_words // 2))
    return [
        {
            "headline": "Headline",
            "blurb": blurb,
            "detail": detail,
            "metadata": {"sources": []},
        }
    ]


def test_enforce_length_returns_original_within_range_without_reprompt():
    # summary (~50 words) + items (~550 words) = ~600 total, in range
    summary = " ".join(["word"] * 50)
    items = _make_items(550)
    calls = []

    def regen(feedback):
        calls.append(feedback)
        return {"summary": "REGENERATED", "items": []}

    assert enforce_length(summary, items, regen) == (summary, items)
    assert calls == []


def test_enforce_length_reprompts_once_when_too_long():
    summary = " ".join(["word"] * 100)
    items = _make_items(900)  # together > 960
    calls = []

    def regen(feedback):
        calls.append(feedback)
        return {"summary": "shorter", "items": []}

    result = enforce_length(summary, items, regen)
    assert len(calls) == 1
    assert "long" in calls[0].lower()
    assert result == ("shorter", [])


def test_enforce_length_reprompts_once_when_too_short():
    summary = " ".join(["word"] * 10)
    items = _make_items(50)  # together < 400
    calls = []

    def regen(feedback):
        calls.append(feedback)
        return {"summary": "a much longer result", "items": _make_items(400)}

    result = enforce_length(summary, items, regen)
    assert len(calls) == 1
    assert "short" in calls[0].lower()
    assert result[0] == "a much longer result"


def test_enforce_length_reprompts_at_most_once_even_if_still_out_of_range():
    summary = " ".join(["word"] * 5)
    items = _make_items(20)  # < 400
    calls = []

    def regen(feedback):
        calls.append(feedback)
        return {"summary": "still", "items": []}  # still short

    result = enforce_length(summary, items, regen)
    assert len(calls) == 1  # exactly one re-prompt — never loops
    assert result == ("still", [])


# ---------------------------------------------------------------------------
# PROMPT_VERSION
# ---------------------------------------------------------------------------


def test_prompt_version_is_deterministic_identity_of_system_prompt():
    assert isinstance(PROMPT_VERSION, str) and PROMPT_VERSION
    expected = "sp-" + hashlib.sha256(SYSTEM_PROMPT.encode()).hexdigest()[:12]
    assert PROMPT_VERSION == expected


# ---------------------------------------------------------------------------
# SYSTEM_PROMPT — describes structured output contract; audio layer fully removed
# ---------------------------------------------------------------------------


def test_system_prompt_describes_workflow_without_audio_layer():
    sp = SYSTEM_PROMPT.lower()
    # workflow guidance present
    assert "digest" in sp
    assert "list_topics" in sp and "fetch_topic_config" in sp
    assert "why it matters" in sp
    # dedup step present (issue #16)
    assert "get_recent_digests" in sp or "deduplicat" in sp
    # audio layer fully removed (issue #7 de-scoped — CLAUDE.md defers delivery)
    assert "audio" not in sp
    assert "read aloud" not in sp
    assert "news anchor" not in sp


def test_system_prompt_describes_structured_output_contract():
    sp = SYSTEM_PROMPT
    # structured output keywords must be present
    assert "summary" in sp
    assert "items" in sp
    assert "headline" in sp
    assert "blurb" in sp
    assert "detail" in sp
    assert "sources" in sp


def test_system_prompt_step3_wires_fetch_reddit_as_secondary_signal():
    """Step 3 must map "type": "reddit" sources to the fetch_reddit tool and
    mark Reddit results as secondary social_signal context (issue #21)."""
    sp = SYSTEM_PROMPT
    sp_lower = sp.lower()
    assert "fetch_reddit" in sp
    assert '"type": "reddit"' in sp or "type: reddit" in sp_lower
    assert "social_signal" in sp
    # Reddit posts must never be quoted directly.
    assert "never quote reddit" in sp_lower


def test_system_prompt_instructs_final_answer_json_not_publish_tool():
    sp = SYSTEM_PROMPT
    sp_lower = sp.lower()
    # The model returns the digest as its FINAL ANSWER (JSON), not via a tool call.
    assert "final answer" in sp_lower
    assert "topic_slug" in sp
    assert "sources_used" in sp
    # It must NOT instruct the model to publish via push_to_supabase anymore.
    assert "push_to_supabase" not in sp


def test_system_prompt_requires_complete_digest_in_final_answer():
    """Reliability nudge for #44, within the #59 answer-JSON contract: the
    model MUST end with the complete digest in the fenced JSON answer — never
    empty/partial, never a bare unfenced object."""
    sp = SYSTEM_PROMPT
    sp_lower = sp.lower()
    assert "must contain the complete digest" in sp_lower
    assert "never an empty or partial answer" in sp_lower
    assert "outside the fence" in sp_lower
    # Still strictly answer-driven: no publish tool call.
    assert "do not call any tool to publish" in sp_lower


# ---------------------------------------------------------------------------
# Per-item sentiment — issue #19 (world_news topic, metadata.sentiment contract)
# ---------------------------------------------------------------------------


def test_sentiment_tags_contains_exactly_four_values():
    assert SENTIMENT_TAGS == {"positive", "negative", "neutral", "concerning"}


def test_extract_sentiment_tag_reads_metadata_sentiment():
    item = {
        "headline": "Test",
        "blurb": "A thing.",
        "detail": "Details.",
        "metadata": {
            "sources": [],
            "sentiment": "concerning",
            "tags": ["geopolitics"],
        },
    }
    assert extract_sentiment_tag(item) == "concerning"


def test_extract_sentiment_tag_accepts_all_four_values():
    for tag in ("positive", "negative", "neutral", "concerning"):
        item = {"headline": "T", "metadata": {"sentiment": tag}}
        assert extract_sentiment_tag(item) == tag


def test_extract_sentiment_tag_rejects_unknown_values():
    for bad in ("", "good", "bad", "POSITIVE", "Neutral", "risk", 7, None):
        item = {"headline": "T", "metadata": {"sentiment": bad}}
        assert extract_sentiment_tag(item) is None, f"{bad!r} should be rejected"


def test_extract_sentiment_tag_ignores_tags_array():
    # Sentiment lives in metadata.sentiment, NOT in tags[0] — a tags array
    # containing a sentiment word must not be picked up.
    item = {"headline": "T", "metadata": {"tags": ["concerning", "geopolitics"]}}
    assert extract_sentiment_tag(item) is None


def test_extract_sentiment_tag_returns_none_when_sentiment_key_absent():
    item = {"headline": "Test", "metadata": {"sources": []}}
    assert extract_sentiment_tag(item) is None


def test_extract_sentiment_tag_returns_none_when_metadata_absent():
    item = {"headline": "Test"}
    assert extract_sentiment_tag(item) is None


def test_extract_sentiment_tag_returns_none_when_metadata_is_none():
    item = {"headline": "Test", "metadata": None}
    assert extract_sentiment_tag(item) is None


# ---------------------------------------------------------------------------
# world_news rolling-window dedup — verify SYSTEM_PROMPT wires get_recent_digests
# for self-dedup (the world_news prompt_hint relies on the step-2 instruction)
# ---------------------------------------------------------------------------


def test_system_prompt_step2_covers_self_dedup_via_get_recent_digests():
    """SYSTEM_PROMPT step 2 already instructs get_recent_digests dedup; the
    world_news prompt_hint can request limit=2 for two prior digests — verify
    the system prompt supports that without code changes."""
    sp = SYSTEM_PROMPT
    # Step 2 references get_recent_digests so prompt_hint instructions work.
    assert "get_recent_digests" in sp
    # The system prompt does not hard-code any slug — topic slug comes from
    # prompt_hint, keeping Python code topic-agnostic.
    assert "world_news" not in sp


def test_world_news_migration_file_exists():
    """The migration seed file for world_news must exist so the orchestrator
    can apply it."""
    import pathlib

    migrations = pathlib.Path(__file__).parent.parent / "supabase" / "migrations"
    files = list(migrations.glob("*world_news*"))
    assert files, "No migration file found matching *world_news*"
    # Must follow the sequential naming pattern (4-digit prefix).
    for f in files:
        assert f.name[:4].isdigit(), f"Migration {f.name} does not start with 4 digits"


def test_world_news_migration_contains_since_hours_72():
    """The prompt_hint in the migration must instruct the agent to use the
    72-hour rolling window (since_hours=72)."""
    import pathlib

    migrations = pathlib.Path(__file__).parent.parent / "supabase" / "migrations"
    world_news_file = next(migrations.glob("0010_*world_news*"))
    content = world_news_file.read_text()
    assert "since_hours=72" in content or "since_hours = 72" in content


def test_world_news_migration_instructs_self_dedup_limit_2():
    """The prompt_hint must instruct the agent to call get_recent_digests with
    limit=2 for deduplication against the last two world_news digests."""
    import pathlib

    migrations = pathlib.Path(__file__).parent.parent / "supabase" / "migrations"
    world_news_file = next(migrations.glob("0010_*world_news*"))
    content = world_news_file.read_text()
    assert "world_news" in content
    assert "limit=2" in content


def test_world_news_migration_instructs_english_output():
    """The prompt_hint must instruct the agent to write in English regardless
    of the source language (Polish sources must be translated inline)."""
    import pathlib

    migrations = pathlib.Path(__file__).parent.parent / "supabase" / "migrations"
    world_news_file = next(migrations.glob("0010_*world_news*"))
    content = world_news_file.read_text()
    assert "english" in content.lower() or "English" in content


def test_world_news_migration_instructs_metadata_sentiment_key():
    """The prompt_hint must instruct the LLM to emit metadata.sentiment (a
    dedicated key, not tags[0]) with the four canonical values."""
    import pathlib

    migrations = pathlib.Path(__file__).parent.parent / "supabase" / "migrations"
    world_news_file = next(migrations.glob("0010_*world_news*"))
    content = world_news_file.read_text()
    assert '"sentiment"' in content
    for tag in SENTIMENT_TAGS:
        assert tag in content, f"sentiment value {tag!r} missing from prompt_hint"
    # Must explicitly steer away from the tags-array encoding.
    assert "Do not put sentiment in the tags array" in content


def test_world_news_migration_lists_six_rss_sources():
    """The sources JSON in the migration must contain exactly six RSS feed URLs."""
    import json
    import pathlib
    import re

    migrations = pathlib.Path(__file__).parent.parent / "supabase" / "migrations"
    world_news_file = next(migrations.glob("0010_*world_news*"))
    content = world_news_file.read_text()
    # Extract the JSON array from between the single-quoted literals.
    match = re.search(r"'\s*(\[.*?\])\s*'::", content, re.DOTALL)
    assert match, "Could not extract sources JSON from migration"
    sources = json.loads(match.group(1))
    rss_sources = [s for s in sources if s.get("type") == "rss"]
    assert len(rss_sources) == 6, f"Expected 6 RSS sources, found {len(rss_sources)}"


def test_world_news_concise_hint_migration_is_guarded():
    """0014 bounds the world_news digest size (truncation defense) and must be
    idempotent: the not-like guard keys on the same phrase it appends."""
    import pathlib

    migrations = pathlib.Path(__file__).parent.parent / "supabase" / "migrations"
    f = migrations / "0014_world_news_concise_hint.sql"
    content = f.read_text()
    assert "5 most significant stories" in content
    assert "not like '%5 most significant stories%'" in content
    assert "slug = 'world_news'" in content
