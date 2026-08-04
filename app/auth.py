"""Accounts + sessions, gating the build service behind sign up/login.

Same shape as visitors.py: a single SQLite file (survives restarts, no
separate service to run), two small tables. Sessions are plain opaque
bearer tokens — no JWT, no external dependency — checked against a
`sessions` table on every protected request via `user_for_token()`.
"""
from __future__ import annotations

import hashlib
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass

from .config import settings

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at REAL NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id)
);
"""

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_MIN_PASSWORD_LEN = 8
_PBKDF2_ITERATIONS = 200_000


class AuthError(Exception):
    """Any signup/login failure — message is already safe to show as-is."""


@dataclass
class User:
    id: int
    email: str


@contextmanager
def _conn():
    settings.AUTH_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(settings.AUTH_DB_PATH, timeout=5)
    try:
        conn.executescript(_SCHEMA)
        yield conn
        conn.commit()
    finally:
        conn.close()


def _normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def _hash_password(password: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ITERATIONS).hex()


def _create_session(conn: sqlite3.Connection, user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    conn.execute(
        "INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)",
        (token, user_id, time.time()),
    )
    return token


def signup(email: str, password: str) -> tuple[User, str]:
    """Creates an account + an initial session. Raises AuthError for a
    malformed email, a too-short password, or an already-registered
    email."""
    email = _normalize_email(email)
    if not email or not _EMAIL_RE.match(email):
        raise AuthError("Enter a valid email address.")
    if not password or len(password) < _MIN_PASSWORD_LEN:
        raise AuthError(f"Password must be at least {_MIN_PASSWORD_LEN} characters.")

    salt = secrets.token_bytes(16)
    password_hash = _hash_password(password, salt)

    with _conn() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO users (email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?)",
                (email, password_hash, salt.hex(), time.time()),
            )
        except sqlite3.IntegrityError:
            raise AuthError("An account with that email already exists.") from None
        user = User(id=cur.lastrowid, email=email)
        token = _create_session(conn, user.id)
    return user, token


def login(email: str, password: str) -> tuple[User, str]:
    """Verifies credentials and issues a fresh session. Raises AuthError
    (same message either way) for an unknown email or a wrong password —
    deliberately not distinguishing the two."""
    email = _normalize_email(email)
    with _conn() as conn:
        row = conn.execute(
            "SELECT id, email, password_hash, password_salt FROM users WHERE email = ?",
            (email,),
        ).fetchone()
        if row is None:
            raise AuthError("Incorrect email or password.")
        user_id, user_email, password_hash, salt_hex = row
        if _hash_password(password, bytes.fromhex(salt_hex)) != password_hash:
            raise AuthError("Incorrect email or password.")
        token = _create_session(conn, user_id)
        return User(id=user_id, email=user_email), token


def user_for_token(token: str | None) -> User | None:
    """Looks up the session; returns None for a missing/unknown/revoked
    token rather than raising, so callers can turn that into a 401."""
    if not token:
        return None
    with _conn() as conn:
        row = conn.execute(
            """
            SELECT users.id, users.email FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.token = ?
            """,
            (token,),
        ).fetchone()
    return User(id=row[0], email=row[1]) if row else None


def logout(token: str | None) -> None:
    if not token:
        return
    with _conn() as conn:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
