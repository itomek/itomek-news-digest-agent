"""NewsDigestAgent — main agent class.

Inherits from GAIA's Agent base class and DatabaseMixin.
Orchestrates scraping, summarization (via native LLM reasoning), and publishing.
"""

# TODO: Phase 1 implementation
#
# from gaia.agents.base.agent import Agent
# from gaia.database import DatabaseMixin
#
# from news_digest.prompts import SYSTEM_PROMPT
# from news_digest.tools import scraping, publishing, analysis
#
#
# class NewsDigestAgent(Agent, DatabaseMixin):
#     """GAIA agent that scrapes news sources, summarizes via local LLM,
#     and publishes digests to Supabase."""
#
#     def __init__(self, supabase_url: str, supabase_key: str, **kwargs):
#         super().__init__(
#             model_id=kwargs.pop("model_id", "Qwen3.5-35B-A3B-GGUF"),
#             **kwargs,
#         )
#         self.supabase_url = supabase_url
#         self.supabase_key = supabase_key
#         self.init_db("data/news_digest.db")
#         self._setup_tables()
#
#     def _get_system_prompt(self) -> str:
#         return SYSTEM_PROMPT
#
#     def _register_tools(self):
#         # Register scraping tools
#         scraping.register(self)
#         # Register publishing tools
#         publishing.register(self)
#         # Register analysis tools
#         analysis.register(self)
#
#     def _setup_tables(self):
#         """Create local SQLite tables for run logging and article caching."""
#         if not self.table_exists("run_log"):
#             self.execute('''
#                 CREATE TABLE run_log (
#                     id INTEGER PRIMARY KEY,
#                     topic_slug TEXT NOT NULL,
#                     status TEXT NOT NULL,
#                     token_count INTEGER,
#                     duration_seconds REAL,
#                     error_message TEXT,
#                     created_at TEXT DEFAULT CURRENT_TIMESTAMP
#                 )
#             ''')
#         if not self.table_exists("article_cache"):
#             self.execute('''
#                 CREATE TABLE article_cache (
#                     id INTEGER PRIMARY KEY,
#                     url TEXT NOT NULL UNIQUE,
#                     title TEXT,
#                     content_hash TEXT,
#                     fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
#                 )
#             ''')
