# RepoMap

Paste a public Spring Boot Java repository URL and get seven views of how it is built: Overview, Architecture, Data flow, Dependencies, Entry points, Critical paths, and Health.

## How it works

```
GitHub URL  →  Python scanner (FastAPI)  →  JSON  →  Next.js dashboard
```

1. The **scanner** (`scanner/`) shallow-clones the repo, walks every `.java` file with `javalang`, and returns a single deterministic JSON describing entities, relations, endpoints, findings, diagrams, and an overview.
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

> **Note:** Only Spring Boot Java repos are supported. Other languages return an unscored result.

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
| `GITHUB_TOKEN` | *(none)* | Optional GitHub PAT — raises the repo-meta API rate limit from 60 to 5 000 req/hr |

Set these in `apps/web/.env.local`.

## Scan persistence

Every successful scan is written to `scans/<repo>.json` by the scanner. The Next.js app reads all files in `scans/` on startup (`lib/readScans.ts`), so previously scanned repos are available immediately after a restart without re-scanning.
