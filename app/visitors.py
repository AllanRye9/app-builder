"""Unique-visitor + reached-country tracking, backed by app/db.py's SQLite
database.

Counts are deliberately deduplicated at two levels:
  - a visitor is unique per IP address — the same IP hitting the dashboard
    10 times in a day is still exactly 1 visitor, both for the all-time
    total and for "today"
  - a country is unique per country code — 500 visitors from the US still
    only add "US" once to the reached-countries count

Both counts are IP-derived, so this necessarily can't distinguish two
different people behind the same IP (a shared office/NAT/VPN egress) from
one person — that's an inherent limitation of IP-based counting, not a bug
in the dedup logic below.

Privacy: the visitors table is keyed by a truncated SHA-256 of the IP
rather than the IP itself, so the raw address is only ever held in memory
for the duration of a single request (used to call the geolocation lookup)
and is never written to the database.
"""
from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import logging
import sqlite3
import time
from typing import Any

import httpx
from fastapi import Request

from .config import settings
from .db import get_connection

logger = logging.getLogger("apk-builder.visitors")

_lock = asyncio.Lock()


def _today() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


def _hash_ip(ip: str) -> str:
    # Truncated: this is a dedup key, not a security credential — 16 hex
    # chars (64 bits) is effectively collision-free at any realistic
    # visitor count and keeps each row small.
    return hashlib.sha256(ip.encode("utf-8")).hexdigest()[:16]


def client_ip(request: Request) -> str | None:
    """Prefers X-Forwarded-For (this app is commonly run behind a reverse
    proxy — see README's client_max_body_size note) and falls back to the
    direct connection. Takes the first hop of X-Forwarded-For, i.e. the
    original client, not the proxy itself.
    """
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        first = forwarded.split(",")[0].strip()
        if first:
            return first
    if request.client:
        return request.client.host
    return None


def _is_public(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return not (addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved or addr.is_multicast)


async def _lookup_country(ip: str) -> str | None:
    """Only ever called once per newly-seen IP — the result is stored in
    the database forever after, so repeat visits never trigger another
    lookup.
    """
    if not settings.GEOIP_LOOKUP_URL or not _is_public(ip):
        return None
    try:
        async with httpx.AsyncClient(timeout=settings.GEOIP_TIMEOUT_S) as client:
            resp = await client.get(settings.GEOIP_LOOKUP_URL.format(ip=ip))
            resp.raise_for_status()
            data = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.info("Geo-IP lookup failed for this visitor: %s", exc)
        return None
    if data.get("status") == "fail":
        return None
    code = data.get("countryCode")
    return code if isinstance(code, str) and len(code) == 2 else None


def _stats(conn: sqlite3.Connection) -> dict[str, Any]:
    today = _today()
    total = conn.execute("SELECT COUNT(*) FROM visitors").fetchone()[0]
    today_count = conn.execute("SELECT COUNT(*) FROM visitors WHERE last_seen = ?", (today,)).fetchone()[0]
    country_codes = [
        row[0]
        for row in conn.execute(
            "SELECT DISTINCT country_code FROM visitors WHERE country_code IS NOT NULL ORDER BY country_code"
        ).fetchall()
    ]
    return {
        "totalVisitors": total,
        "todayVisitors": today_count,
        "countries": len(country_codes),
        "countryCodes": country_codes,
    }


async def record_visit(request: Request) -> dict[str, Any]:
    """Records one visit (deduped by IP, upserted into the visitors table)
    and returns the up-to-date stats. Safe to call on every dashboard load
    — a repeat IP just refreshes its `last_seen` date rather than being
    added again.
    """
    async with _lock:
        conn = get_connection()
        ip = client_ip(request)
        if ip:
            key = _hash_ip(ip)
            today = _today()
            row = conn.execute("SELECT country_code, last_seen FROM visitors WHERE ip_hash = ?", (key,)).fetchone()
            if row is None:
                country = await _lookup_country(ip)
                conn.execute(
                    "INSERT INTO visitors (ip_hash, country_code, first_seen, last_seen) VALUES (?, ?, ?, ?) "
                    "ON CONFLICT(ip_hash) DO NOTHING",
                    (key, country, today, today),
                )
                conn.commit()
            elif row["last_seen"] != today:
                conn.execute("UPDATE visitors SET last_seen = ? WHERE ip_hash = ?", (today, key))
                conn.commit()
        return _stats(conn)


async def get_stats() -> dict[str, Any]:
    """Read-only — does not record a visit, just reports current totals."""
    async with _lock:
        conn = get_connection()
        return _stats(conn)
