"""Hello-world tool — proves the GAIA + Lemonade + Supabase round-trip.

Used only by the Epic 1 exit-gate scenario (issue #4). Delete or move under
a tests-only path once Epic 2 ships real tools.
"""

from gaia.agents.base.tools import tool

from news_digest.logging import log


@tool
def say_hello() -> dict:
    """Return a greeting and write a hello_world log row to Supabase.

    Returns:
        Dict with 'message' (the greeting) and 'logged' (always True).
    """
    message = "hello from news-digest-agent"
    log(
        "info",
        "hello_world",
        message,
        metadata={"source": "say_hello tool"},
    )
    return {"message": message, "logged": True}
