"""Shared test fixtures for News Digest Agent tests."""

import pytest

from news_digest import supabase_client
from news_digest.config import Settings, get_settings

# Belt: stop pydantic-settings from reading a real .env file directly.
Settings.model_config["env_file"] = None


@pytest.fixture(autouse=True)
def isolate_settings_env(monkeypatch):
    """Make every test hermetic with respect to the process environment.

    Importing gaia (transitively, via the tools) calls load_dotenv() at import
    time, which copies a developer's real .env into os.environ. pydantic-settings
    then reads those values regardless of env_file, clobbering what these tests
    set and breaking the defaults/required assertions in test_config.py — but
    only on a host that has a .env (so CI and clean dev machines pass while the
    Strix Halo box fails). Strip every Settings field's env var before each test
    so behaviour is identical everywhere; tests opt back in via monkeypatch.
    """
    for field in Settings.model_fields:
        monkeypatch.delenv(field.upper(), raising=False)
    get_settings.cache_clear()
    supabase_client.cache_clear()
    yield
    get_settings.cache_clear()
    supabase_client.cache_clear()


@pytest.fixture
def valid_env(isolate_settings_env, monkeypatch):
    """Minimal valid environment for Settings.

    Depends on isolate_settings_env so the ambient env is cleared *before* these
    values are set — otherwise the autouse delenv could wipe them.
    """
    monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.co")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "anon-key")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "service-key")
