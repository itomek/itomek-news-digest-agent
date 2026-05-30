"""NewsDigestAgent — the GAIA agent that produces news digests.

The agent reads a topic's config from Supabase, scrapes the configured sources,
summarizes with the local Lemonade LLM (its own reasoning IS the summarizer, see
CLAUDE.md), publishes the digest back to Supabase, and logs the run to
system_logs. DatabaseMixin adds local SQLite state (run log / article cache);
Supabase remains the primary store.
"""

from typing import Any

from gaia.agents.base.agent import Agent
from gaia.database import DatabaseMixin

from news_digest.config import get_settings
from news_digest.prompts import SYSTEM_PROMPT

# Importing the tool modules registers their @tool functions into GAIA's global
# tool registry at import time; the agent then advertises them to the model.
from news_digest.tools import publishing, scraping  # noqa: F401


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

    def _get_system_prompt(self) -> str:
        return SYSTEM_PROMPT

    def _register_tools(self) -> None:
        # Tools register at import time (module-level imports above), so the
        # global registry is already populated when the agent is constructed.
        return
