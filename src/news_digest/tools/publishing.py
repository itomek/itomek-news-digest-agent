"""Publishing tools for the News Digest Agent.

Handles reading topic config from Supabase and writing digests back.

Tools:
    fetch_topic_config: Get topic settings (sources, prompt_hint, cadence) from Supabase.
    get_last_digest_date: Check when the last digest was published for a topic.
    push_to_supabase: Insert a completed digest into the digests table.
"""

# TODO: Phase 1 implementation
#
# import httpx
# from gaia.agents.base.tools import tool
#
#
# @tool
# def fetch_topic_config(slug: str) -> dict:
#     """Fetch topic configuration from Supabase digest_topics table.
#
#     Args:
#         slug: The topic slug (e.g., 'ai_models').
#
#     Returns:
#         Dict with topic config: name, sources, prompt_hint, cadence, enabled.
#     """
#     ...
#
#
# @tool
# def get_last_digest_date(topic_slug: str) -> dict:
#     """Get the date of the most recent digest for a topic.
#
#     Args:
#         topic_slug: The topic slug.
#
#     Returns:
#         Dict with 'last_date' (ISO date string or null if no digests exist).
#     """
#     ...
#
#
# @tool
# def push_to_supabase(
#     topic_slug: str,
#     content: str,
#     sources_used: list[str],
#     token_count: int,
# ) -> dict:
#     """Publish a completed digest to Supabase.
#
#     Args:
#         topic_slug: The topic slug.
#         content: The digest content (Markdown).
#         sources_used: List of URLs that were scraped.
#         token_count: Approximate token count of the LLM output.
#
#     Returns:
#         Dict with 'success' bool and 'id' of the inserted row.
#     """
#     ...
