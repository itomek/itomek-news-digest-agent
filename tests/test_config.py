import pytest
from pydantic import ValidationError

from news_digest.config import Settings


def test_loads_from_env(valid_env):
    s = Settings()
    assert s.supabase_url == "https://test.supabase.co"
    assert s.supabase_anon_key == "anon-key"
    assert s.supabase_service_key == "service-key"
    assert s.lemonade_base_url == "http://localhost:8000/api/v1"
    assert s.log_level == "info"


def test_missing_required_field(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.co")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "anon-key")
    # SUPABASE_SERVICE_KEY deliberately not set
    monkeypatch.delenv("SUPABASE_SERVICE_KEY", raising=False)
    with pytest.raises(ValidationError):
        Settings()


def test_empty_string_rejected(valid_env, monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "")
    with pytest.raises(ValidationError):
        Settings()


def test_invalid_url_rejected(valid_env, monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "not-a-url")
    with pytest.raises(ValidationError):
        Settings()


def test_invalid_log_level_rejected(valid_env, monkeypatch):
    monkeypatch.setenv("LOG_LEVEL", "verbose")
    with pytest.raises(ValidationError):
        Settings()


def test_defaults(valid_env):
    s = Settings()
    assert s.schedule_daily_hour == 5
    assert s.sqlite_path == "data/news_digest.db"


def test_env_override(valid_env, monkeypatch):
    monkeypatch.setenv("LOG_LEVEL", "debug")
    monkeypatch.setenv("SCHEDULE_DAILY_HOUR", "7")
    s = Settings()
    assert s.log_level == "debug"
    assert s.schedule_daily_hour == 7


def test_perplexity_defaults(valid_env):
    s = Settings()
    assert s.perplexity_api_key == ""
    assert s.perplexity_model == "sonar"


def test_curator_schedule_defaults(valid_env):
    s = Settings()
    assert s.schedule_curator_hour == 4
    assert s.schedule_curator_minute == 0


def test_perplexity_key_env_override(valid_env, monkeypatch):
    monkeypatch.setenv("PERPLEXITY_API_KEY", "pplx-test-key")
    monkeypatch.setenv("PERPLEXITY_MODEL", "sonar-pro")
    s = Settings()
    assert s.perplexity_api_key == "pplx-test-key"
    assert s.perplexity_model == "sonar-pro"


def test_curator_schedule_env_override(valid_env, monkeypatch):
    monkeypatch.setenv("SCHEDULE_CURATOR_HOUR", "6")
    monkeypatch.setenv("SCHEDULE_CURATOR_MINUTE", "30")
    s = Settings()
    assert s.schedule_curator_hour == 6
    assert s.schedule_curator_minute == 30
