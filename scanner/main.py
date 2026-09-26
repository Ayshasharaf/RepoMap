"""
main.py  –  FastAPI server.

POST /scan-github  {"url": "https://github.com/owner/repo"}
Returns the scan JSON defined by CONTRACT.md.
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from overview import build_overview
from scan import scan_directory

app = FastAPI()

_GITHUB_RE = re.compile(
    r"^https://github\.com/([A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+?)(?:\.git|/tree/[^/]+|/blob/[^/]+)?/?$"
)


class ScanRequest(BaseModel):
    url: str


@app.post("/scan-github")
def scan_github(req: ScanRequest):
    url = req.url.strip()

    # Validate host – never fetch anything other than github.com
    if not url.startswith("https://github.com/"):
        raise HTTPException(status_code=400, detail="Only public https://github.com URLs are accepted")

    m = _GITHUB_RE.match(url)
    if not m:
        raise HTTPException(status_code=400, detail="Invalid GitHub URL format")

    clean_url = f"https://github.com/{m.group(1)}.git"

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

        # Resolve commit SHA
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

        data = scan_directory(tmp_dir, commit)
        data["overview"] = build_overview(tmp_dir, data)

        # Override service name with repo slug (not a temp path basename)
        repo_slug = m.group(1).split("/")[-1]
        data["service"] = repo_slug

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    return json.loads(json.dumps(data, sort_keys=True, indent=2))
