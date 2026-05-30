"""Shared test fixtures for News Digest Agent tests."""

import pytest

from news_digest.config import Settings, get_settings

# Tests must never read a developer's real .env file. On a host where one exists
# (e.g. the Strix Halo box), pydantic-settings would load it and clobber the
# values tests set via monkeypatch — silently breaking the defaults/required
# assertions in test_config.py. Neutralize env_file once, process-wide, so the
# suite is hermetic regardless of working directory. Doing this per-test via
# monkeypatch is unreliable: it races with other fixtures' monkeypatch usage.
Settings.model_config["env_file"] = None


@pytest.fixture(autouse=True)
def clear_settings_cache():
    """Force get_settings() to re-read env on every test."""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def valid_env(monkeypatch):
    """Minimal valid environment for Settings."""
    monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.co")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "anon-key")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "service-key")
