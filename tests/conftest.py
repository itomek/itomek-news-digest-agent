"""Shared test fixtures for News Digest Agent tests."""

import pytest


@pytest.fixture(autouse=True)
def clear_settings_cache(monkeypatch):
    """Force get_settings() to re-read env on every test, and isolate tests
    from any real .env file on disk.

    Settings hard-codes env_file=".env"; on a host where that file exists (e.g.
    the Strix Halo box), pydantic-settings would load it and clobber the values
    these tests set via monkeypatch. Neutralizing env_file keeps tests hermetic.
    """
    from news_digest.config import Settings, get_settings

    monkeypatch.setitem(Settings.model_config, "env_file", None)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def valid_env(monkeypatch):
    """Minimal valid environment for Settings."""
    monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.co")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "anon-key")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "service-key")
