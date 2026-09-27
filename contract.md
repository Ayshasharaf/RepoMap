RepoMap: POST a public GitHub URL, shallow-clone, scan any repo, return one JSON. Same file tree always yields the same JSON bytes, except the architecture chart when an AI key is set.

Key order: service, commit, summary, entities, relations, endpoints, findings, counts, diagrams.
counts: scopeGaps, nPlusOne, brokenRelations, score, risk.
finding: kind, file, symbol, detail. kind is scope_gap, n_plus_one, broken_relation, parse_error, or incomplete. parse_error and incomplete do not change score or risk.
entity: name, tenantOwned. relation: from, to, kind, broken, reason. endpoint: method, path, entity, scopeGap.
diagrams: architecture, erd, connections, dataFlow, criticalPaths. All Mermaid strings.

Rules (Java / Spring Boot): tenant-owned means a field named tenantId. Scope gap: a repository method on a tenant-owned entity returns it with no tenantId parameter, or a controller calls that method and has no @PreAuthorize. N+1: a for/while contains a call whose name starts with find or get, or a collection is FetchType.EAGER. Broken relation: mappedBy or @JoinColumn names a missing field on the target. score = scopeGaps*5 + nPlusOne*2 + brokenRelations*2. High if scopeGaps>=3, else Medium if score>=4, else Low. Link types by simple class name.

Sort every list by name, then file, then symbol. json.dumps(sort_keys=True, indent=2) and a trailing newline. No timestamps, uuids, or absolute paths. commit is the git SHA, or "local".

GitHub: public https://github.com/owner/repo only. Strip .git and /tree or /blob. Shallow clone, 45s, delete the temp dir. No Java, or no @Entity: risk Unscored, zero counts, one finding with the reason. Java file cap defaults to 2500 (REPOMAP_MAX_JAVA_FILES). Above the cap, whole Maven or Gradle modules are included in path order until the cap is reached. A module that does not fit is an incomplete finding, not an Unscored repo. If every module is over the cap, the smallest module is scanned up to the cap. A Java file that fails to parse is a parse_error finding. The clone is fetched only from github.com. When REPOMAP_AI_API_KEY, GROQ_API_KEY, or OPENAI_API_KEY is set, the scanner sends a component index of the repo plus a short README to REPOMAP_AI_BASE_URL and replaces the architecture drawing with that layered graph. Paths the model invents are dropped. Java %% flow, %% path, and %% diagram comments stay. Without a key, the architecture string stays the deterministic diagram.

Multi-language support (apply_structure — runs for all repos after overview):
  Endpoints: Spring @*Mapping, Express/Fastify/Hono app.METHOD, Flask/FastAPI @router.METHOD, Go Gin/Echo/Chi r.METHOD, Rails get/post routes, Laravel Route::METHOD, Django urls.py path(), Axum/Actix .route(), Next.js App Router export function METHOD.
  ERD (diagrams.erd): SQLAlchemy declarative Base/Model, TypeORM @Entity, Prisma schema.prisma model blocks, GORM structs with `gorm:` tags, Ruby ActiveRecord has_many/belongs_to, PHP Eloquent hasMany/belongsTo. FK relationships are extracted and rendered as erDiagram edges.
  Data flow (diagrams.dataFlow): BFS import-chain trace from endpoint owner files → their imports → DB. Rendered as flowchart LR.
  Critical paths (diagrams.criticalPaths): Routes whose import chain reaches a file containing DB or external-HTTP tokens. Rendered as flowchart TD with %% path comments.
  Dependencies: npm package.json (deps + devDeps + peerDeps), go.mod, requirements.txt / requirements-dev.txt, pyproject.toml, Cargo.toml, Gemfile, composer.json.
  Internal module graph: cross-module import edges computed from actual import statements for .py, .java, .ts/.tsx/.js/.jsx, .go, .rb, .rs.
  Health: test file count across all languages, CI files (.github/workflows, .gitlab-ci.yml, Jenkinsfile, azure-pipelines.yml, Bitbucket), coverage config (JaCoCo, .coveragerc, pytest.ini, codecov.yml, pyproject.toml [tool.coverage]).
  Entry points: npm scripts, uvicorn/flask/Django/Python, go run, cargo run, Rails server, PHP artisan serve. README shell-code-fence commands also extracted.
  Stack detection: Spring Boot, FastAPI, Flask, Django, Express, Next.js, NestJS, Gin, Echo, Fiber, Actix, Axum, Rails, Sinatra, Laravel, Symfony, Hono, Fastify, plus capability labels (HTTP API, Database, Auth, Queue, Cache, External API).

AI key behavior (REPOMAP_AI_API_KEY / GROQ_API_KEY / OPENAI_API_KEY):
  When set, every architecture chart goes through that model (Groq by default for gsk_ keys).
  The static file-tree drawing is skipped. Groq also overwrites dataFlow and criticalPaths, and replaces erd when it returns models.
  Rate-limit (429) responses are retried with backoff. The model is called up to three times if the graph is incomplete.
  Without a key, all diagrams are produced deterministically from the file tree.

Out: sample apps, databases, React Flow, other languages.
