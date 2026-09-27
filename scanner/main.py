"""
main.py  –  FastAPI server.

POST /scan-github         {"url": "https://github.com/owner/repo"}
POST /scan-github/stream  same body, newline-delimited progress, then the scan JSON.
"""

import json
import os
import queue
import re
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from overview import build_overview
from scan import scan_directory

# Resolved once at startup: two levels up from scanner/ is the repo root.
_SCANS_DIR = Path(__file__).resolve().parent.parent / "scans"

app = FastAPI()

_GITHUB_RE = re.compile(
    r"^https://github\.com/([A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+?)(?:\.git|/tree/[^/]+|/blob/[^/]+)?/?$"
)


class ScanRequest(BaseModel):
    url: str


def _prepare(url: str) -> tuple[str, str, str]:
    url = url.strip()
    if not url.startswith("https://github.com/"):
        raise HTTPException(status_code=400, detail="Only public https://github.com URLs are accepted")
    match = _GITHUB_RE.match(url)
    if not match:
        raise HTTPException(status_code=400, detail="Invalid GitHub URL format")
    slug = match.group(1)
    return f"https://github.com/{slug}.git", slug.split("/")[-1], slug


def _clone_and_scan(clean_url: str, repo_slug: str, progress=None, page_url: str = "") -> dict:
    tmp_dir = tempfile.mkdtemp()
    try:
        try:
            subprocess.run(
                ["git", "clone", "--depth", "1", clean_url, tmp_dir],
                timeout=45,
                check=True,
                capture_output=True,
                text=True,
            )
        except subprocess.TimeoutExpired:
            raise HTTPException(status_code=504, detail="Clone timed out after 45 seconds")
        except subprocess.CalledProcessError as exc:
            raise HTTPException(status_code=422, detail=f"Clone failed: {exc.stderr.strip()}")

        if progress:
            progress({"type": "status", "phase": "commit", "file": "", "index": 0, "total": 0})

        try:
            result = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=tmp_dir,
                capture_output=True,
                text=True,
                timeout=5,
            )
            commit = result.stdout.strip() or "local"
        except Exception:
            commit = "local"

        data = scan_directory(tmp_dir, commit, progress=progress)
        if progress:
            progress({"type": "status", "phase": "overview", "file": "", "index": 0, "total": 0})
        scanned = data.pop("scannedFiles", None)
        scanned_files = None if scanned is None else set(scanned)
        data["overview"] = build_overview(tmp_dir, data, scanned_files)
        data["service"] = repo_slug
        if page_url:
            data["source"] = page_url
        return data
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _persist(data: dict) -> None:
    """Write the scan result to scans/<service>.json so the Next.js app can read it on reload."""
    try:
        _SCANS_DIR.mkdir(parents=True, exist_ok=True)
        # Use a safe filename: replace any path separators so e.g. "owner/repo" → "owner_repo"
        safe_name = data["service"].replace("/", "_").replace("\\", "_")
        dest = _SCANS_DIR / f"{safe_name}.json"
        payload = json.dumps(data, sort_keys=True, indent=2, ensure_ascii=False) + "\n"
        dest.write_text(payload, encoding="utf-8")
    except Exception as exc:
        # Persistence failure must never kill the HTTP response.
        print(f"[repomap] warn: could not persist scan: {exc}")


@app.post("/scan-github")
def scan_github(req: ScanRequest):
    clean_url, repo_slug, slug = _prepare(req.url)
    data = _clone_and_scan(clean_url, repo_slug, page_url=f"https://github.com/{slug}")
    _persist(data)
    return json.loads(json.dumps(data, sort_keys=True, indent=2))


@app.post("/scan-github/stream")
def scan_github_stream(req: ScanRequest):
    clean_url, repo_slug, repo = _prepare(req.url)
    page_url = f"https://github.com/{repo}"

    def generate():
        events: queue.Queue = queue.Queue()

        def progress(event: dict):
            event.setdefault("repo", repo)
            events.put(event)

        def work():
            try:
                progress({"type": "status", "phase": "clone", "file": "", "index": 0, "total": 0})
                try:
                    data = _clone_and_scan(clean_url, repo_slug, progress=progress, page_url=page_url)
                except HTTPException as exc:
                    detail = exc.detail if isinstance(exc.detail, str) else "Scan failed"
                    events.put({"type": "error", "detail": detail})
                    return
                _persist(data)
                events.put({"type": "result", "data": data})
            except Exception as exc:
                events.put({"type": "error", "detail": str(exc)})
            finally:
                events.put(None)

        threading.Thread(target=work, daemon=True).start()
        while True:
            item = events.get()
            if item is None:
                break
            yield json.dumps(item, ensure_ascii=False) + "\n"

    return StreamingResponse(
        generate(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
