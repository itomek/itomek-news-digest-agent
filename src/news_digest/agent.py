"""NewsDigestAgent — the GAIA agent that produces news digests.

The agent reads a topic's config from Supabase, scrapes the configured sources,
and summarizes with the local Lemonade LLM (its own reasoning IS the summarizer,
see CLAUDE.md). The model returns the finished digest as its final answer (a JSON
object); Python parses that answer and persists it deterministically via
push_to_supabase. Local models do not reliably emit a final publish tool call, so
the publish step is driven from Python rather than the LLM. DatabaseMixin adds
local SQLite state (run log / article cache); Supabase remains the primary store.
"""

import json
from typing import Any

import json_repair
from gaia.agents.base.agent import Agent
from gaia.database import DatabaseMixin
from gaia.llm.lemonade_client import LemonadeClient

from news_digest.config import get_settings
from news_digest.logging import drain_fallback, log
from news_digest.prompts import COMPOSE_SYSTEM_PROMPT, SYSTEM_PROMPT

# Importing the tool modules registers their @tool functions into GAIA's global
# tool registry at import time; the agent then advertises them to the model.
from news_digest.tools import publishing, scraping, social  # noqa: F401
from news_digest.tools.publishing import push_to_supabase

# Lemonade serves models with a 4096-token context by default, which the agent's
# accumulated scraped conversation overflows after a few sources (the prompt then
# exceeds n_ctx and the completion is rejected). The digest models support up to
# 131072; 32768 leaves ample headroom for a multi-source run.
_HEAVY_CTX_SIZE = 32768

# Substrings (lowercase) that mark an LLM-call failure as connection-level, i.e.
# Lemonade is unreachable rather than misbehaving mid-generation. Grounded in an
# empirical probe against a closed port (LEMONADE_BASE_URL=http://127.0.0.1:9),
# where GAIA recorded:
#   {'step': 1, 'error': "HTTPConnectionPool(host='127.0.0.1', port=9): Max
#    retries exceeded with url: /api/v1/chat/completions (Caused by
#    NewConnectionError(... Failed to establish a new connection: [Errno 61]
#    Connection refused))", 'type': 'llm_error'}
# "connection error" additionally covers openai.APIConnectionError, whose str()
# is "Connection error." on the openai-client path. Timeouts are deliberately
# excluded: a slow generation is not an outage.
_CONNECTION_FAILURE_MARKERS = (
    "connection refused",
    "connection error",
    "apiconnectionerror",
    "failed to establish a new connection",
    "cannot connect to host",
)


def _is_lemonade_down(error_history: list[Any] | None) -> bool:
    """Decide whether a process_query failure means Lemonade is unreachable.

    GAIA's ``error_history`` is a MIXED list: tool/parse errors are appended as
    plain strings, while failed LLM calls are dicts with a ``type`` tag (see
    gaia/agents/base/agent.py). Non-dict entries are skipped — they are never
    LLM connection failures.

    Dict tags: ``llm_connection_error`` fires only on builtin ConnectionError,
    which the requests/openai-based Lemonade stack never raises; a real outage
    lands in the generic handlers as ``llm_error`` (non-streaming, observed
    empirically) or ``llm_streaming_error`` (streaming). For those two tags the
    error message must additionally look connection-level — ordinary
    mid-generation LLM errors (bad JSON, empty response) must not be classified
    as an outage.

    Args:
        error_history: The ``error_history`` list from a process_query result.

    Returns:
        True when the history shows a connection-level LLM failure.
    """
    for entry in error_history or []:
        if not isinstance(entry, dict):
            continue
        etype = entry.get("type")
        if etype == "llm_connection_error":
            return True
        if etype in ("llm_error", "llm_streaming_error"):
            message = str(entry.get("error", "")).lower()
            if any(marker in message for marker in _CONNECTION_FAILURE_MARKERS):
                return True
    return False


def _is_llm_error_response(text: str) -> bool:
    """Return True when *text* is a GAIA error-fallback string, not a digest.

    GAIA wraps certain upstream LLM failures (e.g. HTTP 400 "2+ assistant
    messages") into a user-facing apology string rather than raising.  These
    strings must be classified as ``llm_error`` upstream failures, not as
    ``parse_error`` (which would imply the model produced garbled JSON).

    Conservative match (case-insensitive, on the stripped text):
    - Starts with ``"sorry, i ran into an unexpected problem"``
    - OR contains ``"error in chat completions"``

    Args:
        text: The stripped raw final-answer string from process_query.

    Returns:
        True when the text matches a known GAIA error-fallback pattern.
    """
    lowered = text.strip().lower()
    return lowered.startswith("sorry, i ran into an unexpected problem") or (
        "error in chat completions" in lowered
    )


def _repair_json_text(text: str) -> dict[str, Any] | None:
    """Best-effort recovery of a JSON object from malformed model output.

    The heavy local model (Qwen3.5-35B) intermittently emits JSON with unquoted
    keys and/or unquoted string values — e.g. ``{"thought": I gathered ...,
    goal: ..., tool: fetch_topic_config, tool_args: {slug: f1}}``. This is a
    non-deterministic sampling artifact (it varies run-to-run even at
    temperature 0, from llama-server batching numerics), so it cannot be steered
    away with the prompt alone. ``json.loads`` rejects it; ``json_repair`` quotes
    the dangling keys/values and parses it.

    Returns the repaired dict, or ``None`` when repair yields anything other than
    a JSON object (so callers can fall back to their existing handling).
    """
    try:
        obj = json_repair.loads(text)
    except Exception:  # noqa: BLE001 - repair must never raise into the caller
        return None
    return obj if isinstance(obj, dict) else None


def _is_actionable_response(parsed: dict[str, Any]) -> bool:
    """Whether a repaired response dict is worth substituting for the raw text.

    A repaired dict is only substituted back into GAIA's loop when it carries a
    real instruction: a (truthy) ``tool`` call, an ``answer``, a non-empty
    ``plan``, or a bare digest (``summary`` + ``items``). A repaired
    ``{"thought": ..., "tool": null}`` is deliberately NOT actionable — feeding
    a null tool back to GAIA makes it append consecutive assistant turns and
    loop until llama-server rejects the message list ("2+ assistant messages"),
    which is worse than letting GAIA's own fallback finalize the turn.
    """
    if parsed.get("tool"):
        return True
    if parsed.get("answer"):
        return True
    if isinstance(parsed.get("plan"), list) and parsed["plan"]:
        return True
    return bool(parsed.get("summary") and parsed.get("items"))


def _strip_code_fences(text: str) -> str:
    """Strip leading/trailing markdown code fences from a model answer.

    Handles ```json ... ``` and bare ``` ... ``` wrappers, with or without a
    trailing newline. Returns the inner text stripped of surrounding whitespace.
    """
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped
    # Drop the opening fence line (``` or ```json) and the trailing fence.
    lines = stripped.splitlines()
    if lines and lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].strip() == "```":
        lines = lines[:-1]
    return "\n".join(lines).strip()


def _topic_slug_from_conversation(conversation: list[dict] | None) -> str | None:
    """Recover the topic slug from the last fetch_topic_config tool call.

    The slug passed to fetch_topic_config is authoritative — it is the slug the
    model actually resolved against digest_topics. Used as a fallback when the
    final-answer JSON omits topic_slug.
    """
    if not conversation:
        return None
    for msg in reversed(conversation):
        if msg.get("name") == "fetch_topic_config":
            args = msg.get("tool_args") or {}
            slug = args.get("slug")
            if slug:
                return slug
    return None


# Caps for the corrective compose pass (_compose_and_publish). Sized for the
# 32K-token context: ~24K chars of gathered material plus the prompt still
# leaves ample room for the heavy model to emit a multi-item digest.
_COMPOSE_MAX_PER_TOOL = 6000
_COMPOSE_MAX_TOTAL = 24000


def _extract_gathered_materials(conversation: list[dict] | None) -> str:
    """Concatenate the tool results (scraped feeds/articles) from a run.

    The corrective compose pass re-summarizes from what the agent already
    fetched, so this pulls every ``role="tool"`` entry's content out of the
    process_query conversation, capped per-tool and overall to stay within the
    model's context window. Returns an empty string when nothing was gathered
    (e.g. the run failed before any source was fetched).
    """
    chunks: list[str] = []
    total = 0
    for msg in conversation or []:
        if msg.get("role") != "tool":
            continue
        text = json.dumps(msg.get("content"), default=str)[:_COMPOSE_MAX_PER_TOOL]
        piece = f"### {msg.get('name')}\n{text}"
        if total + len(piece) > _COMPOSE_MAX_TOTAL:
            break
        chunks.append(piece)
        total += len(piece)
    return "\n\n".join(chunks)


def _parse_digest_text(text: str) -> dict[str, Any] | None:
    """Parse a compose-pass response into a digest dict, repairing if needed.

    Strips any fences, tries strict JSON, then ``_repair_json_text``, and
    unwraps a nested ``answer`` object. Returns ``None`` when no JSON object can
    be recovered.
    """
    if not isinstance(text, str):
        return None
    stripped = _strip_code_fences(text)
    try:
        parsed = json.loads(stripped)
    except (ValueError, TypeError):
        parsed = _repair_json_text(stripped)
    if not isinstance(parsed, dict):
        return None
    answer = parsed.get("answer")
    return answer if isinstance(answer, dict) else parsed


def _publish_from_result(result: dict[str, Any]) -> dict[str, Any]:
    """Parse a process_query result and persist the structured digest.

    Extracts the model's final answer (``result['result']``), strips any markdown
    fences, JSON-decodes it, and unwraps a nested ``answer`` dict when present.
    Resolves topic_slug from the answer or, failing that, from the last
    fetch_topic_config call in the conversation. Persists via push_to_supabase.

    Never raises: on parse failure or missing required fields it logs an error and
    returns ``{"success": False, "error": <reason>}``.

    Args:
        result: The dict returned by ``NewsDigestAgent.process_query``.

    Returns:
        The push_to_supabase result dict, or an error dict.
    """
    raw = result.get("result")
    if not isinstance(raw, str) or not raw.strip():
        log(
            "error",
            "publish",
            "generate_and_publish: model returned no final answer string",
            metadata={"status": result.get("status")},
        )
        return {"success": False, "error": "no_answer"}

    stripped = _strip_code_fences(raw)
    if _is_llm_error_response(stripped):
        log(
            "error",
            "publish",
            "generate_and_publish: LLM returned an error response, not a digest"
            " (upstream LLM failure)",
            metadata={"raw": raw[:300]},
        )
        return {"success": False, "error": "llm_error"}

    try:
        parsed = json.loads(stripped)
    except (ValueError, TypeError) as exc:
        # The heavy model often emits unquoted keys/values; recover before
        # giving up (see _repair_json_text).
        parsed = _repair_json_text(stripped)
        if parsed is None:
            log(
                "error",
                "publish",
                f"generate_and_publish: could not parse final answer: "
                f"{exc.__class__.__name__}",
                metadata={"error": str(exc), "raw": raw[:500]},
            )
            return {"success": False, "error": "parse_error"}

    if not isinstance(parsed, dict):
        log(
            "error",
            "publish",
            "generate_and_publish: final answer was not a JSON object",
            metadata={"type": type(parsed).__name__},
        )
        return {"success": False, "error": "bad_answer_shape"}

    # The model may nest the digest under "answer" — as an object, or as a JSON
    # string / fenced code block (models that return the answer as text) — or it
    # may place the fields at the top level.
    answer = parsed.get("answer")
    if isinstance(answer, dict):
        digest = answer
    elif isinstance(answer, str):
        inner_text = _strip_code_fences(answer)
        try:
            inner = json.loads(inner_text)
        except (ValueError, TypeError):
            inner = _repair_json_text(inner_text)
        digest = inner if isinstance(inner, dict) else parsed
    else:
        digest = parsed

    summary = digest.get("summary")
    items = digest.get("items")
    sources_used = digest.get("sources_used", [])
    topic_slug = digest.get("topic_slug") or _topic_slug_from_conversation(
        result.get("conversation")
    )

    missing = [
        name
        for name, value in (
            ("topic_slug", topic_slug),
            ("summary", summary),
            ("items", items),
        )
        if value is None
    ]
    if missing:
        log(
            "error",
            "publish",
            f"generate_and_publish: missing required field(s): {', '.join(missing)}",
            topic_slug=topic_slug,
            metadata={"missing": missing},
        )
        return {"success": False, "error": "missing_fields"}

    return push_to_supabase(
        topic_slug,
        summary=summary,
        items=items,
        sources_used=sources_used,
        token_count=result.get("output_tokens", 0),
    )


class NewsDigestAgent(Agent, DatabaseMixin):
    """GAIA agent that orchestrates digest generation via local LLM tools."""

    def __init__(self, **kwargs: Any) -> None:
        settings = get_settings()
        # Digests use the heavy model; fall back to GAIA's default when unset.
        model_id = kwargs.pop("model_id", None) or settings.lemonade_heavy_model or None
        super().__init__(
            model_id=model_id,
            base_url=settings.lemonade_base_url,
            **kwargs,
        )
        # Deterministic output: temperature=0 reduces malformed-JSON rate on
        # local 35B models. Set via AgentConfig (gaia/chat/sdk.py:27) which is
        # read by send_messages / send_messages_stream before every completion.
        self.chat.config.temperature = 0.0
        # GAIA's AgentConfig defaults max_tokens to 512 (gaia/chat/sdk.py:26),
        # which truncates the final-answer JSON of multi-item digests (a 5-7
        # item world_news answer needs 1,500-2,500 tokens) and cascades into a
        # completion-loop deadlock and parse_error. 4096 gives ~2x headroom
        # over the largest topic's final answer.
        self.chat.config.max_tokens = 4096
        # GAIA drives tools via a JSON-in-content protocol. The loaded Lemonade
        # chat models otherwise emit "thinking" output with empty content, which
        # breaks tool parsing — force thinking off on every completion.
        self._force_no_thinking()
        # Serve the model with enough context for the accumulated scraped content;
        # Lemonade's 4096 default overflows partway through a multi-source run.
        self._ensure_context_window(model_id, settings.lemonade_base_url)
        # Local SQLite state (run log / article cache); Supabase stays primary.
        self.init_db(settings.sqlite_path)

    def _force_no_thinking(self) -> None:
        """Inject chat_template_kwargs={'enable_thinking': False} on every LLM
        call by wrapping the chat SDK send methods (process_query passes no extra
        kwargs, so this is the single safe seam)."""

        def _wrap(method):
            def _inner(messages, system_prompt=None, **kw):
                # Merge (not replace) so a caller-supplied chat_template_kwargs
                # can never silently drop enable_thinking.
                ctk = kw.setdefault("chat_template_kwargs", {})
                ctk.setdefault("enable_thinking", False)
                return method(messages, system_prompt=system_prompt, **kw)

            return _inner

        self.chat.send_messages = _wrap(self.chat.send_messages)
        if hasattr(self.chat, "send_messages_stream"):
            self.chat.send_messages_stream = _wrap(self.chat.send_messages_stream)

    def _ensure_context_window(self, model_id: str | None, base_url: str) -> None:
        """Load the model with a context window large enough for the run.

        Lemonade serves models with a 4096-token context by default. The agent
        accumulates the system prompt plus every scraped feed and article body in
        the conversation, so after a few sources the prompt exceeds 4096 and the
        completion request is rejected (n_ctx exceeded). Request _HEAVY_CTX_SIZE
        tokens and persist it so scheduled runs inherit it. Best-effort: a failure
        here must never block agent startup.
        """
        if not model_id:
            return
        try:
            LemonadeClient(base_url=base_url).load_model(
                model_id,
                ctx_size=_HEAVY_CTX_SIZE,
                save_options=True,
                prompt=False,
            )
        except Exception as exc:  # noqa: BLE001 - startup must survive this
            log("warn", "system", f"could not set context window: {exc!r}")

    def generate_and_publish(self, query: str) -> dict[str, Any]:
        """Run a digest query and persist the structured result.

        Drives the full topic run: the model reads/scrapes via tools and returns
        the finished digest as its final answer (a JSON object). This method then
        parses that answer and writes it to Supabase via push_to_supabase — the
        "assemble structured digest" step, kept in Python because local models do
        not reliably emit a final publish tool call.

        Starts by draining any log rows stranded in the SQLite fallback from
        earlier Supabase outages (best-effort — a drain failure never blocks the
        run). Logs a ``summarize`` entry after process_query returns, covering:
        model, token counts (from GAIA's aggregated stats), duration, and
        status. When Lemonade is unreachable (connection-level LLM failure in
        error_history, see ``_is_lemonade_down``) the topic is logged and
        skipped without crashing the process.

        Token counts come from GAIA's per-step conversation stats aggregation.
        Zero means the streaming backend did not report them for this run.

        Args:
            query: The natural-language request, e.g.
                "Generate the AI model releases digest for today".

        Returns:
            The push_to_supabase result dict on success, or
            ``{"success": False, "error": <reason>}`` on any failure. Never raises.
        """
        # Ship logs accumulated in the SQLite fallback while Supabase was down.
        # Best-effort: drain_fallback() itself swallows Supabase errors, but the
        # fallback DB open can still fail (disk) — never let that break a run.
        try:
            drained = drain_fallback()
            if drained:
                log(
                    "info",
                    "system",
                    f"drained {drained} fallback log row(s) to Supabase",
                    metadata={"rows_drained": drained},
                )
        except Exception:  # noqa: BLE001 - recovery must never block the run
            pass

        result = self.process_query(query)

        # Resolve the topic slug from the conversation (the slug the model
        # actually passed to fetch_topic_config). May be None on early failures;
        # those rows then carry topic_slug=NULL, as before. Attributing the slug
        # lets the token-usage / run-duration views group by topic (#20).
        topic_slug = _topic_slug_from_conversation(result.get("conversation"))

        # Detect Lemonade-down and skip the topic so the scheduler can continue.
        if _is_lemonade_down(result.get("error_history")):
            log(
                "error",
                "summarize",
                "generate_and_publish: Lemonade Server unreachable — topic skipped",
                topic_slug=topic_slug,
                metadata={
                    "query": query,
                    "status": result.get("status"),
                    "steps_taken": result.get("steps_taken"),
                    "error_history": result.get("error_history"),
                },
            )
            return {"success": False, "error": "lemonade_down"}

        # Log summarize trace. Token counts are aggregated by GAIA from per-step
        # conversation stats; zero means the streaming backend did not report them.
        log(
            "info",
            "summarize",
            "generate_and_publish: LLM run complete",
            topic_slug=topic_slug,
            metadata={
                "model_id": getattr(self, "model_id", None),
                "status": result.get("status"),
                "input_tokens": result.get("input_tokens", 0),
                "output_tokens": result.get("output_tokens", 0),
                "total_tokens": result.get("total_tokens", 0),
                "duration_s": round(result.get("duration", 0.0), 2),
                "steps_taken": result.get("steps_taken"),
                "error_count": result.get("error_count", 0),
            },
        )

        publish_result = _publish_from_result(result)
        if publish_result.get("success"):
            return publish_result

        # The agent loop ended without a usable digest — the heavy model emitted
        # a planning thought or a degenerate/empty answer instead of composing
        # (a non-deterministic failure, see _repair_json_text). Try one
        # corrective compose pass from the material already gathered before
        # giving up; on success it lands the row, otherwise the original failure
        # stands.
        fallback = self._compose_and_publish(query, result, topic_slug)
        return fallback if fallback is not None else publish_result

    def _compose_and_publish(
        self, query: str, result: dict[str, Any], topic_slug: str | None
    ) -> dict[str, Any] | None:
        """Re-summarize the gathered material with one tightly scoped call.

        The agent loop occasionally fails to compose a digest even though every
        source was fetched successfully. Rather than lose the run, this re-asks
        the model for just the digest — no tools, no agent protocol — over the
        material it already gathered, which it produces far more reliably (see
        COMPOSE_SYSTEM_PROMPT). Returns the push_to_supabase result on success,
        or ``None`` when no digest could be recovered (caller then keeps the
        original failure). Never raises.

        Args:
            query: The original natural-language request.
            result: The process_query result (its conversation holds the
                gathered tool outputs).
            topic_slug: The slug resolved from the run, if any.

        Returns:
            The push_to_supabase result dict, or ``None``.
        """
        conversation = result.get("conversation")
        slug = topic_slug or _topic_slug_from_conversation(conversation)
        materials = _extract_gathered_materials(conversation)
        if not slug or not materials:
            return None

        user_message = (
            f"Topic slug: {slug}\nOriginal request: {query}\n\n"
            f"Gathered material:\n{materials}\n\n"
            "Now output ONLY the digest JSON object described in the system "
            "prompt."
        )
        try:
            response = self.chat.send_messages(
                [{"role": "user", "content": user_message}],
                system_prompt=COMPOSE_SYSTEM_PROMPT,
            )
        except Exception as exc:  # noqa: BLE001 - fallback must never raise
            log(
                "error",
                "publish",
                f"corrective compose call failed: {exc!r}",
                topic_slug=slug,
            )
            return None

        digest = _parse_digest_text(getattr(response, "text", response))
        summary = digest.get("summary") if isinstance(digest, dict) else None
        items = digest.get("items") if isinstance(digest, dict) else None
        if not (summary and items):
            log(
                "error",
                "publish",
                "corrective compose pass produced no usable digest",
                topic_slug=slug,
            )
            return None

        log(
            "info",
            "publish",
            "recovered digest via corrective compose pass",
            topic_slug=slug,
        )
        # token_count should reflect the whole topic effort: the primary run's
        # output tokens plus this compose call's (get_stats reports the last
        # call). Best-effort — a stats hiccup must not block the publish.
        compose_tokens = 0
        try:
            compose_tokens = int(
                (self.chat.get_stats() or {}).get("output_tokens", 0) or 0
            )
        except Exception:  # noqa: BLE001 - stats are advisory, never fatal
            compose_tokens = 0
        return push_to_supabase(
            slug,
            summary=summary,
            items=items,
            sources_used=(digest.get("sources_used") or []),
            token_count=result.get("output_tokens", 0) + compose_tokens,
        )

    def _parse_llm_response(self, response: str) -> dict[str, Any]:
        """Repair malformed JSON before GAIA's parser sees it.

        GAIA drives tools and final answers through a JSON-in-content protocol.
        The heavy local model intermittently emits JSON with unquoted keys or
        unquoted string values (a non-deterministic sampling artifact — see
        _repair_json_text); GAIA's own repair only handles trailing commas and
        control characters, so such a turn is misread as a plain-text answer and
        the run dies as a parse_error. Here we detect a malformed JSON object,
        repair it, and — only when the repair is actionable (a real tool call,
        answer, plan, or digest) — hand the cleaned JSON to the base parser. A
        repaired null-tool response is left to GAIA's own fallback to avoid the
        assistant-message loop (see _is_actionable_response).
        """
        stripped = (response or "").strip()
        if stripped.startswith("{"):
            try:
                json.loads(stripped)
            except (ValueError, TypeError):
                repaired = _repair_json_text(stripped)
                if repaired is not None and _is_actionable_response(repaired):
                    response = json.dumps(repaired)
        return super()._parse_llm_response(response)

    def _get_system_prompt(self) -> str:
        return SYSTEM_PROMPT

    def _register_tools(self) -> None:
        # Tools register at import time (module-level imports above), so the
        # global registry is already populated when the agent is constructed.
        return
