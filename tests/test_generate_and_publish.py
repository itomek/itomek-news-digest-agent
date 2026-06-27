"""Tests for the Python-side publish path — issue #58 design change.

Local models do not reliably emit a final push_to_supabase tool call, so the
model returns the structured digest as its final answer and Python parses it.
``_publish_from_result`` is the unit-testable parser+publisher; these tests drive
it with synthetic process_query results matching the live Gemma shape.
"""

import json

import pytest

from news_digest import agent as agent_module
from news_digest.agent import _publish_from_result


@pytest.fixture(autouse=True)
def _capture_push(monkeypatch):
    """Replace push_to_supabase with a recorder; return the call log."""
    calls = []

    def _fake_push(topic_slug, *, summary, items, sources_used, token_count):
        calls.append(
            {
                "topic_slug": topic_slug,
                "summary": summary,
                "items": items,
                "sources_used": sources_used,
                "token_count": token_count,
            }
        )
        return {"success": True, "id": "row-1", "digest_date": "2026-06-10"}

    monkeypatch.setattr(agent_module, "push_to_supabase", _fake_push)
    return calls


@pytest.fixture(autouse=True)
def _silence_log(monkeypatch):
    """Keep the parser's error logging from touching Supabase/SQLite in tests.

    Returns the captured log call list so individual tests can assert on it.
    """
    calls = []
    monkeypatch.setattr(agent_module, "log", lambda *a, **k: calls.append((a, k)))
    return calls


@pytest.fixture()
def log_calls(_silence_log):
    """Expose captured log calls to tests that inspect them."""
    return _silence_log


_ITEMS = [
    {
        "headline": "AI Corp ships Model X",
        "blurb": "A new frontier model. Beats prior baselines.",
        "detail": "Scores 95 on MMLU after six months of training.",
        "metadata": {"sources": [{"title": "Blog", "url": "https://example.com"}]},
    }
]


def _answer_payload(include_slug: bool = True) -> dict:
    digest = {
        "summary": "Top AI news today.",
        "items": _ITEMS,
        "sources_used": ["https://example.com"],
    }
    if include_slug:
        digest["topic_slug"] = "ai_models"
    return digest


# ---------------------------------------------------------------------------
# Clean answer (digest nested under "answer", topic_slug present)
# ---------------------------------------------------------------------------


def test_publish_clean_nested_answer(_capture_push):
    raw = json.dumps(
        {
            "thought": "done",
            "goal": "digest",
            "answer": _answer_payload(),
        }
    )
    result = {
        "status": "success",
        "result": raw,
        "conversation": [],
        "output_tokens": 742,
    }
    out = _publish_from_result(result)
    assert out["success"] is True
    assert len(_capture_push) == 1
    call = _capture_push[0]
    assert call["topic_slug"] == "ai_models"
    assert call["summary"] == "Top AI news today."
    assert call["items"] == _ITEMS
    assert call["sources_used"] == ["https://example.com"]
    assert call["token_count"] == 742


# ---------------------------------------------------------------------------
# Top-level digest (no "answer" wrapper)
# ---------------------------------------------------------------------------


def test_publish_top_level_digest(_capture_push):
    raw = json.dumps(_answer_payload())
    result = {"status": "success", "result": raw, "output_tokens": 10}
    out = _publish_from_result(result)
    assert out["success"] is True
    assert _capture_push[0]["topic_slug"] == "ai_models"
    assert _capture_push[0]["token_count"] == 10


# ---------------------------------------------------------------------------
# Markdown-fenced answer (```json ... ```)
# ---------------------------------------------------------------------------


def test_publish_json_fenced_answer(_capture_push):
    inner = json.dumps({"answer": _answer_payload()})
    raw = f"```json\n{inner}\n```"
    result = {"status": "success", "result": raw, "output_tokens": 5}
    out = _publish_from_result(result)
    assert out["success"] is True
    assert _capture_push[0]["summary"] == "Top AI news today."


def test_publish_bare_fenced_answer(_capture_push):
    inner = json.dumps(_answer_payload())
    raw = f"```\n{inner}\n```"
    result = {"status": "success", "result": raw, "output_tokens": 0}
    out = _publish_from_result(result)
    assert out["success"] is True
    assert _capture_push[0]["topic_slug"] == "ai_models"


# ---------------------------------------------------------------------------
# topic_slug missing from JSON → recovered from fetch_topic_config call
# ---------------------------------------------------------------------------


def test_publish_recovers_slug_from_conversation(_capture_push):
    raw = json.dumps({"answer": _answer_payload(include_slug=False)})
    result = {
        "status": "success",
        "result": raw,
        "conversation": [
            {"role": "user", "content": "Generate the AI digest"},
            {
                "role": "tool",
                "name": "fetch_topic_config",
                "tool_args": {"slug": "ai_models"},
                "content": {"slug": "ai_models", "cadence": "24h"},
            },
            {"role": "assistant", "content": raw},
        ],
        "output_tokens": 99,
    }
    out = _publish_from_result(result)
    assert out["success"] is True
    assert _capture_push[0]["topic_slug"] == "ai_models"


def test_publish_uses_last_fetch_topic_config_when_multiple(_capture_push):
    raw = json.dumps(_answer_payload(include_slug=False))
    result = {
        "status": "success",
        "result": raw,
        "conversation": [
            {
                "role": "tool",
                "name": "fetch_topic_config",
                "tool_args": {"slug": "old"},
            },
            {
                "role": "tool",
                "name": "fetch_topic_config",
                "tool_args": {"slug": "ai_models"},
            },
        ],
        "output_tokens": 1,
    }
    out = _publish_from_result(result)
    assert out["success"] is True
    assert _capture_push[0]["topic_slug"] == "ai_models"


# ---------------------------------------------------------------------------
# Failure paths → error dict, push never called, never raises
# ---------------------------------------------------------------------------


def test_publish_malformed_json_returns_error(_capture_push):
    result = {"status": "success", "result": "not json {{{", "output_tokens": 0}
    out = _publish_from_result(result)
    assert out["success"] is False
    assert out["error"] == "parse_error"
    assert _capture_push == []


def test_publish_missing_summary_returns_error(_capture_push):
    raw = json.dumps({"topic_slug": "ai_models", "items": _ITEMS})
    result = {"status": "success", "result": raw, "output_tokens": 0}
    out = _publish_from_result(result)
    assert out["success"] is False
    assert out["error"] == "missing_fields"
    assert _capture_push == []


def test_publish_missing_slug_everywhere_returns_error(_capture_push):
    raw = json.dumps(_answer_payload(include_slug=False))
    result = {
        "status": "success",
        "result": raw,
        "conversation": [],
        "output_tokens": 0,
    }
    out = _publish_from_result(result)
    assert out["success"] is False
    assert out["error"] == "missing_fields"
    assert _capture_push == []


def test_publish_no_answer_string_returns_error(_capture_push):
    result = {"status": "failed", "result": "", "output_tokens": 0}
    out = _publish_from_result(result)
    assert out["success"] is False
    assert out["error"] == "no_answer"
    assert _capture_push == []


def test_publish_non_object_answer_returns_error(_capture_push):
    raw = json.dumps(["not", "an", "object"])
    result = {"status": "success", "result": raw, "output_tokens": 0}
    out = _publish_from_result(result)
    assert out["success"] is False
    assert out["error"] == "bad_answer_shape"
    assert _capture_push == []


def test_publish_defaults_sources_used_to_empty_list(_capture_push):
    raw = json.dumps({"topic_slug": "ai_models", "summary": "S", "items": _ITEMS})
    result = {"status": "success", "result": raw, "output_tokens": 0}
    out = _publish_from_result(result)
    assert out["success"] is True
    assert _capture_push[0]["sources_used"] == []


# ---------------------------------------------------------------------------
# generate_and_publish wires process_query -> _publish_from_result
# ---------------------------------------------------------------------------


def test_generate_and_publish_calls_process_query_then_publishes(
    monkeypatch, _capture_push
):
    from news_digest.agent import NewsDigestAgent

    raw = json.dumps({"answer": _answer_payload()})
    fake_result = {
        "status": "success",
        "result": raw,
        "conversation": [],
        "output_tokens": 321,
    }

    # Uninitialized instance avoids needing live Lemonade/Supabase settings.
    agent = NewsDigestAgent.__new__(NewsDigestAgent)
    monkeypatch.setattr(
        NewsDigestAgent,
        "process_query",
        lambda self, query: fake_result,
    )

    out = agent.generate_and_publish("Generate the AI digest")
    assert out["success"] is True
    assert _capture_push[0]["topic_slug"] == "ai_models"
    assert _capture_push[0]["token_count"] == 321


# ---------------------------------------------------------------------------
# Answer returned as a fenced ```json string (Qwen shape; also avoids GAIA's
# planning-guard, which calls .lower() on a bare-dict answer and crashes)
# ---------------------------------------------------------------------------


def test_publish_answer_is_fenced_json_string(_capture_push):
    inner = "```json\n" + json.dumps(_answer_payload()) + "\n```"
    raw = json.dumps({"thought": "done", "answer": inner})
    result = {
        "status": "success",
        "result": raw,
        "conversation": [],
        "output_tokens": 7,
    }

    out = _publish_from_result(result)

    assert out["success"] is True
    assert len(_capture_push) == 1
    assert _capture_push[0]["topic_slug"] == "ai_models"
    assert _capture_push[0]["summary"] == "Top AI news today."
    assert _capture_push[0]["token_count"] == 7


# ---------------------------------------------------------------------------
# LLM error-fallback detection — Change 2 (GAIA 400 "2+ assistant messages")
# ---------------------------------------------------------------------------

# The exact string GAIA emits when the LLM call returns HTTP 400 and the
# conversation has two consecutive assistant turns.
_GAIA_400_FALLBACK = (
    "Sorry, I ran into an unexpected problem. This might be a temporary issue"
    " — try again in a moment.\n\n"
    "*Technical details: Error in chat completions (status 400):"
    " ...Cannot have 2 or more assistant messages..."
)


def test_llm_error_response_returns_llm_error_not_parse_error(_capture_push, log_calls):
    """GAIA error-fallback string → error='llm_error', not 'parse_error'.

    When the LLM returns a 400 "2+ assistant messages" error, GAIA wraps it in a
    user-facing "Sorry, I ran into an unexpected problem" string.  This must be
    classified as llm_error (upstream LLM failure) rather than parse_error
    (which would imply the model produced garbled JSON).
    """
    result = {
        "status": "failed",
        "result": _GAIA_400_FALLBACK,
        "output_tokens": 0,
    }
    out = _publish_from_result(result)

    assert out == {"success": False, "error": "llm_error"}
    assert _capture_push == [], "push_to_supabase must not be called on llm_error"

    # Log message must mention the new classification, NOT "could not parse final answer"
    logged_messages = [a[2] for (a, _) in log_calls if len(a) >= 3]
    assert any("LLM returned an error response" in m for m in logged_messages), (
        f"expected llm_error log message, got: {logged_messages}"
    )
    assert not any("could not parse final answer" in m for m in logged_messages), (
        "must not emit the parse_error message for a GAIA error-fallback string"
    )


def test_llm_error_response_case_insensitive_match(_capture_push):
    """Match is case-insensitive on the stripped text."""
    # All-caps variant — unlikely in practice but the spec says case-insensitive.
    raw = "SORRY, I RAN INTO AN UNEXPECTED PROBLEM — Error in chat completions (status 400)"
    result = {"status": "failed", "result": raw, "output_tokens": 0}
    out = _publish_from_result(result)
    assert out == {"success": False, "error": "llm_error"}
    assert _capture_push == []


def test_llm_error_match_by_contains_error_in_chat_completions(_capture_push):
    """Also matches when the string contains 'Error in chat completions' anywhere."""
    raw = "Something went wrong. Error in chat completions (status 400): bad request."
    result = {"status": "failed", "result": raw, "output_tokens": 0}
    out = _publish_from_result(result)
    assert out == {"success": False, "error": "llm_error"}
    assert _capture_push == []


def test_non_matching_malformed_json_still_returns_parse_error(
    _capture_push, log_calls
):
    """Regression guard: a genuine bad-JSON string (no GAIA error pattern) → parse_error.

    This must not regress: any non-matching string that fails json.loads must still
    go through the existing path and return error='parse_error'.
    """
    result = {"status": "success", "result": "{bad json", "output_tokens": 0}
    out = _publish_from_result(result)

    assert out == {"success": False, "error": "parse_error"}
    assert _capture_push == []

    logged_messages = [a[2] for (a, _) in log_calls if len(a) >= 3]
    assert any("could not parse final answer" in m for m in logged_messages), (
        "parse_error path must still log 'could not parse final answer'"
    )
    assert not any("LLM returned an error response" in m for m in logged_messages)


# ---------------------------------------------------------------------------
# json_repair hardening — malformed JSON the heavy model emits (unquoted
# keys/values), recovered before giving up. See agent._repair_json_text.
# ---------------------------------------------------------------------------


def test_repair_json_text_recovers_unquoted_keys_and_values():
    """A tool call with unquoted keys/values (real Qwen shape) is recovered."""
    from news_digest.agent import _repair_json_text

    malformed = (
        '{"thought": found the f1 topic, goal: Fetch config, '
        "tool: fetch_topic_config, tool_args: {slug: f1}}"
    )
    out = _repair_json_text(malformed)
    assert out["tool"] == "fetch_topic_config"
    assert out["tool_args"] == {"slug": "f1"}


def test_repair_json_text_returns_none_for_non_dict():
    """Pure garbage / arrays must not be coerced into a dict (stay parse_error)."""
    from news_digest.agent import _repair_json_text

    assert _repair_json_text("not json {{{") is None
    assert _repair_json_text("{bad json") is None
    assert _repair_json_text("[1, 2, 3]") is None


def test_is_actionable_response():
    from news_digest.agent import _is_actionable_response

    assert _is_actionable_response({"tool": "fetch_rss", "tool_args": {}})
    assert _is_actionable_response({"answer": "the digest"})
    assert _is_actionable_response({"plan": [{"tool": "x", "tool_args": {}}]})
    assert _is_actionable_response({"summary": "s", "items": _ITEMS})
    # A null-tool response is NOT actionable — feeding it back to GAIA loops.
    assert not _is_actionable_response({"thought": "t", "tool": None, "tool_args": {}})
    assert not _is_actionable_response({})
    # An empty/null answer is NOT actionable either (truthy check, not presence).
    assert not _is_actionable_response({"answer": ""})
    assert not _is_actionable_response({"answer": None})


def test_publish_repairs_unquoted_top_level_digest(_capture_push):
    """result['result'] is a digest with an unquoted value → repaired & published."""
    raw = (
        '{"topic_slug": "ai_models", "summary": Top AI news today, "items": '
        + json.dumps(_ITEMS)
        + ', "sources_used": ["https://example.com"]}'
    )
    result = {"status": "success", "result": raw, "output_tokens": 3}
    out = _publish_from_result(result)

    assert out["success"] is True
    assert _capture_push[0]["topic_slug"] == "ai_models"
    assert _capture_push[0]["summary"] == "Top AI news today"


def test_publish_repairs_malformed_nested_answer(_capture_push):
    """A malformed (unquoted slug) digest nested under 'answer' is recovered."""
    inner = (
        '{topic_slug: ai_models, "summary": "S", "items": '
        + json.dumps(_ITEMS)
        + ', "sources_used": []}'
    )
    raw = json.dumps({"thought": "done", "answer": inner})
    result = {
        "status": "success",
        "result": raw,
        "conversation": [],
        "output_tokens": 1,
    }
    out = _publish_from_result(result)

    assert out["success"] is True
    assert _capture_push[0]["topic_slug"] == "ai_models"


# ---------------------------------------------------------------------------
# _parse_llm_response override — repair before GAIA's parser sees the response
# ---------------------------------------------------------------------------


def _bare_agent():
    """Construct a NewsDigestAgent without running __init__ (no Lemonade/DB)."""
    from news_digest.agent import NewsDigestAgent

    return NewsDigestAgent.__new__(NewsDigestAgent)


def test_parse_llm_response_repairs_malformed_tool_call(monkeypatch):
    """A malformed tool call is repaired to valid JSON before the base parser."""
    from gaia.agents.base.agent import Agent

    seen = {}
    monkeypatch.setattr(
        Agent,
        "_parse_llm_response",
        lambda self, response: seen.setdefault("response", response) or {},
    )
    malformed = (
        '{"thought": found it, goal: do, tool: fetch_topic_config, '
        "tool_args: {slug: f1}}"
    )
    _bare_agent()._parse_llm_response(malformed)
    parsed = json.loads(seen["response"])  # must now be valid JSON
    assert parsed["tool"] == "fetch_topic_config"
    assert parsed["tool_args"] == {"slug": "f1"}


def test_parse_llm_response_leaves_null_tool_to_base(monkeypatch):
    """A repaired null-tool response is NOT substituted (avoids the loop)."""
    from gaia.agents.base.agent import Agent

    seen = {}
    monkeypatch.setattr(
        Agent,
        "_parse_llm_response",
        lambda self, response: seen.setdefault("response", response) or {},
    )
    malformed = '{"thought": I am done now, goal: x, tool: null, tool_args: {}}'
    _bare_agent()._parse_llm_response(malformed)
    assert seen["response"] == malformed  # passed through unchanged


def test_parse_llm_response_passes_valid_json_unchanged(monkeypatch):
    """Valid JSON takes the fast path untouched (no needless re-serialization)."""
    from gaia.agents.base.agent import Agent

    seen = {}
    monkeypatch.setattr(
        Agent,
        "_parse_llm_response",
        lambda self, response: seen.setdefault("response", response) or {},
    )
    valid = '{"thought": "t", "tool": "fetch_rss", "tool_args": {}}'
    _bare_agent()._parse_llm_response(valid)
    assert seen["response"] == valid


# ---------------------------------------------------------------------------
# Corrective compose pass — re-summarize gathered material when the agent loop
# fails to produce a usable digest. See agent._compose_and_publish.
# ---------------------------------------------------------------------------


class _FakeResp:
    def __init__(self, text):
        self.text = text


class _FakeChat:
    """Stub for agent.chat — records calls, returns a fixed response text."""

    def __init__(self, text, output_tokens=0):
        self._text = text
        self._output_tokens = output_tokens
        self.calls = []

    def send_messages(self, messages, system_prompt=None, **kwargs):
        self.calls.append((messages, system_prompt))
        return _FakeResp(self._text)

    def get_stats(self):
        return {"output_tokens": self._output_tokens}


def test_extract_gathered_materials_pulls_tool_results():
    from news_digest.agent import _extract_gathered_materials

    conv = [
        {"role": "user", "content": "q"},
        {"role": "tool", "name": "fetch_rss", "content": {"items": [1, 2]}},
        {"role": "assistant", "content": {"thought": "t"}},
        {"role": "tool", "name": "parse_article", "content": "body text here"},
    ]
    out = _extract_gathered_materials(conv)
    assert "fetch_rss" in out
    assert "parse_article" in out
    assert "body text here" in out


def test_extract_gathered_materials_empty_when_no_tools():
    from news_digest.agent import _extract_gathered_materials

    assert _extract_gathered_materials([{"role": "assistant", "content": {}}]) == ""
    assert _extract_gathered_materials(None) == ""


def test_parse_digest_text_variants():
    from news_digest.agent import _parse_digest_text

    clean = json.dumps({"summary": "s", "items": [1]})
    assert _parse_digest_text(clean)["summary"] == "s"
    assert _parse_digest_text(f"```json\n{clean}\n```")["items"] == [1]
    # malformed (unquoted value) is repaired
    assert (
        _parse_digest_text('{"summary": Hi there, "items": [1]}')["summary"]
        == "Hi there"
    )
    # nested under answer
    nested = json.dumps({"answer": {"summary": "s", "items": [1]}})
    assert _parse_digest_text(nested)["summary"] == "s"
    # unrecoverable / non-string
    assert _parse_digest_text("not json {{{") is None
    assert _parse_digest_text(123) is None


def test_compose_and_publish_recovers_from_gathered_materials(_capture_push):
    from news_digest.agent import NewsDigestAgent

    agent = NewsDigestAgent.__new__(NewsDigestAgent)
    agent.chat = _FakeChat(json.dumps(_answer_payload()))
    conversation = [
        {
            "role": "tool",
            "name": "fetch_topic_config",
            "tool_args": {"slug": "ai_models"},
        },
        {"role": "tool", "name": "fetch_rss", "content": {"items": [{"t": "x"}]}},
    ]
    result = {"conversation": conversation, "output_tokens": 9}

    out = agent._compose_and_publish("q", result, "ai_models")

    assert out["success"] is True
    assert _capture_push[0]["topic_slug"] == "ai_models"
    # The compose call was handed the gathered material and the compose prompt.
    sent_messages, system_prompt = agent.chat.calls[0]
    assert "fetch_rss" in sent_messages[0]["content"]
    assert "digest" in system_prompt.lower()


def test_compose_and_publish_token_count_sums_primary_and_compose(_capture_push):
    """token_count reflects the whole effort: primary run + compose call."""
    from news_digest.agent import NewsDigestAgent

    agent = NewsDigestAgent.__new__(NewsDigestAgent)
    agent.chat = _FakeChat(json.dumps(_answer_payload()), output_tokens=200)
    conversation = [{"role": "tool", "name": "fetch_rss", "content": {"x": 1}}]
    result = {"conversation": conversation, "output_tokens": 50}

    out = agent._compose_and_publish("q", result, "ai_models")

    assert out["success"] is True
    assert _capture_push[0]["token_count"] == 250  # 50 primary + 200 compose


def test_compose_and_publish_repairs_malformed_compose_output(_capture_push):
    from news_digest.agent import NewsDigestAgent

    agent = NewsDigestAgent.__new__(NewsDigestAgent)
    malformed = (
        '{topic_slug: ai_models, "summary": Big news today, "items": '
        + json.dumps(_ITEMS)
        + "}"
    )
    agent.chat = _FakeChat(malformed)
    conversation = [{"role": "tool", "name": "fetch_rss", "content": {"x": 1}}]

    out = agent._compose_and_publish("q", {"conversation": conversation}, "ai_models")

    assert out["success"] is True
    assert _capture_push[0]["summary"] == "Big news today"


def test_compose_and_publish_none_without_materials(_capture_push):
    from news_digest.agent import NewsDigestAgent

    agent = NewsDigestAgent.__new__(NewsDigestAgent)
    agent.chat = _FakeChat("{}")  # must never be called

    out = agent._compose_and_publish("q", {"conversation": []}, "ai_models")

    assert out is None
    assert agent.chat.calls == [], "model must not be called when nothing was gathered"
    assert _capture_push == []


def test_compose_and_publish_none_when_compose_has_no_digest(_capture_push):
    from news_digest.agent import NewsDigestAgent

    agent = NewsDigestAgent.__new__(NewsDigestAgent)
    agent.chat = _FakeChat('{"thought": "I am done", "tool": null}')
    conversation = [{"role": "tool", "name": "fetch_rss", "content": {"x": 1}}]

    out = agent._compose_and_publish("q", {"conversation": conversation}, "ai_models")

    assert out is None
    assert _capture_push == []


def test_generate_and_publish_falls_back_to_compose(monkeypatch, _capture_push):
    """Primary publish fails (no-digest answer) but compose recovers & publishes."""
    from news_digest.agent import NewsDigestAgent

    conversation = [
        {
            "role": "tool",
            "name": "fetch_topic_config",
            "tool_args": {"slug": "ai_models"},
        },
        {"role": "tool", "name": "fetch_rss", "content": {"items": [{"t": "x"}]}},
    ]
    # final answer parses but carries no digest -> missing_fields on primary path
    fake_result = {
        "status": "success",
        "result": json.dumps({"thought": "planning", "answer": "{}"}),
        "conversation": conversation,
        "output_tokens": 5,
    }
    agent = NewsDigestAgent.__new__(NewsDigestAgent)
    monkeypatch.setattr(NewsDigestAgent, "process_query", lambda self, q: fake_result)
    agent.chat = _FakeChat(json.dumps(_answer_payload()))

    out = agent.generate_and_publish("Generate the AI digest")

    assert out["success"] is True
    assert _capture_push[0]["topic_slug"] == "ai_models"
