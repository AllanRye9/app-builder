"""Troubleshooting assistant behind the error side panel (see
web/src/components/ErrorAssistant.jsx).

Two answer paths, chosen automatically:

  - ``ANTHROPIC_API_KEY`` set: the question, plus whatever's known about
    the failed build (filename, project type, error message, last few log
    lines), is sent to the Anthropic Messages API directly over ``httpx``
    (already a dependency for the geo-IP lookup in visitors.py — no SDK
    needed for one endpoint) for a context-aware answer.
  - Unset, or the API call fails for any reason (network, bad key, rate
    limit): falls back to ``_fallback_answer`` below, a small
    pattern-matched library of general build-troubleshooting knowledge.
    The panel still works either way — this is a genuine fallback, not an
    error state, so callers never see the difference except a `source`
    field in the response.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

from .config import settings

logger = logging.getLogger("apk-builder.assist")

_ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
_ANTHROPIC_TIMEOUT_S = 20.0

_SYSTEM_PROMPT = (
    "You are the troubleshooting assistant embedded in apkit, a tool that turns "
    "uploaded React/Capacitor or native Kotlin/Java project archives into signed "
    "Android APKs inside disposable build containers. You're shown next to a build "
    "that failed. Answer the person's question about it directly and concretely — "
    "name the likely cause and the specific fix (a command to run, a file to check, "
    "a line to add), in 2-4 short paragraphs or a short list. Don't pad with "
    "reassurance or ask clarifying questions unless the error message genuinely "
    "could mean more than one thing. You don't have shell access and can't see "
    "anything beyond what's included in this message."
)


async def answer(question: str, context: dict[str, Any], history: list[dict[str, str]]) -> dict[str, str]:
    question = (question or "").strip()
    if not question:
        return {"answer": "Ask a question about the error and I'll take a look.", "source": "fallback"}

    if settings.ANTHROPIC_API_KEY:
        try:
            text = await _ask_claude(question, context, history)
            return {"answer": text, "source": "ai"}
        except Exception as exc:  # noqa: BLE001 — any failure here should fall back, not 500
            logger.info("AI assist request failed, using fallback: %s", exc)

    return {"answer": _fallback_answer(question, context), "source": "fallback"}


async def _ask_claude(question: str, context: dict[str, Any], history: list[dict[str, str]]) -> str:
    context_block = _format_context(context)
    messages: list[dict[str, str]] = []
    for turn in history[-6:]:  # a handful of prior turns is plenty of context for this
        role = "assistant" if turn.get("role") == "assistant" else "user"
        content = str(turn.get("content") or "").strip()
        if content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": f"{context_block}\n\nQuestion: {question}"})

    async with httpx.AsyncClient(timeout=_ANTHROPIC_TIMEOUT_S) as client:
        resp = await client.post(
            _ANTHROPIC_URL,
            headers={
                "x-api-key": settings.ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": settings.ASSIST_MODEL,
                "max_tokens": 500,
                "system": _SYSTEM_PROMPT,
                "messages": messages,
            },
        )
        resp.raise_for_status()
        data = resp.json()

    parts = [block.get("text", "") for block in data.get("content", []) if block.get("type") == "text"]
    text = "".join(parts).strip()
    if not text:
        raise ValueError("Empty response from model.")
    return text


def _format_context(context: dict[str, Any]) -> str:
    lines = ["Build context:"]
    if context.get("fileName"):
        lines.append(f"- Archive: {context['fileName']}")
    if context.get("projectType"):
        lines.append(f"- Project type: {context['projectType']}")
    if context.get("errorMessage"):
        lines.append(f"- Error: {context['errorMessage']}")
    log_tail = context.get("logTail")
    if log_tail:
        tail = "\n".join(str(l) for l in log_tail[-25:])
        lines.append(f"- Last log lines:\n{tail}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Deterministic fallback — no network call, no API key required. Pattern-
# matched against the error text; falls through to general advice if
# nothing more specific matches. This is genuinely how the site behaves
# with no ANTHROPIC_API_KEY configured, not a degraded stub.
# ---------------------------------------------------------------------------
_PATTERNS: list[tuple[tuple[str, ...], str]] = [
    (
        ("out of memory", "oom", "java heap space", "gc overhead"),
        "This looks like the build ran out of memory inside the container. Gradle + the Android "
        "Gradle Plugin can need 1.5-2.5GB on their own — if MAX_CONCURRENT_BUILDS is set above 1 on "
        "a small host, concurrent builds can exhaust it. Try lowering MAX_CONCURRENT_BUILDS, or give "
        "the container more RAM, before re-running the build.",
    ),
    (
        ("gradle-wrapper.jar", "gradlew: not found", "gradlew: permission denied", "could not find or load main class"),
        "The Gradle wrapper looks incomplete or non-executable. A native Android project needs all "
        "four wrapper files present: gradlew, gradlew.bat, gradle/wrapper/gradle-wrapper.jar, and "
        "gradle/wrapper/gradle-wrapper.properties. If you generated the project by hand rather than "
        "with Android Studio, run `gradle wrapper` in the project root and re-zip.",
    ),
    (
        ("settings.gradle", "could not determine the dependencies", "project 'app' not found"),
        "Gradle can't locate the app module. Check that settings.gradle (or settings.gradle.kts) at "
        "the project root includes `include ':app'`, and that an app/build.gradle actually exists at "
        "that path in the archive.",
    ),
    (
        ("npm err", "enoent", "cannot find module", "peer dep"),
        "This is an npm dependency resolution error. Make sure package-lock.json (or package.json's "
        "declared versions) actually resolve cleanly — try `npm install` locally first and confirm it "
        "finishes without errors before re-zipping the project.",
    ),
    (
        ("sdk location not found", "android_home", "no android sdk", "cmdline-tools"),
        "The build container couldn't find a configured Android SDK — this usually means something in "
        "the project (a local.properties with a hardcoded, machine-specific sdk.dir path) is "
        "overriding the container's own SDK. Remove any local.properties from the archive before "
        "zipping; the container provides its own.",
    ),
    (
        ("network", "timed out", "timeout", "could not resolve host", "connection refused"),
        "This looks like a network issue reaching a dependency host (Maven Central, npm registry, or "
        "the Gradle distribution servers) from inside the build container, not a problem with the "
        "project itself. It's often transient — retrying the same archive is worth trying first.",
    ),
    (
        ("android/", "ios/", "platforms/"),
        "Archives with a top-level android/, ios/, or platforms/ folder are rejected outright — those "
        "are generated by the build itself and can't be safely merged with an existing one. Remove "
        "that folder from the zip and try again; it'll be regenerated fresh during the build.",
    ),
    (
        ("permission", "manifest.permission", "androidmanifest"),
        "If this is about a missing runtime permission rather than a build failure, check the "
        "Android permissions panel before uploading — nothing is added to the manifest automatically, "
        "only what you explicitly check there.",
    ),
]

_GENERIC_FALLBACK = (
    "I don't have a specific pattern match for this error, and no AI key is configured on this "
    "instance for a deeper look (set ANTHROPIC_API_KEY on the server to enable that). A few general "
    "next steps: check the full build log (below the error banner) for the first error line, not just "
    "the last one — the real cause is often several lines above where the build finally gave up. If "
    "this is a native Android project, confirming it builds locally with the same Gradle wrapper "
    "before re-uploading rules out most environment-specific issues."
)


def _fallback_answer(question: str, context: dict[str, Any]) -> str:
    haystack = " ".join(
        [
            question.lower(),
            str(context.get("errorMessage") or "").lower(),
            " ".join(str(l) for l in (context.get("logTail") or [])).lower(),
        ]
    )
    for keywords, advice in _PATTERNS:
        if any(kw in haystack for kw in keywords):
            return advice
    return _GENERIC_FALLBACK
