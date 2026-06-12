"""Process-wide cached Supabase client.

Every Supabase touchpoint (``news_digest.logging``, the publishing tools, and
the scheduler) goes through :func:`get_client` so the process holds a single
httpx connection pool. Building a fresh client per call leaks idle sockets:
the scheduler daemon runs 24/7 with multiple ``log()`` calls per tick, and
each ``create_client()`` allocates a pool that is never closed.

The cache is keyed on the active settings values, so a settings change (tests
swapping env vars) transparently yields a new client. ``cache_clear()`` is the
explicit reset hook, mirroring ``config.get_settings.cache_clear``.
"""

from functools import lru_cache

from news_digest.config import get_settings
from supabase import Client, create_client


@lru_cache(maxsize=1)
def _cached_client(url: str, key: str) -> Client:
    return create_client(url, key)


def get_client() -> Client:
    """Return the shared Supabase client authenticated as service_role.

    The agent is a trusted backend process; it uses the service-role key for
    all Supabase access. Reads previously used the anon key, but anon reads
    return zero rows since read policies moved to the ``authenticated`` role
    (migration 0006 / #57); service_role bypasses RLS. The service key never
    leaves the host.
    """
    settings = get_settings()
    return _cached_client(settings.supabase_url, settings.supabase_service_key)


def cache_clear() -> None:
    """Drop the cached client so the next get_client() builds a fresh one."""
    _cached_client.cache_clear()
