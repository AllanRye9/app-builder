"""Unique-visitor + reached-country tracking.

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

Persistence: a small JSON file at settings.VISITOR_STORE_PATH, keyed by a
truncated SHA-256 of the IP rather than the IP itself, so the raw address
is only ever held in memory for the duration of a single request (used to
call the geolocation lookup) and never written to disk.
"""
from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import logging
import time
from pathlib import Path
from typing import Any

import httpx
from fastapi import Request

from .config import settings

logger = logging.getLogger("apk-builder.visitors")

_lock = asyncio.Lock()
_store: dict[str, dict[str, Any]] = {}
_loaded = False


def _today() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


def _hash_ip(ip: str) -> str:
    # Truncated: this is a dedup key, not a security credential — 16 hex
    # chars (64 bits) is effectively collision-free at any realistic
    # visitor count and keeps the store file small.
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


def _load() -> None:
    global _loaded
    if _loaded:
        return
    _loaded = True
    path: Path = settings.VISITOR_STORE_PATH
    if not path.exists():
        return
    try:
        raw = json.loads(path.read_text())
        if isinstance(raw, dict):
            _store.update(raw)
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Could not read visitor store at %s: %s", path, exc)


def _persist() -> None:
    path: Path = settings.VISITOR_STORE_PATH
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(_store))
        tmp.replace(path)
    except OSError as exc:
        logger.warning("Could not persist visitor store to %s: %s", path, exc)


async def _lookup_country(ip: str) -> str | None:
    """Only ever called once per newly-seen IP — the result is cached in
    _store forever after, so repeat visits never trigger another lookup.
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


def _stats_locked() -> dict[str, Any]:
    today = _today()
    countries = {rec["country"] for rec in _store.values() if rec.get("country")}
    today_count = sum(1 for rec in _store.values() if rec.get("last_seen") == today)
    return {
        "totalVisitors": len(_store),
        "todayVisitors": today_count,
        "countries": len(countries),
        "countryCodes": sorted(countries),
    }


async def record_visit(request: Request) -> dict[str, Any]:
    """Records one visit (deduped by IP) and returns the up-to-date stats.
    Safe to call on every dashboard load — a repeat IP just refreshes its
    `last_seen` date rather than being added again.
    """
    async with _lock:
        _load()
        ip = client_ip(request)
        if ip:
            key = _hash_ip(ip)
            today = _today()
            existing = _store.get(key)
            if existing is None:
                country = await _lookup_country(ip)
                _store[key] = {"country": country, "first_seen": today, "last_seen": today}
                _persist()
            elif existing.get("last_seen") != today:
                existing["last_seen"] = today
                _persist()
        return _stats_locked()


async def get_stats() -> dict[str, Any]:
    """Read-only — does not record a visit, just reports current totals."""
    async with _lock:
        _load()
        return _stats_locked()
