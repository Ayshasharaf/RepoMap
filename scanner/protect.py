"""Request guards and log redaction for the scanner."""

from __future__ import annotations

import os
import re
import threading
import time
from collections import defaultdict, deque

from fastapi import Request
from fastapi.responses import JSONResponse

# Cheap defaults for a public Railway scanner (clone + optional AI per call).
MAX_BODY_BYTES = int(os.environ.get("REPOMAP_MAX_BODY_BYTES", "4096"))
RATE_LIMIT = int(os.environ.get("REPOMAP_RATE_LIMIT", "10"))
RATE_WINDOW_SEC = int(os.environ.get("REPOMAP_RATE_WINDOW_SEC", "60"))

_BEARER_RE = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-]+")
_KEY_SHAPE_RE = re.compile(
    r"\b(?:gsk_|sk-|ghp_|github_pat_)[A-Za-z0-9_\-]+"
)
_ASSIGNED_SECRET_RE = re.compile(
    r"(?i)\b(api[_-]?key|authorization|token|secret)\s*[:=]\s*['\"]?[^\s'\",}]+"
)

_ENV_SECRET_NAMES = (
    "REPOMAP_AI_API_KEY",
    "GROQ_API_KEY",
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
    "GITHUB_TOKEN",
)

_rate_lock = threading.Lock()
_rate_hits: dict[str, deque[float]] = defaultdict(deque)


def mask_secrets(text: str) -> str:
    """Redact common API-key shapes and known env secret values from log text."""
    if not text:
        return text
    out = _BEARER_RE.sub("Bearer ***", text)
    out = _KEY_SHAPE_RE.sub("***", out)
    out = _ASSIGNED_SECRET_RE.sub(r"\1=***", out)
    for name in _ENV_SECRET_NAMES:
        value = os.environ.get(name, "").strip()
        if len(value) >= 8 and value in out:
            out = out.replace(value, "***")
    return out


def log(msg: str) -> None:
    print(mask_secrets(msg))


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip() or "unknown"
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def check_rate_limit(ip: str) -> str | None:
    """Return an error message if the IP is over the limit, else None."""
    if RATE_LIMIT <= 0:
        return None
    now = time.monotonic()
    with _rate_lock:
        hits = _rate_hits[ip]
        while hits and now - hits[0] >= RATE_WINDOW_SEC:
            hits.popleft()
        if len(hits) >= RATE_LIMIT:
            return (
                f"Rate limit exceeded: max {RATE_LIMIT} scan requests "
                f"per {RATE_WINDOW_SEC}s"
            )
        hits.append(now)
    return None


def body_too_large(request: Request) -> bool:
    raw = request.headers.get("content-length")
    if raw is None:
        return False
    try:
        return int(raw) > MAX_BODY_BYTES
    except ValueError:
        return True


async def protect_scan_requests(request: Request, call_next):
    """Middleware: size + rate limits on scan endpoints only."""
    path = request.url.path
    if request.method == "POST" and (
        path == "/scan-github" or path.startswith("/scan-github/")
    ):
        if body_too_large(request):
            return JSONResponse(
                {"detail": f"Request body too large (max {MAX_BODY_BYTES} bytes)"},
                status_code=413,
            )
        ip = client_ip(request)
        limited = check_rate_limit(ip)
        if limited:
            return JSONResponse({"detail": limited}, status_code=429)
    return await call_next(request)
