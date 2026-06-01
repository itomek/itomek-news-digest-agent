"""Smoke tests for the wired NewsDigestAgent — issue #9.

Hermetic checks that the agent is assembled correctly (pipeline tools registered,
base classes, system prompt). The full end-to-end pipeline is validated on
the Strix Halo host against live Lemonade + Supabase, which is the real pass gate
(a committed pytest cannot reach those services under the hermetic conftest).
"""

from gaia.agents.base.agent import Agent
from gaia.database import DatabaseMixin

from news_digest.prompts import SYSTEM_PROMPT

PIPELINE_TOOLS = [
    "list_topics",
    "fetch_topic_config",
    "fetch_rss",
    "fetch_html",
    "parse_article",
    "push_to_supabase",
    "get_last_digest_date",
]


def test_agent_module_registers_pipeline_tools():
    """Importing the agent must make all pipeline tools available in GAIA's
    global tool registry (the agent advertises these to the model)."""
    from gaia.agents.base.tools import _TOOL_REGISTRY

    import news_digest.agent  # noqa: F401  (module import triggers @tool registration)

    for name in PIPELINE_TOOLS:
        assert name in _TOOL_REGISTRY, f"{name} not registered"


def test_agent_inherits_agent_and_databasemixin():
    from news_digest.agent import NewsDigestAgent

    assert issubclass(NewsDigestAgent, Agent)
    assert issubclass(NewsDigestAgent, DatabaseMixin)


def test_agent_uses_system_prompt():
    from news_digest.agent import NewsDigestAgent

    # _get_system_prompt ignores self; use an uninitialized instance so reading
    # the prompt does not require live Lemonade/Supabase settings.
    agent = NewsDigestAgent.__new__(NewsDigestAgent)
    assert agent._get_system_prompt() == SYSTEM_PROMPT
