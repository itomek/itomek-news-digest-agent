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
    """Keep the parser's error logging from touching Supabase/SQLite in tests."""
    monkeypatch.setattr(agent_module, "log", lambda *a, **k: None)


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
