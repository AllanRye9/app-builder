"""SQLite database for visitor + country analytics.

Replaces the earlier flat-JSON store with an actual database:

  - a real schema with a primary key and a CHECK constraint, instead of
    "whatever shape happened to get json.dump'd"
  - WAL journal mode, so a read (a stats poll) never blocks a concurrent
    write (a visitor ping), and a crash mid-write can't corrupt the file
    the way truncating-and-rewriting a JSON blob can
  - atomic upserts (INSERT ... ON CONFLICT) instead of load-entire-file,
    mutate-in-Python, write-entire-file-back
  - indexed COUNT / COUNT(DISTINCT) queries instead of iterating every
    stored visitor in Python on every /api/visitors/stats request

One connection is opened lazily and reused for the life of the process
(check_same_thread=False — every call site already serializes access via
visitors.py's asyncio.Lock, same as the JSON version did).
"""
from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path

from .config import settings

logger = logging.getLogger("apk-builder.db")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS visitors (
    ip_hash      TEXT PRIMARY KEY,
    country_code TEXT CHECK (country_code IS NULL OR length(country_code) = 2),
    first_seen   TEXT NOT NULL,
    last_seen    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_visitors_last_seen    ON visitors(last_seen);
CREATE INDEX IF NOT EXISTS idx_visitors_country_code ON visitors(country_code);
"""

_conn: sqlite3.Connection | None = None


def get_connection() -> sqlite3.Connection:
    """Returns the shared connection, opening it (and running schema setup
    + the one-time legacy-JSON migration) on first call.
    """
    global _conn
    if _conn is not None:
        return _conn

    path: Path = settings.VISITOR_DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # WAL: concurrent readers don't block the writer (or each other).
    # NORMAL sync is the standard, safe pairing with WAL — full fsync on
    # every write isn't needed for analytics counts the way it would be
    # for, say, payment records.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(_SCHEMA)
    conn.commit()

    _migrate_legacy_json(conn)

    _conn = conn
    return conn


def _migrate_legacy_json(conn: sqlite3.Connection) -> None:
    """One-time import from the pre-database VISITOR_STORE_PATH JSON file,
    if one exists and the visitors table is still empty. The old file is
    renamed aside (not deleted) afterwards, so this is safe to leave in
    place permanently — it's a no-op once migrated.
    """
    legacy_path: Path = settings.VISITOR_STORE_PATH
    if not legacy_path.exists():
        return

    (count,) = conn.execute("SELECT COUNT(*) FROM visitors").fetchone()
    if count > 0:
        # Database already has data — don't overwrite it with a stale
        # export. Just get the old file out of the way.
        _archive_legacy_file(legacy_path)
        return

    try:
        raw = json.loads(legacy_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Could not read legacy visitor store at %s: %s", legacy_path, exc)
        return

    if not isinstance(raw, dict) or not raw:
        _archive_legacy_file(legacy_path)
        return

    rows = []
    for ip_hash, rec in raw.items():
        if not isinstance(rec, dict):
            continue
        country = rec.get("country")
        country = country if isinstance(country, str) and len(country) == 2 else None
        first_seen = rec.get("first_seen") or rec.get("last_seen")
        last_seen = rec.get("last_seen") or first_seen
        if not first_seen or not last_seen:
            continue
        rows.append((ip_hash, country, first_seen, last_seen))

    if rows:
        conn.executemany(
            "INSERT OR IGNORE INTO visitors (ip_hash, country_code, first_seen, last_seen) VALUES (?, ?, ?, ?)",
            rows,
        )
        conn.commit()
        logger.info("Migrated %d visitor record(s) from legacy JSON store into %s", len(rows), settings.VISITOR_DB_PATH)

    _archive_legacy_file(legacy_path)


def _archive_legacy_file(legacy_path: Path) -> None:
    try:
        legacy_path.rename(legacy_path.with_name(legacy_path.name + ".migrated"))
    except OSError as exc:
        logger.warning("Could not archive legacy visitor store at %s: %s", legacy_path, exc)
