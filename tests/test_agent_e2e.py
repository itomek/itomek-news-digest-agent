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


# ---------------------------------------------------------------------------
# _ensure_context_window — agent requests a large context window on startup
# (Lemonade's 4096 default overflows a multi-source run)
# ---------------------------------------------------------------------------


def test_ensure_context_window_loads_model_with_large_ctx(monkeypatch):
    from news_digest import agent as agent_mod
    from news_digest.agent import NewsDigestAgent

    captured = {}

    class FakeClient:
        def __init__(self, base_url=None, **kw):
            captured["base_url"] = base_url

        def load_model(
            self, model_name, ctx_size=None, save_options=False, prompt=True
        ):
            captured.update(
                model_name=model_name,
                ctx_size=ctx_size,
                save_options=save_options,
                prompt=prompt,
            )
            return {}

    monkeypatch.setattr(agent_mod, "LemonadeClient", FakeClient)
    agent = NewsDigestAgent.__new__(NewsDigestAgent)
    agent._ensure_context_window("Qwen3.5-35B-A3B-GGUF", "http://host:13305/api/v1")

    assert captured["base_url"] == "http://host:13305/api/v1"
    assert captured["model_name"] == "Qwen3.5-35B-A3B-GGUF"
    assert captured["ctx_size"] == agent_mod._HEAVY_CTX_SIZE == 32768
    assert captured["save_options"] is True
    assert captured["prompt"] is False  # headless: never prompt for input


def test_ensure_context_window_noops_without_model(monkeypatch):
    from news_digest import agent as agent_mod
    from news_digest.agent import NewsDigestAgent

    calls = {"n": 0}

    class FakeClient:
        def __init__(self, **kw):
            calls["n"] += 1

    monkeypatch.setattr(agent_mod, "LemonadeClient", FakeClient)
    agent = NewsDigestAgent.__new__(NewsDigestAgent)
    agent._ensure_context_window(None, "http://host/api/v1")
    assert calls["n"] == 0  # no model -> no client built


def test_ensure_context_window_never_raises(monkeypatch):
    from news_digest import agent as agent_mod
    from news_digest.agent import NewsDigestAgent

    class BoomClient:
        def __init__(self, **kw):
            pass

        def load_model(self, *a, **k):
            raise RuntimeError("lemonade unreachable")

    monkeypatch.setattr(agent_mod, "LemonadeClient", BoomClient)
    monkeypatch.setattr(agent_mod, "log", lambda *a, **k: None)
    agent = NewsDigestAgent.__new__(NewsDigestAgent)
    # Best-effort: a load failure must not propagate out of startup.
    agent._ensure_context_window("some-model", "http://host/api/v1")
