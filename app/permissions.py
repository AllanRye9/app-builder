"""Android permission whitelist and sanitizer.

Permissions are chosen by whoever is generating the APK — never invented by
the build itself. This module only *validates* what the user sent (so
build_runner.py can't be handed something that isn't a real Android
permission string); it does not decide which ones an app gets.

Whitelist, not a denylist: an open-ended "any string the client sends gets
written into AndroidManifest.xml" is an injection vector (a malformed value
could break out of the ``<uses-permission>`` tag). Keeping this list means
only recognizable, well-formed permission constants can ever reach the
manifest.
"""
from __future__ import annotations

import json
import re
from collections.abc import Iterable
from typing import Any

ALLOWED_PERMISSIONS: frozenset[str] = frozenset(
    {
        "android.permission.INTERNET",
        "android.permission.ACCESS_NETWORK_STATE",
        "android.permission.ACCESS_WIFI_STATE",
        "android.permission.ACCESS_FINE_LOCATION",
        "android.permission.ACCESS_COARSE_LOCATION",
        "android.permission.ACCESS_BACKGROUND_LOCATION",
        "android.permission.CAMERA",
        "android.permission.RECORD_AUDIO",
        "android.permission.READ_EXTERNAL_STORAGE",
        "android.permission.WRITE_EXTERNAL_STORAGE",
        "android.permission.READ_MEDIA_IMAGES",
        "android.permission.READ_MEDIA_VIDEO",
        "android.permission.READ_MEDIA_AUDIO",
        "android.permission.POST_NOTIFICATIONS",
        "android.permission.VIBRATE",
        "android.permission.BLUETOOTH",
        "android.permission.BLUETOOTH_ADMIN",
        "android.permission.BLUETOOTH_CONNECT",
        "android.permission.BLUETOOTH_SCAN",
        "android.permission.READ_CONTACTS",
        "android.permission.WRITE_CONTACTS",
        "android.permission.READ_CALENDAR",
        "android.permission.WRITE_CALENDAR",
        "android.permission.CALL_PHONE",
        "android.permission.READ_PHONE_STATE",
        "android.permission.SEND_SMS",
        "android.permission.RECEIVE_SMS",
        "android.permission.READ_SMS",
        "android.permission.FOREGROUND_SERVICE",
        "android.permission.WAKE_LOCK",
        "android.permission.USE_BIOMETRIC",
        "android.permission.USE_FINGERPRINT",
    }
)

MAX_PERMISSIONS = 40  # generous ceiling, just guards against abuse

_SPLIT_RE = re.compile(r"[,\s]+")


def sanitize_permissions(raw: Any) -> list[str]:
    """Accept whatever the upload form actually sends: a JSON array string
    (``'["android.permission.CAMERA", ...]'``) or, as a fallback, a
    comma/whitespace-separated list. Anything not in ALLOWED_PERMISSIONS is
    silently dropped rather than rejected outright — an unrecognized entry
    is far more likely to be a typo than an attack, and failing the whole
    upload over one bad permission name would be a worse experience than
    just not applying it.
    """
    if not raw:
        return []

    candidates: Iterable[Any]
    if isinstance(raw, list):
        candidates = raw
    elif isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            candidates = parsed if isinstance(parsed, list) else [raw]
        except (json.JSONDecodeError, ValueError):
            candidates = _SPLIT_RE.split(raw)
    else:
        return []

    seen: dict[str, None] = {}
    for candidate in candidates:
        if not isinstance(candidate, str):
            continue
        trimmed = candidate.strip()
        if trimmed in ALLOWED_PERMISSIONS:
            seen.setdefault(trimmed, None)
        if len(seen) >= MAX_PERMISSIONS:
            break
    return list(seen.keys())
