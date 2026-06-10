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
from news_digest.logging import log
from news_digest.prompts import SYSTEM_PROMPT

# Importing the tool modules registers their @tool functions into GAIA's global
# tool registry at import time; the agent then advertises them to the model.
from news_digest.tools import publishing, scraping  # noqa: F401
from news_digest.tools.publishing import push_to_supabase

# Lemonade serves models with a 4096-token context by default, which the agent's
# accumulated scraped conversation overflows after a few sources (the prompt then
# exceeds n_ctx and the completion is rejected). The digest models support up to
# 131072; 32768 leaves ample headroom for a multi-source run.
_HEAVY_CTX_SIZE = 32768


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

    # The model may nest the digest under "answer" or place it at the top level.
    answer = parsed.get("answer")
    digest = answer if isinstance(answer, dict) else parsed

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

        Args:
            query: The natural-language request, e.g.
                "Generate the AI model releases digest for today".

        Returns:
            The push_to_supabase result dict on success, or
            ``{"success": False, "error": <reason>}`` on any failure. Never raises.
        """
        result = self.process_query(query)
        return _publish_from_result(result)

    def _get_system_prompt(self) -> str:
        return SYSTEM_PROMPT

    def _register_tools(self) -> None:
        # Tools register at import time (module-level imports above), so the
        # global registry is already populated when the agent is constructed.
        return
