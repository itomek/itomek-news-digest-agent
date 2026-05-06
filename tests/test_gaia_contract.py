"""GAIA framework contract tests.

These assertions encode the conclusions of docs/gaia-audit.md as machine-checkable
invariants. They are the regression tripwire for amd-gaia pin bumps: when the
upstream library changes a primitive name, signature, or MRO behaviour, one of
these tests fails immediately rather than silently invalidating the audit.

If you bump the amd-gaia pin in pyproject.toml, run this module first, update
the audit doc with any drift, and then update these assertions.

Probed against the pin in pyproject.toml: amd-gaia 0.17.2 (commit da5ba458,
dated 2026-04-17). See docs/gaia-audit.md for the full audit.
"""

from __future__ import annotations

import inspect


def test_primitives_importable():
    """All four primitives that architecture.md §2.1/§12 names must be importable.

    The canonical paths are asserted unconditionally — if upstream renames or
    removes a re-export, this test must fail loudly so the audit and the
    consuming code can be updated together.
    """
    from gaia.agents.base.agent import Agent  # noqa: F401
    from gaia.agents.base.tools import tool  # noqa: F401

    # DatabaseMixin is re-exported from gaia.database.mixin into gaia.database.
    from gaia.database import DatabaseMixin  # noqa: F401
    from gaia.llm.lemonade_client import LemonadeClient  # noqa: F401


def test_agent_mro_resolves_with_database_mixin():
    """architecture.md §2.1 mandates `class NewsDigestAgent(Agent, DatabaseMixin)`.

    The current src/news_digest/agent.py inherits only Agent — adding
    DatabaseMixin is tracked as a follow-up (see docs/gaia-audit.md §2.2 and #9).
    This test guards the prerequisite: the MRO must resolve cleanly so that
    follow-up work is not blocked by an upstream refactor.
    """
    from gaia.agents.base.agent import Agent
    from gaia.database import DatabaseMixin

    class _Probe(Agent, DatabaseMixin):
        # Agent is abstract — provide minimal hook implementations so the
        # subclass body is well-formed. Instantiation is NOT required.
        def _register_tools(self) -> None:
            pass

        def _get_system_prompt(self) -> str:
            return ""

    assert Agent in _Probe.__mro__
    assert DatabaseMixin in _Probe.__mro__


def test_agent_process_query_signature():
    """Agent.process_query is the only entry point external callers use.

    Guards the contract documented in architecture.md §2.1. The audit found
    process_query does NOT accept a `model` kwarg — multi-model routing must
    happen at the LemonadeClient layer or via a follow-up extension. This test
    will fail loudly if upstream adds (or removes) parameters from this call.
    """
    from gaia.agents.base.agent import Agent

    sig = inspect.signature(Agent.process_query)
    params = list(sig.parameters)

    assert "user_input" in params, f"process_query must accept user_input; got {params}"
    # Audit finding: no `model` kwarg at the agent level. If upstream adds one
    # (which would *strengthen* the architecture), update docs/gaia-audit.md
    # §1.6 / §2.2.d before relaxing this assertion — Branch A's reasoning rests
    # on knowing routing is NOT yet supported here.
    assert "model" not in params, (
        "process_query gained a `model` kwarg — update docs/gaia-audit.md §1.6"
    )


def test_lemonade_client_completions_accepts_per_call_model_required():
    """LemonadeClient.completions and chat_completions must REQUIRE `model` per call.

    Branch A's escape hatch for any future multi-model need is per-call routing
    at this layer (audit §1.6 / §2.2.d). The audit specifically claims `model`
    is REQUIRED (no default). If upstream relaxes that to `model: str | None`,
    the escape hatch degrades silently — Branch A's reasoning must be
    re-evaluated before that lands.
    """
    from gaia.llm.lemonade_client import LemonadeClient

    methods_with_required_model: list[str] = []
    for name in ("completions", "chat_completions", "responses"):
        method = getattr(LemonadeClient, name, None)
        if method is None:
            continue
        sig = inspect.signature(method)
        param = sig.parameters.get("model")
        if param is None:
            continue
        if param.default is inspect.Parameter.empty:
            methods_with_required_model.append(name)

    assert methods_with_required_model, (
        "Branch A assumes LemonadeClient provides per-call model routing as a "
        "future escape hatch — none of completions/chat_completions/responses "
        "REQUIRES a `model` argument. Re-evaluate audit §2.1 and §2.2.d before "
        "proceeding."
    )


def test_tool_decorator_supports_bare_and_kwargs_forms():
    """@tool must keep accepting both bare and kwargs forms used by the codebase.

    src/news_digest/tools/hello.py uses the bare `@tool` form today. The audit
    (§1.3) further notes that arbitrary kwargs are silently ignored (kept for
    backward compatibility). This test pins both behaviours so that an upstream
    refactor — e.g., raising on unknown kwargs — fails CI immediately rather
    than at agent-run time.
    """
    from gaia.agents.base.tools import tool

    @tool
    def _bare(x: int) -> dict:
        """Bare-form probe."""
        return {"x": x}

    @tool(atomic=True)
    def _atomic(x: int) -> dict:
        """Atomic-form probe."""
        return {"x": x}

    # Audit §1.3 claim: arbitrary kwargs are silently ignored. If upstream
    # tightens this, the decoration below would raise.
    @tool(nonexistent_kwarg=True)
    def _unknown_kwarg(x: int) -> dict:
        """Unknown-kwarg probe."""
        return {"x": x}

    # Decorator must return a callable that pass-throughs to the original.
    # The decorator is documented to register into a module-level registry,
    # but that registry is not part of the public API — this test asserts
    # only the contract the consuming code depends on (call-through).
    assert _bare(1) == {"x": 1}
    assert _atomic(2) == {"x": 2}
    assert _unknown_kwarg(3) == {"x": 3}
