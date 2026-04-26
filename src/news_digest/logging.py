import sqlite3
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from supabase import create_client

Level = Literal["info", "warn", "error"]
Category = Literal[
    "schedule",
    "scrape",
    "summarize",
    "publish",
    "feedback",
    "hello_world",
    "system",
]

_fallback_db: sqlite3.Connection | None = None


def _get_fallback_db() -> sqlite3.Connection:
    global _fallback_db
    if _fallback_db is None:
        from news_digest.config import get_settings

        path = Path(get_settings().fallback_log_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        _fallback_db = sqlite3.connect(str(path), check_same_thread=False)
        _fallback_db.execute(
            """CREATE TABLE IF NOT EXISTS system_logs (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                level TEXT NOT NULL,
                category TEXT NOT NULL,
                topic_slug TEXT,
                message TEXT NOT NULL,
                metadata TEXT,
                synced_at TEXT
            )"""
        )
        _fallback_db.commit()
    return _fallback_db


def _write_fallback(row: dict[str, Any]) -> None:
    import json

    db = _get_fallback_db()
    db.execute(
        "INSERT OR IGNORE INTO system_logs "
        "(id, timestamp, level, category, topic_slug, message, metadata) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            row["id"],
            row["timestamp"],
            row["level"],
            row["category"],
            row.get("topic_slug"),
            row["message"],
            json.dumps(row.get("metadata")) if row.get("metadata") else None,
        ),
    )
    db.commit()


def log(
    level: Level,
    category: Category,
    message: str,
    topic_slug: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    row = {
        "id": str(uuid.uuid4()),
        "timestamp": datetime.now(UTC).isoformat(),
        "level": level,
        "category": category,
        "topic_slug": topic_slug,
        "message": message,
        "metadata": metadata,
    }
    try:
        from news_digest.config import get_settings

        settings = get_settings()
        client = create_client(settings.supabase_url, settings.supabase_service_key)
        client.table("system_logs").insert(row).execute()
    except Exception:
        try:
            _write_fallback(row)
        except Exception:
            pass


def drain_fallback() -> int:
    """Push any unsynchronised fallback rows to Supabase. Returns rows drained."""
    import json

    db = _get_fallback_db()
    rows = db.execute(
        "SELECT id, timestamp, level, category, topic_slug, message, metadata "
        "FROM system_logs WHERE synced_at IS NULL"
    ).fetchall()

    if not rows:
        return 0

    try:
        from news_digest.config import get_settings

        settings = get_settings()
        client = create_client(settings.supabase_url, settings.supabase_service_key)

        for r in rows:
            row_id, ts, level, category, topic_slug, message, metadata_json = r
            payload = {
                "id": row_id,
                "timestamp": ts,
                "level": level,
                "category": category,
                "topic_slug": topic_slug,
                "message": message,
                "metadata": json.loads(metadata_json) if metadata_json else None,
            }
            client.table("system_logs").upsert(payload).execute()
            db.execute(
                "UPDATE system_logs SET synced_at = ? WHERE id = ?",
                (datetime.now(UTC).isoformat(), row_id),
            )
        db.commit()
        return len(rows)
    except Exception:
        return 0
