from functools import lru_cache
from typing import Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Supabase
    supabase_url: str
    supabase_anon_key: str
    supabase_service_key: str

    # Lemonade Server
    lemonade_base_url: str = "http://localhost:8000/api/v1"
    lemonade_light_model: str = ""
    lemonade_heavy_model: str = ""

    # Local storage
    sqlite_path: str = "data/news_digest.db"
    fallback_log_path: str = "data/system_logs_fallback.sqlite"

    # Logging
    log_level: Literal["debug", "info", "warn", "error"] = "info"

    # Scheduler
    schedule_daily_hour: int = 5
    schedule_daily_minute: int = 0
    schedule_weekly_day: str = "sun"
    schedule_weekly_hour: int = 22
    schedule_weekly_minute: int = 0

    @field_validator("supabase_url", "supabase_anon_key", "supabase_service_key")
    @classmethod
    def must_be_non_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("must not be empty")
        return v

    @field_validator("supabase_url", "lemonade_base_url")
    @classmethod
    def must_look_like_url(cls, v: str) -> str:
        if v and not v.startswith(("http://", "https://")):
            raise ValueError("must start with http:// or https://")
        return v


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def __getattr__(name: str) -> object:
    if name == "settings":
        return get_settings()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
