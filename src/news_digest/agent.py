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

from gaia.agents.base.agent import Agent
from gaia.database import DatabaseMixin
from gaia.llm.lemonade_client import LemonadeClient

from news_digest.config import get_settings
from news_digest.logging import drain_fallback, log
from news_digest.prompts import SYSTEM_PROMPT

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

    try:
        parsed = json.loads(_strip_code_fences(raw))
    except (ValueError, TypeError) as exc:
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
        try:
            inner = json.loads(_strip_code_fences(answer))
        except (ValueError, TypeError):
            inner = None
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

        return _publish_from_result(result)

    def _get_system_prompt(self) -> str:
        return SYSTEM_PROMPT

    def _register_tools(self) -> None:
        # Tools register at import time (module-level imports above), so the
        # global registry is already populated when the agent is constructed.
        return
