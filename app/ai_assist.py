"""Best-effort AI assistance for build failures.

Powers a small chat panel (see the right side panel in web/src/App.jsx)
that appears only when a build has failed, letting the person ask
questions about *that job's* error/log context. Entirely optional: with
no AI_API_KEY configured, is_configured() returns False and the route
(POST /api/assist in routes.py) answers with a plain, honest message
instead of ever calling this module's ask() — so a missing key changes
nothing about uploads, builds, or downloads elsewhere in the app.

Talks to the Anthropic Messages API directly over HTTP (via the httpx
dependency already used by app/visitors.py for geolocation lookups),
rather than pulling in the full SDK for one call site.
"""
from __future__ import annotations

import httpx

from .config import settings

MAX_QUESTION_LEN = 800

# How much of the job's own context rides along in the system prompt —
# capped so one huge/noisy build log can't blow up the request payload or
# the token bill for what's meant to be a short, cheap Q&A.
_LOG_TAIL_LINES = 40
_LOG_TAIL_CHARS = 4000


class AssistError(Exception):
    """Raised for any failure calling the AI provider — the message is
    already safe to show to the person as-is."""


def is_configured() -> bool:
    return bool(settings.AI_API_KEY)


def _build_context(*, filename: str, project_type: str | None, error: str | None, logs: list[str]) -> str:
    tail = "\n".join(logs[-_LOG_TAIL_LINES:])[-_LOG_TAIL_CHARS:]
    return "\n\n".join([
        f"Project file: {filename}",
        f"Project type: {project_type or 'unknown'}",
        f"Reported error: {error or '(no error message recorded)'}",
        "Recent build log (most recent lines):",
        tail or "(no log lines captured)",
    ])


async def ask(
    *,
    question: str,
    filename: str,
    project_type: str | None,
    error: str | None,
    logs: list[str],
) -> str:
    """Asks the configured AI provider to help explain/fix this job's
    failure. Raises AssistError (safe to show as-is) for any problem —
    missing key, unreachable provider, a non-2xx response, or an
    unparsable/empty reply — so the route layer never has to guess
    whether a given exception is presentable."""
    if not settings.AI_API_KEY:
        raise AssistError("AI assistance is not configured on this server.")

    system_prompt = (
        "You are a build-troubleshooting assistant embedded in an Android APK "
        "build dashboard. A build just failed. Use the error and log context "
        "below, together with your general knowledge of Android, Gradle, npm, "
        "and Capacitor tooling, to help the person understand what went wrong "
        "and how to fix it. Be concise and concrete — a few sentences or a "
        "short list of steps, not an essay. If the context genuinely isn't "
        "enough to answer confidently, say so plainly rather than guessing.\n\n"
        "--- Build context ---\n"
        + _build_context(filename=filename, project_type=project_type, error=error, logs=logs)
    )

    payload = {
        "model": settings.AI_MODEL,
        "max_tokens": 500,
        "system": system_prompt,
        "messages": [{"role": "user", "content": question}],
    }
    headers = {
        "x-api-key": settings.AI_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=settings.AI_TIMEOUT_S) as client:
            resp = await client.post(settings.AI_API_URL, json=payload, headers=headers)
    except httpx.HTTPError as exc:
        raise AssistError("The AI service couldn't be reached right now.") from exc

    if resp.status_code == 401:
        raise AssistError("The configured AI_API_KEY was rejected by the provider.")
    if resp.status_code == 429:
        raise AssistError("The AI service is rate-limiting this server right now — try again shortly.")
    if resp.status_code >= 400:
        raise AssistError(f"The AI service returned an error (HTTP {resp.status_code}).")

    try:
        data = resp.json()
        blocks = data.get("content") or []
        text = "".join(b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text")
    except (ValueError, AttributeError) as exc:
        raise AssistError("Got an unexpected response from the AI service.") from exc

    text = text.strip()
    if not text:
        raise AssistError("The AI service returned an empty response.")
    return text
