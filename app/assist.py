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
    "uploaded React/Capacitor, native Kotlin/Java, or Flutter (Dart) project "
    "archives into unsigned, installable debug Android APKs inside disposable "
    "build containers. Flutter projects are built with `flutter pub get` followed "
    "by `flutter build apk --debug`, driving the project's own embedded android/ "
    "Gradle project — if the uploaded project didn't include an android/ folder "
    "(or it was missing gradlew/gradle-wrapper.jar, which is normal for a project "
    "exported from git since Flutter's default .gitignore excludes them), apkit "
    "runs `flutter create --platforms=android .` first to generate it before "
    "building. You're shown next to a build that failed. Answer the person's "
    "question about it directly and concretely — name the likely cause and the "
    "specific fix (a command to run, a file to check, a line to add), in 2-4 "
    "short paragraphs or a short list. For a Flutter project, ground the fix in "
    "the Flutter/Dart toolchain (pubspec.yaml, flutter pub get, flutter build "
    "apk) rather than assuming a native-Android or npm/Capacitor cause unless the "
    "error text actually points there. Don't pad with reassurance or ask "
    "clarifying questions unless the error message genuinely could mean more "
    "than one thing. You don't have shell access and can't see anything beyond "
    "what's included in this message. The person can open a quick-fix editor "
    "for any file in their uploaded project right from this panel — if the fix "
    "is a small, targeted change to one specific file (a config value, a "
    "manifest entry, a missing dependency line, a pubspec.yaml entry), name "
    "that exact file path so they know what to open."
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
    if context.get("exitCode") is not None:
        lines.append(f"- Process exit code: {context['exitCode']}")
    log_tail = context.get("logTail")
    if log_tail:
        tail = "\n".join(str(l) for l in log_tail[-25:])
        lines.append(f"- Last log lines:\n{tail}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Exit-code-aware hints — layered on top of (not a replacement for) the
# keyword patterns below, since a bare exit code is a weaker signal than
# matched error text but is always available even when the log itself
# doesn't say much (see build_runner.py's lines_captured==0 case).
# ---------------------------------------------------------------------------
_EXIT_CODE_HINTS: dict[int, str] = {
    126: "Exit code 126 means the command was found but couldn't be executed — usually a permissions "
    "problem (needs chmod +x) rather than anything wrong with the build logic itself.",
    127: "Exit code 127 means 'command not found' — a required executable isn't on PATH inside the "
    "build container. If this is your own script, double check the shebang and that the tool it "
    "calls is actually a declared dependency.",
    137: "Exit code 137 means the process was killed by SIGKILL — overwhelmingly the container's "
    "out-of-memory killer (or the build was stopped mid-run). If it's OOM, try lowering "
    "MAX_CONCURRENT_BUILDS or giving the container more memory.",
    143: "Exit code 143 means the process received SIGTERM — something asked it to shut down, which "
    "for a build usually means a timeout or an external stop request rather than a code error.",
    134: "Exit code 134 (SIGABRT) usually means a native crash — for a JVM-based build this can point "
    "to a JIT/native-library bug rather than the project's own source.",
    139: "Exit code 139 (SIGSEGV) is a segmentation fault in a native process — not something fixable "
    "by editing the app's own source; it usually means an incompatible native binary/toolchain.",
    65: "Exit code 65 (EX_DATAERR) means malformed input was fed to a tool — check for an invalid "
    "config, manifest, or JSON/YAML file rather than a code logic error.",
    78: "Exit code 78 (EX_CONFIG) points at a configuration problem — check the relevant config file "
    "(gradle.properties, capacitor.config, pubspec.yaml, etc.) for a missing or malformed value.",
}


def _exit_code_note(exit_code: int | None) -> str | None:
    if exit_code is None:
        return None
    if exit_code in _EXIT_CODE_HINTS:
        return _EXIT_CODE_HINTS[exit_code]
    if 128 < exit_code <= 165:
        return (
            f"Exit code {exit_code} means the process was killed by signal {exit_code - 128} — "
            "that's an external termination (OOM killer, timeout, or a manual stop), not a normal "
            "build-logic failure."
        )
    return None


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
    # --- Flutter/Dart-specific patterns (checked before the generic native-
    # Android Gradle-wrapper pattern below, since a Flutter build's own
    # embedded Gradle step can surface wrapper-shaped error text too, but
    # the fix there is never "run `gradle wrapper` by hand" — apkit
    # regenerates that wrapper itself via `flutter create`).
    (
        ("no pubspec.yaml", "pubspec.yaml not found", "could not find a file named pubspec"),
        "No pubspec.yaml was found for this Flutter project. Make sure pubspec.yaml sits at the "
        "project root of the archive (or a single wrapper folder above it) — apkit locates the "
        "project root by searching for it, but it does need to exist somewhere in the zip.",
    ),
    (
        ("version solving failed", "pub get failed", "pub failed", "could not resolve the package"),
        "This is a Flutter/Dart dependency resolution error from `flutter pub get`. Check "
        "pubspec.yaml for a version constraint that can't be satisfied (a package pinned to an "
        "SDK-incompatible version is the usual cause) — running `flutter pub get` locally will "
        "reproduce the same error with more detail before you re-zip.",
    ),
    (
        ("target file", "lib/main.dart", "target application not found"),
        "Flutter can't find the app's entry point. Confirm lib/main.dart exists at that exact path "
        "and pubspec.yaml's `name:` field matches what the code imports elsewhere in lib/.",
    ),
    (
        ("no android/ folder", "flutter create ran but no working android/", "gradlew + gradle-wrapper.jar"),
        "apkit tried to generate the missing android/ platform folder with `flutter create` but the "
        "result still wasn't buildable. This usually points to a Flutter SDK/toolchain issue in the "
        "container rather than the uploaded project's own code — check the log lines right above "
        "this for what `flutter create` itself reported.",
    ),
    (
        ("gradlew: not found", "gradlew: permission denied", "could not find or load main class"),
        "The Gradle wrapper looks incomplete or non-executable. For a native Android project this "
        "means all four wrapper files need to be present: gradlew, gradlew.bat, "
        "gradle/wrapper/gradle-wrapper.jar, and gradle/wrapper/gradle-wrapper.properties — if you "
        "generated the project by hand rather than with Android Studio, run `gradle wrapper` in the "
        "project root and re-zip. For a Flutter project, don't do this by hand: apkit auto-generates "
        "android/'s wrapper via `flutter create` when it's missing (normal for a project exported "
        "from git, since Flutter's own .gitignore excludes those files) — if it's still failing after "
        "that step, the issue is more likely in flutter build apk's own output further up the log.",
    ),
    (
        ("settings.gradle", "could not determine the dependencies", "project 'app' not found"),
        "Gradle can't locate the app module. Check that settings.gradle (or settings.gradle.kts) at "
        "the project root includes `include ':app'`, and that an app/build.gradle actually exists at "
        "that path in the archive. (For a Flutter project, this file lives under android/ and is "
        "normally managed by Flutter itself — don't hand-edit it unless you know why it's wrong.)",
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
        "This looks like a network issue reaching a dependency host (Maven Central, the pub.dev "
        "registry, npm registry, or the Gradle distribution servers) from inside the build container, "
        "not a problem with the project itself. It's often transient — retrying the same archive is "
        "worth trying first.",
    ),
    (
        ("android/", "ios/", "platforms/"),
        "Archives with a top-level android/, ios/, or platforms/ folder are rejected outright for "
        "web/Capacitor and native-Android uploads, since those are generated by the build itself and "
        "can't be safely merged with an existing one. A Flutter project is the one exception — its "
        "own android/ and ios/ folders are real, hand-maintained source and are allowed as soon as a "
        "pubspec.yaml is present anywhere in the archive. If this isn't a Flutter project, remove that "
        "folder from the zip and try again; it'll be regenerated fresh during the build.",
    ),
    (
        ("permission", "manifest.permission", "androidmanifest"),
        "If this is about a missing runtime permission rather than a build failure, check the "
        "Android permissions panel before uploading — nothing is added to the manifest automatically, "
        "only what you explicitly check there. This applies the same way to a Flutter project's "
        "android/app/src/main/AndroidManifest.xml.",
    ),
]

_GENERIC_FALLBACK = (
    "I don't have a specific pattern match for this error, and no AI key is configured on this "
    "instance for a deeper look (set ANTHROPIC_API_KEY on the server to enable that). A few general "
    "next steps: check the full build log (below the error banner) for the first error line, not just "
    "the last one — the real cause is often several lines above where the build finally gave up. If "
    "this is a native Android project, confirming it builds locally with the same Gradle wrapper "
    "before re-uploading rules out most environment-specific issues. If this is a Flutter project, "
    "running `flutter pub get` and `flutter build apk --debug` locally against the same code is the "
    "equivalent check."
)


def _fallback_answer(question: str, context: dict[str, Any]) -> str:
    haystack = " ".join(
        [
            question.lower(),
            str(context.get("errorMessage") or "").lower(),
            " ".join(str(l) for l in (context.get("logTail") or [])).lower(),
        ]
    )

    exit_note = _exit_code_note(context.get("exitCode"))

    for keywords, advice in _PATTERNS:
        if any(kw in haystack for kw in keywords):
            return f"{advice}\n\n{exit_note}" if exit_note else advice

    if exit_note:
        return f"{exit_note}\n\n{_GENERIC_FALLBACK}"
    return _GENERIC_FALLBACK
