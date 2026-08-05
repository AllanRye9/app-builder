"""User accounts + sessions, gating the whole site (see routes.py's
``require_auth`` dependency).

Deliberately **token-based, not cookie-based**: this dashboard already
supports being pointed at a fallback API host if the primary is
unreachable (see web/src/api.js's ``fetchWithFallback``), and a cookie set
for one origin doesn't travel to the other. A bearer token stored in
localStorage and attached as an ``Authorization`` header works the same
way against either host. The one wrinkle is that ``EventSource`` (log
streaming) and a plain ``<a href>`` (APK download) can't attach a custom
header — those two routes additionally accept the token as a ``?token=``
query parameter; see ``require_auth`` below and the matching frontend code
in web/src/api.js.

Passwords are hashed with PBKDF2-HMAC-SHA256 (stdlib ``hashlib``, no extra
dependency — same "don't add a library for what the standard library
already does well enough" philosophy as routes.py's rate limiter) using a
random per-user salt and a deliberately high iteration count. Sessions are
opaque random tokens (``secrets.token_urlsafe``), not JWTs — a session can
be revoked (logout) by deleting its one row, and the token itself carries
no forgeable claims.

Same connection pattern as app/db.py: one lazily-opened, WAL-mode SQLite
connection reused for the process lifetime, with an asyncio.Lock at the
call site serializing access (see visitors.py for the same pattern).
"""
from __future__ import annotations

import asyncio
import hashlib
import re
import secrets
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import HTTPException, Request

from .config import settings

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_PBKDF2_ITERATIONS = 260_000

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    created_at    REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token        TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    created_at   REAL NOT NULL,
    last_seen_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
"""

_conn: sqlite3.Connection | None = None
_lock = asyncio.Lock()


def _get_connection() -> sqlite3.Connection:
    global _conn
    if _conn is not None:
        return _conn

    path: Path = settings.AUTH_DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(_SCHEMA)
    conn.commit()

    _conn = conn
    return conn


@dataclass
class User:
    id: str
    email: str


class AuthError(Exception):
    """A problem the person typing the form should see and fix — as
    opposed to an unexpected server error. Routes convert this straight
    to a 400 with the message as-is."""


def _hash_password(password: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ITERATIONS).hex()


def _create_session(conn: sqlite3.Connection, user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    now = time.time()
    conn.execute(
        "INSERT INTO sessions (token, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)",
        (token, user_id, now, now),
    )
    conn.commit()
    return token


async def sign_up(email: str, password: str) -> tuple[User, str]:
    email = (email or "").strip().lower()
    if not _EMAIL_RE.match(email):
        raise AuthError("Enter a valid email address.")
    if not password or len(password) < 8:
        raise AuthError("Password must be at least 8 characters.")

    salt = secrets.token_bytes(16)
    password_hash = _hash_password(password, salt)
    user_id = secrets.token_hex(16)
    now = time.time()

    async with _lock:
        conn = _get_connection()
        if conn.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
            raise AuthError("An account with that email already exists.")
        conn.execute(
            "INSERT INTO users (id, email, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)",
            (user_id, email, password_hash, salt.hex(), now),
        )
        conn.commit()
        token = _create_session(conn, user_id)

    return User(id=user_id, email=email), token


async def log_in(email: str, password: str) -> tuple[User, str]:
    email = (email or "").strip().lower()
    # Deliberately the same generic error for "no such account" and "wrong
    # password" — telling them apart lets an attacker enumerate which
    # emails have accounts on this instance.
    invalid = AuthError("Incorrect email or password.")

    async with _lock:
        conn = _get_connection()
        row = conn.execute(
            "SELECT id, email, password_hash, salt FROM users WHERE email = ?", (email,)
        ).fetchone()
        if not row:
            raise invalid
        candidate = _hash_password(password, bytes.fromhex(row["salt"]))
        if not secrets.compare_digest(candidate, row["password_hash"]):
            raise invalid
        token = _create_session(conn, row["id"])

    return User(id=row["id"], email=row["email"]), token


async def log_out(token: str) -> None:
    async with _lock:
        conn = _get_connection()
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()


async def user_for_token(token: str | None) -> User | None:
    if not token:
        return None
    ttl_s = settings.SESSION_TTL_MS / 1000
    now = time.time()

    async with _lock:
        conn = _get_connection()
        row = conn.execute(
            """
            SELECT sessions.created_at AS session_created_at, users.id AS user_id, users.email AS email
            FROM sessions JOIN users ON users.id = sessions.user_id
            WHERE sessions.token = ?
            """,
            (token,),
        ).fetchone()
        if not row:
            return None
        if now - row["session_created_at"] > ttl_s:
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
            conn.commit()
            return None
        conn.execute("UPDATE sessions SET last_seen_at = ? WHERE token = ?", (now, token))
        conn.commit()

    return User(id=row["user_id"], email=row["email"])


def token_from_request(request: Request) -> str | None:
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    # EventSource and plain <a href> downloads can't set a custom header —
    # see the module docstring. Only honored on those two GET routes in
    # practice, but harmless to check everywhere.
    return request.query_params.get("token")


async def require_auth(request: Request) -> User:
    """FastAPI dependency: every protected route takes
    ``user: auth.User = Depends(auth.require_auth)``."""
    token = token_from_request(request)
    user = await user_for_token(token)
    if user is None:
        raise HTTPException(status_code=401, detail="Sign in required.")
    return user


def user_public(user: User) -> dict[str, Any]:
    return {"id": user.id, "email": user.email}
