"""Visitor analytics: total visits, today's visits, distinct countries.

Equivalent in spirit to job_store.py's in-memory registry, but this data
needs to survive process restarts (that's the whole point of a "total
visitors" counter), so it's backed by a single SQLite file instead of a
plain dict. SQLite is the right amount of database for a single-process
worker like this one — no separate service to run, and the whole file is
one row-locked table.

Country is best-effort only: this process makes no outbound geolocation
calls (no external dependency, no per-visit network request). It reads
whatever country hint the hosting platform's edge already attached to the
request — Cloudflare's ``CF-IPCountry``, Vercel's ``X-Vercel-IP-Country``,
or a generic ``X-Country-Code`` some proxies set — and falls back to
"XX" (unknown) if none of those are present, which is the normal case for
a plain `uvicorn` process with nothing in front of it.
"""
from __future__ import annotations

import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import Request

from .config import settings

_SCHEMA = """
CREATE TABLE IF NOT EXISTS visits (
    visitor_id TEXT PRIMARY KEY,
    first_seen_at REAL NOT NULL,
    last_seen_at REAL NOT NULL,
    last_seen_day TEXT NOT NULL,
    country TEXT NOT NULL,
    visit_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_visits_day ON visits (last_seen_day);
"""

_COUNTRY_HEADERS = ("cf-ipcountry", "x-vercel-ip-country", "x-country-code")


def _today_key() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


@contextmanager
def _conn():
    settings.VISITOR_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(settings.VISITOR_DB_PATH, timeout=5)
    try:
        conn.executescript(_SCHEMA)
        yield conn
        conn.commit()
    finally:
        conn.close()


def country_from_request(request: Request) -> str:
    for header in _COUNTRY_HEADERS:
        value = request.headers.get(header)
        if value and value.strip():
            return value.strip().upper()[:2]
    return "XX"


@dataclass
class VisitorStats:
    total: int
    today: int
    countries: int
    country_codes: list[str]


def record_visit(visitor_id: str, country: str) -> VisitorStats:
    """Upserts one visitor's row (a repeat visit from the same
    browser-generated id updates last_seen/visit_count rather than
    creating a duplicate) and returns the freshly-aggregated totals."""
    now = time.time()
    day = _today_key()
    with _conn() as conn:
        conn.execute(
            """
            INSERT INTO visits (visitor_id, first_seen_at, last_seen_at, last_seen_day, country, visit_count)
            VALUES (?, ?, ?, ?, ?, 1)
            ON CONFLICT(visitor_id) DO UPDATE SET
                last_seen_at = excluded.last_seen_at,
                last_seen_day = excluded.last_seen_day,
                country = excluded.country,
                visit_count = visit_count + 1
            """,
            (visitor_id, now, now, day, country),
        )
        return _aggregate(conn, day)


def get_stats() -> VisitorStats:
    with _conn() as conn:
        return _aggregate(conn, _today_key())


def _aggregate(conn: sqlite3.Connection, day: str) -> VisitorStats:
    total = conn.execute("SELECT COUNT(*) FROM visits").fetchone()[0]
    today = conn.execute("SELECT COUNT(*) FROM visits WHERE last_seen_day = ?", (day,)).fetchone()[0]
    rows = conn.execute("SELECT DISTINCT country FROM visits").fetchall()
    codes = sorted({r[0] for r in rows if r[0] and r[0] != "XX"})
    return VisitorStats(total=total, today=today, countries=len(codes), country_codes=codes)
