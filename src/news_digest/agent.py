"""NewsDigestAgent — the GAIA agent that produces news digests.

Currently scoped to the Epic 1 hello-world milestone (issue #4): the agent
instantiates GAIA + Lemonade, dispatches a single tool call, and writes a
log row to Supabase to prove the full round-trip works.

Real scraping, summarization, and publishing land in Epic 2 (issues #5-#9).
"""

from typing import Any

from gaia.agents.base.agent import Agent

from news_digest.config import get_settings


class NewsDigestAgent(Agent):
    """GAIA agent that orchestrates digest generation via local LLM tools."""

    def __init__(self, **kwargs: Any) -> None:
        settings = get_settings()
        model_id = kwargs.pop("model_id", None) or settings.lemonade_light_model or None
        super().__init__(
            model_id=model_id,
            base_url=settings.lemonade_base_url,
            **kwargs,
        )

    def _get_system_prompt(self) -> str:
        return (
            "You are a hello-world agent. When the user asks you to say hello, "
            "call the say_hello tool exactly once and return a short confirmation "
            "to the user that includes the tool's response."
        )

    def _register_tools(self) -> None:
        # Importing the module is sufficient — the @tool decorator registers
        # each function in the GAIA tool registry at import time.
        from news_digest.tools import hello  # noqa: F401
