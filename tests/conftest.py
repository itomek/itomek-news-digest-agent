"""Shared test fixtures for News Digest Agent tests."""

import pytest


@pytest.fixture(autouse=True)
def clear_settings_cache():
    """Force get_settings() to re-read env on every test."""
    from news_digest.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def valid_env(monkeypatch):
    """Minimal valid environment for Settings."""
    monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.co")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "anon-key")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "service-key")
