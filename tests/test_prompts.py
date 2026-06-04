"""Tests for src/news_digest/prompts.py — issue #7 (audio-first prompts)."""

import hashlib

from news_digest.prompts import (
    PROMPT_VERSION,
    SYSTEM_PROMPT,
    count_words,
    enforce_length,
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
# enforce_length — one re-prompt on out-of-range (500-800 words ±20% → 400-960)
# ---------------------------------------------------------------------------


def test_enforce_length_returns_original_within_range_without_reprompt():
    text = " ".join(["word"] * 600)
    calls = []

    def regen(feedback):
        calls.append(feedback)
        return "REGENERATED"

    assert enforce_length(text, regen) == text
    assert calls == []  # in range → no re-prompt


def test_enforce_length_reprompts_once_when_too_long():
    text = " ".join(["word"] * 1000)  # > 960
    calls = []

    def regen(feedback):
        calls.append(feedback)
        return "shorter result"

    result = enforce_length(text, regen)
    assert len(calls) == 1
    assert "long" in calls[0].lower()
    assert result == "shorter result"


def test_enforce_length_reprompts_once_when_too_short():
    text = " ".join(["word"] * 100)  # < 400
    calls = []

    def regen(feedback):
        calls.append(feedback)
        return "a much longer result"

    result = enforce_length(text, regen)
    assert len(calls) == 1
    assert "short" in calls[0].lower()
    assert result == "a much longer result"


def test_enforce_length_reprompts_at_most_once_even_if_still_out_of_range():
    text = " ".join(["word"] * 50)
    calls = []

    def regen(feedback):
        calls.append(feedback)
        return "still short"  # 2 words, still out of range

    result = enforce_length(text, regen)
    assert len(calls) == 1  # exactly one re-prompt — never loops
    assert result == "still short"


# ---------------------------------------------------------------------------
# PROMPT_VERSION
# ---------------------------------------------------------------------------


def test_prompt_version_is_deterministic_identity_of_system_prompt():
    assert isinstance(PROMPT_VERSION, str) and PROMPT_VERSION
    expected = "sp-" + hashlib.sha256(SYSTEM_PROMPT.encode()).hexdigest()[:12]
    assert PROMPT_VERSION == expected


# ---------------------------------------------------------------------------
# SYSTEM_PROMPT — describes the tool workflow; audio layer fully removed
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
