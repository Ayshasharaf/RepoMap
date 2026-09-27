# RepoMap

Paste a public GitHub repository URL and get eight views of how it is built: Overview, Architecture, Data flow, Endpoints, Dependencies, Entry points, Key paths, and Health.

**Pitch:** architecture maps for any public repo when an AI key is set, plus Spring Boot structure (entities, endpoints, modules) when the repo is Java.

## How it works

```
GitHub URL  →  Python scanner (FastAPI)  →  JSON  →  Next.js dashboard
```

1. The **scanner** (`scanner/`) shallow-clones the repo, walks every `.java` file with `javalang`, and returns JSON describing entities, relations, endpoints, findings, diagrams, and an overview. When `REPOMAP_AI_API_KEY` or `OPENAI_API_KEY` is set, it also asks that model for an architecture diagram of any language and keeps the chart only if every linked path exists in the clone.
2. The **web app** (`apps/web/`) receives that JSON (streamed as NDJSON), renders it into seven sections, and writes it to `scans/` so it survives a page refresh.

## Requirements

| Tool | Version |
|------|---------|
| Python | 3.11+ |
| Node.js | 18+ |
| git | any recent |

## Quickstart

### 1. Install scanner dependencies

```bash
cd scanner
pip install -r requirements.txt
```

Optional smoke check:

```bash
python3 -m unittest test_smoke.py -v
```

### 2. Start the scanner

```bash
# from the scanner/ directory
uvicorn main:app --reload --port 8000
```

The scanner listens on `http://localhost:8000`.

### 3. Configure the web app

```bash
cp apps/web/.env.example apps/web/.env.local
# .env.local already points SCANNER_URL at http://localhost:8000
```

### 4. Install and start the web app

```bash
cd apps/web
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### 5. Map a repo

Paste any public Spring Boot Java GitHub URL, e.g.:

```
https://github.com/spring-projects/spring-petclinic
```

> **Note:** Architecture, overview, dependencies, and entry points work for any public repo (architecture needs an AI key). Spring Boot Java (`@Entity`) also fills entities and endpoints. Security findings stay in the scanner JSON for a later UI.

## Project structure

```
.
├── scanner/          # Python FastAPI — clones, scans, returns JSON
│   ├── main.py       # HTTP server (POST /scan-github, POST /scan-github/stream)
│   ├── scan.py       # AST scanner — entities, relations, endpoints, findings, diagrams
│   ├── overview.py   # High-level summary — modules, deps, entry points, health
│   ├── sequence.py   # Per-route sequence / transaction / trigger diagrams
│   └── requirements.txt
│
├── apps/web/         # Next.js 15 frontend
│   ├── app/          # Routes (page, scan-github API proxy, repo-meta)
│   ├── components/   # Dashboard.tsx (all 7 views), MermaidDiagram.tsx
│   └── lib/          # types.ts, flow.ts (parse embedded Mermaid metadata), readScans.ts
│
├── scans/            # Scan results written here by the scanner; read on startup
└── contract.md       # JSON schema contract between scanner and frontend
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SCANNER_URL` | `http://localhost:8000` | URL of the running scanner process |
| `GITHUB_TOKEN` | *(none)* | Optional GitHub PAT for the web app. Sent as `Authorization: Bearer` on repo-meta requests. Without it, GitHub caps those calls at 60/hour per IP. |
| `REPOMAP_MAX_JAVA_FILES` | `2500` | Scanner cap. Repos above it are scanned module by module instead of being returned unscored. Set this on the scanner process. |
| `REPOMAP_AI_API_KEY` | *(none)* | Scanner key for architecture. With a Groq key (`gsk_…`), every map goes through Groq. Without a key, the static file-tree chart is kept. |
| `REPOMAP_AI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible chat endpoint. Use `https://api.groq.com/openai/v1` for Groq. |
| `REPOMAP_AI_MODEL` | `gpt-4o-mini` | Model name sent with the diagram request. On Groq, with no model set, the scanner uses `openai/gpt-oss-120b`. |

Set `SCANNER_URL` and `GITHUB_TOKEN` in `apps/web/.env.local`. For the architecture diagram, paste a Groq key into `scanner/.env` (`REPOMAP_AI_API_KEY`). The scanner reads that file on the next map. `REPOMAP_MAX_JAVA_FILES` can go in the same file.

## Scan persistence

Every successful scan is written to `scans/<repo>.json` by the scanner. The Next.js app reads all files in `scans/` on startup (`lib/readScans.ts`), so previously scanned repos are available immediately after a restart without re-scanning. The sidebar can scan a repo again or remove it, which deletes that file.
