"""Deterministic routes, dependencies, entry points, and the architecture chart.

Works for ANY language. Java findings and Java %% comments are preserved.
This pass fills the fields that previously only existed for Spring Boot:
  - endpoints   (REST routes from any framework)
  - ERD         (entity/model diagram from ORM decorators)
  - data flow   (import-chain trace from entry → handler → DB)
  - critical paths (routes that reach a DB or external service)
  - health      (tests, CI, coverage config)
  - dependencies (internal import graph + external manifest libs)
"""

import json
import re
from pathlib import Path

from overview import _checklist, _env_vars, _module_diagram, _purpose
from scan import _mermaid_id, _mermaid_label

try:
    from diagram_ai import ai_ready as _ai_ready
except Exception:  # pragma: no cover - import cycle guard
    def _ai_ready() -> bool:
        return False

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_SKIP = {
    ".git", "node_modules", "dist", "build", "target", "vendor", "third_party",
    ".venv", "venv", "__pycache__", ".next", "coverage", ".gradle", "out",
}
_SOURCE = {
    ".py", ".js", ".jsx", ".ts", ".tsx",
    ".go", ".java", ".rs", ".rb", ".php",
    ".kt", ".kts", ".ex", ".exs", ".scala",
    ".prisma",  # Prisma schema files
}
_DB_TOKENS = (
    "postgres", "mysql", "sqlite", "mongo", "redis",
    "prisma", "sqlalchemy", "hibernate", "jdbc", "typeorm",
    "drizzle", "pg", "sequelize", "gorm", "ent", "diesel",
    "mongoose", "peewee", "tortoise", "beanie", "bunny",
)
_EXTERNAL_TOKENS = (
    "httpx", "requests", "axios", "fetch", "http.client",
    "urllib", "aiohttp", "got", "superagent", "node-fetch",
)

# Route patterns: each yields (method, path)
_ROUTES: list[tuple[re.Pattern, int, int]] = [
    # Spring: @GetMapping("/path")
    (re.compile(r"@(Get|Post|Put|Patch|Delete)Mapping\(\s*(?:value\s*=\s*)?[\"']([^\"']+)[\"']"), 1, 2),
    # Express/Fastify/Hono: app.get('/path', ...)  router.post(...)
    (re.compile(r"\b(?:app|router|fastify|hono)\.(get|post|put|patch|delete)\(\s*[\"']([^\"']+)[\"']", re.I), 1, 2),
    # Flask/FastAPI decorators: @app.get('/path')  @router.post(...)
    (re.compile(r"@(?:app|router|bp|api)\.(get|post|put|patch|delete)\(\s*[\"']([^\"']+)[\"']"), 1, 2),
    # Go Gin/Echo/Chi/Mux: r.GET("/path", ...)  e.POST(...)  mux.HandleFunc(...)
    (re.compile(r"\.(GET|POST|PUT|PATCH|DELETE)\(\s*\"([^\"]+)\""), 1, 2),
    # Rails routes: get '/path', to: ...  post '/path'
    (re.compile(r"^\s*(get|post|put|patch|delete)\s+[\"']([^\"']+)[\"']", re.M), 1, 2),
    # Laravel: Route::get('/path', ...)
    (re.compile(r"Route::(get|post|put|patch|delete)\(\s*[\"']([^\"']+)[\"']", re.I), 1, 2),
    # Django urls.py: path('/path', view)  re_path(...)
    (re.compile(r"(?:re_)?path\(\s*r?[\"']([^\"']+)[\"']\s*,\s*(\w+)"), None, None),  # special — see below
    # Axum / actix: .route("/path", get(handler))
    (re.compile(r"\.route\(\s*\"([^\"]+)\"\s*,\s*(get|post|put|patch|delete)\(", re.I), 2, 1),
]
_DJANGO_PATH = re.compile(r"(?:re_)?path\(\s*r?[\"']([^\"']+)[\"']\s*,\s*(\w+)")
_NEXT_EXPORT = re.compile(r"export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b")


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def apply_structure(root: str, data: dict) -> None:
    """Fill every output field for non-Java (or partially-Java) repos.

    Safe to call on Java repos too — it only sets fields that are empty.
    """
    base = Path(root)
    files = _source_files(base)
    file_set = set(files)

    # ---- endpoints ---------------------------------------------------------
    if not data.get("endpoints"):
        data["endpoints"] = _endpoints(base, files)

    # ---- import graph (for all further analysis) ---------------------------
    imports: dict[str, list[str]] = {rel: _local_imports(base, rel, file_set) for rel in files}

    # ---- external deps -----------------------------------------------------
    overview = data.setdefault("overview", {})
    deps = overview.setdefault("dependencies", {"internal": [], "external": []})
    extra_ext = _external(base)
    deps["external"] = _merge_named(list(deps.get("external") or []), extra_ext)

    # ---- internal module graph ---------------------------------------------
    if not overview.get("modules"):
        modules, _ = _modules(files)
        edges = _module_edges(imports)
        overview["modules"] = modules
        deps["internal"] = edges
        overview["moduleDiagram"] = _module_diagram(modules, edges)

    # ---- entry points & checklist -----------------------------------------
    extra_entries = _entries(base, deps["external"])
    overview["entryPoints"] = _merge_entries(
        list(overview.get("entryPoints") or []), extra_entries
    )
    overview["checklist"] = _checklist(overview["entryPoints"], _env_vars(base))

    # ---- health ------------------------------------------------------------
    tests = _test_count(base)
    health = overview.setdefault("health", {})
    if tests > int(health.get("testFiles") or 0):
        health["testFiles"] = tests
    if not health.get("workflows"):
        health["workflows"] = _ci_files(base)
    if not health.get("coverage"):
        health["coverage"] = _coverage_config(base)

    # ---- identity ----------------------------------------------------------
    identity = overview.setdefault("identity", {})
    if not identity.get("language"):
        identity["language"] = _language(files)
    if not identity.get("stack"):
        identity["stack"] = _stack_from_external(deps["external"])
    if not identity.get("why"):
        identity["why"] = _why(base)
    if not identity.get("license"):
        identity["license"] = _license(base)

    # ---- ERD (entity-relationship diagram) from ORM models -----------------
    diagrams = data.setdefault("diagrams", {})
    if not diagrams.get("erd"):
        models = _extract_models(base, files)
        if models:
            diagrams["erd"] = _erd_diagram(models)
            # expose model names as lightweight entities for the frontend
            if not data.get("entities"):
                data["entities"] = [{"name": m["name"], "tenantOwned": False} for m in models]
            # build relations from FK/relationship fields
            if not data.get("relations"):
                data["relations"] = _model_relations(models)

    # ---- data flow diagram (static import trace) ---------------------------
    if not diagrams.get("dataFlow"):
        diagrams["dataFlow"] = _data_flow_diagram(base, data, files, imports)

    # ---- critical paths ----------------------------------------------------
    if not diagrams.get("criticalPaths"):
        diagrams["criticalPaths"] = _critical_paths_diagram(base, data, files, imports)

    # ---- architecture diagram ----------------------------------------------
    # When Groq is configured, leave the visual for apply_architecture.
    # Still attach %% path comments so Data flow / Critical paths have routes
    # if the model call fails.
    if _ai_ready():
        _install_path_comments(base, data, files, imports)
    else:
        _install_diagram(base, data, files, imports)


# ---------------------------------------------------------------------------
# Source file collection
# ---------------------------------------------------------------------------

def _source_files(root: Path) -> list[str]:
    found = []
    for dirpath, dirnames, filenames in _os_walk(root):
        rel_dir = _rel_dir(dirpath, root)
        if _excluded_dir(rel_dir):
            dirnames.clear()
            continue
        for name in filenames:
            if name.startswith("."):
                continue
            rel = f"{rel_dir}/{name}" if rel_dir else name
            if Path(name).suffix.lower() not in _SOURCE:
                continue
            if _excluded_file(rel):
                continue
            found.append(rel)
    return sorted(found)


def _os_walk(root: Path):
    import os
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(
            name for name in dirnames
            if name not in _SKIP and not name.startswith(".")
        )
        yield Path(dirpath), dirnames, sorted(filenames)


def _rel_dir(path: Path, root: Path) -> str:
    rel = path.relative_to(root).as_posix()
    return "" if rel == "." else rel


def _excluded_dir(rel: str) -> bool:
    parts = rel.split("/")
    return any(
        part in {"test", "tests", "__tests__", "testdata", "fixtures"}
        or part.endswith(".test")
        for part in parts[:-1]
    )


def _excluded_file(rel: str) -> bool:
    name = Path(rel).name
    return (
        ".test." in name or ".spec." in name
        or name.startswith("test_") or name.endswith("_test.py")
        or name.endswith("Test.java") or name.endswith("_test.go")
    )


def _read(root: Path, rel: str, limit: int = 200_000) -> str:
    path = root / rel
    try:
        if path.stat().st_size > limit:
            return ""
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


# ---------------------------------------------------------------------------
# Endpoint extraction (multi-framework)
# ---------------------------------------------------------------------------

def _endpoints(root: Path, files: list[str]) -> list[dict]:
    found: dict[tuple[str, str], dict] = {}

    def add(method: str, path: str) -> None:
        method = method.upper()
        path = ("/" + path.lstrip("/")).rstrip()
        found.setdefault(
            (path, method),
            {"method": method, "path": path, "entity": None, "scopeGap": False},
        )

    for rel in files:
        text = _read(root, rel)
        if not text:
            continue

        # Generic route patterns
        for pattern, mi, pi in _ROUTES:
            if mi is None:
                continue  # handled separately
            for match in pattern.finditer(text):
                add(match.group(mi), match.group(pi))

        # Django urls.py special: method unknown, path is first group
        if "urls.py" in rel or "url.py" in rel:
            for match in _DJANGO_PATH.finditer(text):
                raw = match.group(1).lstrip("^").rstrip("$")
                add("GET", raw)  # Django patterns have no method at this point; default GET

        # Next.js App Router: route.ts / route.js exports
        if rel.endswith(("/route.ts", "/route.js", "/route.tsx")):
            for method in _NEXT_EXPORT.findall(text):
                parts = [
                    p for p in rel.split("/")[:-1]
                    if p not in {"app", "src", "pages", "api"} and not p.startswith("(")
                ]
                route_path = "/" + "/".join(parts) if parts else "/"
                add(method, route_path)

        # FastAPI path params: @router.get("/items/{item_id}")
        for match in re.finditer(
            r"@(?:app|router|api_router|bp)\.(get|post|put|patch|delete)\(\s*[\"']([^\"']+)[\"']",
            text,
        ):
            add(match.group(1), match.group(2))

    rows = list(found.values())
    rows.sort(key=lambda item: (item["path"], item["method"]))
    return rows[:120]


# ---------------------------------------------------------------------------
# ORM model / entity extraction (ERD source)
# ---------------------------------------------------------------------------

# Maps a model's field to its FK target
_FK_PY = re.compile(
    r"""(\w+)\s*[=:]\s*(?:db\.)?(?:Column\(.*?ForeignKey\([\"'](\w+)\.?\w*[\"']\)|relationship\([\"'](\w+)[\"'])|Field\(.*?foreign_key=[\"']([^\"']+)[\"']|Relationship\([\"'](\w+)[\"']""",
    re.I,
)
_FK_TS = re.compile(
    r"""@(?:ManyToOne|OneToMany|OneToOne|ManyToMany|Relation)\(\s*[^)]*?(?:type\s*=>\s*\(\)\s*=>\s*(\w+)|[\"'](\w+)[\"'])""",
    re.I,
)
_FK_GO = re.compile(r"""(\w+ID|(\w+)Id)\s+\w+""")

# Python SQLAlchemy declarative
_PY_MODEL = re.compile(
    r"class\s+(\w+)\s*\([^)]*(?:Base|Model|Document|BaseModel|db\.Model)[^)]*\)\s*:"
)
_PY_FIELD = re.compile(r"^\s{4}(\w+)\s*[=:]\s*(.+)$", re.M)

# TypeScript TypeORM / Prisma / Mongoose
_TS_ENTITY = re.compile(r"@Entity\(\s*(?:[\"'][^\"']*[\"'])?\s*\)\s*export\s+class\s+(\w+)")
_TS_PRISMA_MODEL = re.compile(r"^model\s+(\w+)\s*\{", re.M)
_TS_MONGOOSE = re.compile(r"const\s+(\w+)Schema\s*=\s*new\s+Schema\(")

# Go GORM struct
_GO_STRUCT = re.compile(r"type\s+(\w+)\s+struct\s*\{([^}]*)\}", re.S)
_GO_GORM = re.compile(r"`gorm:")

# Ruby ActiveRecord / Elixir Ecto
_RUBY_MODEL = re.compile(r"class\s+(\w+)\s*<\s*(?:ApplicationRecord|ActiveRecord::Base)")
_RUBY_ASSOC = re.compile(r"(has_many|belongs_to|has_one|has_and_belongs_to_many)\s+:(\w+)")

# PHP Eloquent
_PHP_MODEL = re.compile(r"class\s+(\w+)\s+extends\s+(?:Model|Eloquent)")
_PHP_FUNC = re.compile(r"public\s+function\s+(\w+)\s*\(\s*\)\s*\{[^}]*->(?:hasMany|belongsTo|hasOne|belongsToMany)\(([^)]+)\)")


def _extract_models(root: Path, files: list[str]) -> list[dict]:
    """Return list of {name, fields: [{name, type, fk_target}], file}."""
    models = []
    seen = set()

    for rel in files:
        text = _read(root, rel, 100_000)
        if not text:
            continue
        suffix = Path(rel).suffix.lower()

        if suffix == ".py":
            models.extend(_py_models(text, rel, seen))
        elif suffix in {".ts", ".tsx"}:
            models.extend(_ts_models(text, rel, seen))
        elif rel.endswith(".prisma") or rel.endswith("schema.prisma"):
            models.extend(_prisma_models(text, rel, seen))
        elif suffix == ".go":
            models.extend(_go_models(text, rel, seen))
        elif suffix == ".rb":
            models.extend(_ruby_models(text, rel, seen))
        elif suffix == ".php":
            models.extend(_php_models(text, rel, seen))

    return models[:40]  # cap for diagram readability


def _py_models(text: str, rel: str, seen: set) -> list[dict]:
    out = []
    for m in _PY_MODEL.finditer(text):
        name = m.group(1)
        if name in seen:
            continue
        seen.add(name)
        # Collect fields after the class definition — stop at the next class
        class_start = m.end()
        raw_block = text[class_start : class_start + 2000]
        # Trim at next top-level class definition
        next_class = re.search(r"\nclass\s+\w+", raw_block)
        block = raw_block[: next_class.start()] if next_class else raw_block
        fields = []
        for fm in re.finditer(
            r"^\s{4}(\w+)\s*(?:=|:)\s*(.+?)(?:\n|$)", block, re.M
        ):
            fname = fm.group(1)
            fval = fm.group(2).strip()
            if fname.startswith("_") or fname in {"Meta", "class"}:
                continue
            fk = None
            fk_m = re.search(r"ForeignKey\([\"'](\w+)", fval)
            if fk_m:
                fk = fk_m.group(1).capitalize()
            rel_m = re.search(r"relationship\([\"'](\w+)[\"']", fval, re.I)
            if rel_m:
                fk = rel_m.group(1)
            fields.append({"name": fname, "type": _py_field_type(fval), "fk": fk})
        out.append({"name": name, "fields": fields[:20], "file": rel})
    return out


def _py_field_type(expr: str) -> str:
    if "Integer" in expr or "int" in expr.lower():
        return "int"
    if "String" in expr or "str" in expr.lower() or "Text" in expr or "VARCHAR" in expr:
        return "str"
    if "Boolean" in expr or "bool" in expr.lower():
        return "bool"
    if "DateTime" in expr or "Date" in expr:
        return "datetime"
    if "Float" in expr or "Numeric" in expr:
        return "float"
    if "ForeignKey" in expr:
        return "FK"
    if "relationship" in expr.lower() or "Relationship" in expr:
        return "rel"
    return "?"


def _ts_models(text: str, rel: str, seen: set) -> list[dict]:
    out = []
    for m in _TS_ENTITY.finditer(text):
        name = m.group(1)
        if name in seen:
            continue
        seen.add(name)
        # scan class body for @Column / @ManyToOne / etc.
        start = m.end()
        block = text[start: start + 3000]
        fields = []
        for fm in re.finditer(
            r"@(?:Column|PrimaryGeneratedColumn|PrimaryColumn|ManyToOne|OneToMany|OneToOne|ManyToMany|Relation)\s*\([^)]*\)\s*\w*\s*(\w+)\s*[!?]?\s*:\s*([\w<>\[\]|]+)",
            block,
        ):
            fname = fm.group(1)
            ftype = fm.group(2)
            fk = None
            fk_m = re.search(
                r"@(?:ManyToOne|OneToMany|OneToOne|ManyToMany)\([^)]*type\s*=>\s*\(\)\s*=>\s*(\w+)",
                block,
            )
            if fk_m:
                fk = fk_m.group(1)
            fields.append({"name": fname, "type": ftype, "fk": fk})
        out.append({"name": name, "fields": fields[:20], "file": rel})
    return out


def _prisma_models(text: str, rel: str, seen: set) -> list[dict]:
    out = []
    for m in _TS_PRISMA_MODEL.finditer(text):
        name = m.group(1)
        if name in seen:
            continue
        seen.add(name)
        start = m.end()
        block = text[start: start + 1500]
        end = block.find("}")
        if end > 0:
            block = block[:end]
        fields = []
        for line in block.splitlines():
            line = line.strip()
            if not line or line.startswith("@@") or line.startswith("//"):
                continue
            parts = line.split()
            if len(parts) < 2:
                continue
            fname = parts[0]
            ftype = parts[1].rstrip("?")
            # Prisma FK is a relation field whose type is another model name (capitalized)
            fk = ftype if ftype[0].isupper() else None
            fields.append({"name": fname, "type": ftype, "fk": fk})
        out.append({"name": name, "fields": fields[:20], "file": rel})
    return out


def _go_models(text: str, rel: str, seen: set) -> list[dict]:
    out = []
    for m in _GO_STRUCT.finditer(text):
        if not _GO_GORM.search(m.group(2)):
            continue  # only GORM structs
        name = m.group(1)
        if name in seen:
            continue
        seen.add(name)
        fields = []
        for line in m.group(2).splitlines():
            line = line.strip()
            if not line or line.startswith("//"):
                continue
            parts = line.split()
            if len(parts) < 2:
                continue
            fname = parts[0]
            ftype = parts[1]
            fk = ftype if (fname.endswith("ID") or fname.endswith("Id")) else None
            fields.append({"name": fname, "type": ftype, "fk": fk})
        out.append({"name": name, "fields": fields[:20], "file": rel})
    return out


def _ruby_models(text: str, rel: str, seen: set) -> list[dict]:
    out = []
    for m in _RUBY_MODEL.finditer(text):
        name = m.group(1)
        if name in seen:
            continue
        seen.add(name)
        fields = []
        for am in _RUBY_ASSOC.finditer(text):
            assoc = am.group(1)
            target = am.group(2)
            model = "".join(w.capitalize() for w in target.rstrip("s").split("_"))
            fk = model if assoc in ("belongs_to", "has_one") else None
            fields.append({"name": target, "type": assoc, "fk": fk})
        out.append({"name": name, "fields": fields[:20], "file": rel})
    return out


def _php_models(text: str, rel: str, seen: set) -> list[dict]:
    out = []
    for m in _PHP_MODEL.finditer(text):
        name = m.group(1)
        if name in seen:
            continue
        seen.add(name)
        fields = []
        for fm in _PHP_FUNC.finditer(text):
            fname = fm.group(1)
            target_raw = fm.group(2).strip().strip("'\"").split(",")[0].strip().strip("'\"")
            target = target_raw.split("\\")[-1].rstrip("::class")
            fields.append({"name": fname, "type": "relation", "fk": target or None})
        out.append({"name": name, "fields": fields[:20], "file": rel})
    return out


# ---------------------------------------------------------------------------
# ERD diagram builder
# ---------------------------------------------------------------------------

def _erd_diagram(models: list[dict]) -> str:
    if not models:
        return ""
    lines = ["erDiagram"]
    names = {m["name"] for m in models}
    edges_seen: set[tuple[str, str]] = set()

    for model in models:
        entity_lines = [f"  {model['name']} {{"]
        for f in model.get("fields") or []:
            if f["type"] in ("rel", "relation"):
                continue
            safe_type = re.sub(r"[^A-Za-z0-9_]", "_", str(f["type"] or "?"))
            safe_name = re.sub(r"[^A-Za-z0-9_]", "_", str(f["name"] or "field"))
            entity_lines.append(f"    {safe_type} {safe_name}")
        entity_lines.append("  }")
        lines.extend(entity_lines)

    for model in models:
        for f in model.get("fields") or []:
            target = f.get("fk")
            if not target or target not in names:
                continue
            pair = (model["name"], target)
            rev = (target, model["name"])
            if pair in edges_seen or rev in edges_seen:
                continue
            edges_seen.add(pair)
            rel_type = f.get("type", "")
            if "many" in str(rel_type).lower() or rel_type in ("has_many",):
                cardinality = "||--o{"
            else:
                cardinality = "}o--||"
            lines.append(f'  {model["name"]} {cardinality} {target} : "ref"')

    return "\n".join(lines)


def _model_relations(models: list[dict]) -> list[dict]:
    names = {m["name"] for m in models}
    out = []
    seen: set[tuple[str, str]] = set()
    for model in models:
        for f in model.get("fields") or []:
            target = f.get("fk")
            if not target or target not in names:
                continue
            pair = (model["name"], target)
            if pair in seen:
                continue
            seen.add(pair)
            out.append({
                "from": model["name"],
                "to": target,
                "kind": f.get("type") or "ref",
                "broken": False,
                "reason": "",
            })
    return out


# ---------------------------------------------------------------------------
# Local import resolution
# ---------------------------------------------------------------------------

def _local_imports(root: Path, rel: str, files: set[str]) -> list[str]:
    text = _read(root, rel, 80_000)
    found = []
    suffix = Path(rel).suffix.lower()
    folder = str(Path(rel).parent).replace("\\", "/")
    if folder == ".":
        folder = ""

    if suffix == ".py":
        for match in re.finditer(r"^(?:from|import)\s+([A-Za-z0-9_.]+)", text, re.M):
            parts = match.group(1).split(".")
            candidates = [
                "/".join(parts) + ".py",
                "/".join(parts) + "/__init__.py",
                "/".join(parts[:-1]) + ".py" if len(parts) > 1 else "",
            ]
            for candidate in candidates:
                if candidate and candidate in files:
                    found.append(candidate)
                    break

    elif suffix == ".java":
        for match in re.finditer(r"^import\s+(?:static\s+)?([A-Za-z0-9_.]+);", text, re.M):
            simple = match.group(1).split(".")[-1]
            for candidate in files:
                if Path(candidate).stem == simple:
                    found.append(candidate)
                    break

    elif suffix in {".js", ".jsx", ".ts", ".tsx"}:
        for match in re.finditer(r"""['"](\.[^'"]+)['"]""", text):
            raw = match.group(1)
            base_path = str((Path(folder) / raw).as_posix()) if folder else raw.lstrip("./")
            base_path = str(Path(base_path))
            for ext in ("", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.js"):
                candidate = (base_path + ext).replace("\\", "/")
                if candidate in files:
                    found.append(candidate)
                    break

    elif suffix == ".go":
        pkg = str(Path(rel).parent).replace("\\", "/")
        for candidate in files:
            if candidate != rel and str(Path(candidate).parent).replace("\\", "/") == pkg:
                found.append(candidate)

    elif suffix == ".rb":
        for match in re.finditer(r"require(?:_relative)?\s+[\"']([^\"']+)[\"']", text):
            raw = match.group(1)
            for ext in (".rb", ""):
                candidate = (raw + ext).replace("\\", "/")
                if candidate in files or ("/" + candidate) in " ".join(files):
                    found.append(candidate)
                    break

    elif suffix == ".rs":
        for match in re.finditer(r"^(?:mod|use)\s+([A-Za-z0-9_:]+)", text, re.M):
            simple = match.group(1).split("::")[-1]
            for candidate in files:
                if Path(candidate).stem == simple:
                    found.append(candidate)
                    break

    return sorted(set(found))


# ---------------------------------------------------------------------------
# Data flow diagram
# ---------------------------------------------------------------------------

def _data_flow_diagram(
    root: Path,
    data: dict,
    files: list[str],
    imports: dict[str, list[str]],
) -> str:
    """Trace request → handler → service → DB for each endpoint owner."""
    endpoints = data.get("endpoints") or []
    external = ((data.get("overview") or {}).get("dependencies") or {}).get("external") or []

    db_name = next(
        (item["name"] for item in external if item.get("usedFor") == "Database"
         or any(t in item["name"].lower() for t in _DB_TOKENS)),
        "",
    )

    entry_files: list[str] = []
    for ep in endpoints[:8]:
        owner = _route_owner(root, ep, files)
        if owner and owner not in entry_files:
            entry_files.append(owner)

    if not entry_files and files:
        main = next(
            (rel for rel in files if Path(rel).name in {
                "main.py", "main.go", "index.ts", "index.js",
                "main.ts", "main.js", "app.py", "manage.py",
            }),
            files[0],
        )
        entry_files = [main]

    # BFS per entry file
    chains: list[tuple[str, list[str]]] = []
    for entry in entry_files[:6]:
        chain = _bfs_chain(entry, imports, max_depth=4)
        chains.append((entry, chain))

    if not chains:
        return ""

    lines = [
        "flowchart LR",
        "  classDef toneBlue fill:#dbeafe,stroke:#2563eb,stroke-width:1.5px,color:#172554",
        "  classDef toneAmber fill:#fef3c7,stroke:#d97706,stroke-width:1.5px,color:#78350f",
        "  classDef toneMint fill:#dcfce7,stroke:#16a34a,stroke-width:1.5px,color:#14532d",
        '  df_caller(("Client"))',
    ]

    all_ids: list[str] = []
    path_ids: dict[str, str] = {}

    def box(path: str) -> str:
        existing = path_ids.get(path)
        if existing:
            return existing
        base = "df_" + _mermaid_id(Path(path).stem)
        nid = base
        suffix = 2
        while nid in path_ids.values():
            nid = f"{base}_{suffix}"
            suffix += 1
        path_ids[path] = nid
        label = _mermaid_label(Path(path).stem).replace("|", "/")
        lines.append(f'  {nid}["{label}"]')
        all_ids.append(nid)
        return nid

    db_id = ""
    if db_name:
        db_id = "df_db_" + _mermaid_id(db_name)
        lines.append(f'  {db_id}[("{_mermaid_label(db_name)}")]')
        all_ids.append(db_id)

    for entry, chain in chains:
        prev = "df_caller"
        for hop in [entry, *chain]:
            nid = box(hop)
            lines.append(f"  {prev} --> {nid}")
            prev = nid
        if db_id:
            lines.append(f"  {prev} --> {db_id}")

    if all_ids:
        lines.append("  class df_caller toneBlue")
        lines.append("  class " + ",".join(dict.fromkeys(all_ids[:6])) + " toneAmber")

    return "\n".join(lines)


def _bfs_chain(start: str, imports: dict[str, list[str]], max_depth: int = 4) -> list[str]:
    visited = {start}
    queue = [(start, 0)]
    chain = []
    while queue:
        current, depth = queue.pop(0)
        if depth >= max_depth:
            continue
        for target in imports.get(current, []):
            if target not in visited:
                visited.add(target)
                chain.append(target)
                queue.append((target, depth + 1))
    return chain[:6]


# ---------------------------------------------------------------------------
# Critical paths diagram
# ---------------------------------------------------------------------------

def _critical_paths_diagram(
    root: Path,
    data: dict,
    files: list[str],
    imports: dict[str, list[str]],
) -> str:
    """Identify which routes reach a DB/external service and draw those paths."""
    endpoints = data.get("endpoints") or []
    external = ((data.get("overview") or {}).get("dependencies") or {}).get("external") or []
    db_libs = {item["name"] for item in external if item.get("usedFor") in ("Database", "Cache")}
    ext_libs = {item["name"] for item in external if item.get("usedFor") in ("External API", "HTTP client")}

    # Find files that directly use DB
    db_files: set[str] = set()
    ext_files: set[str] = set()
    for rel in files:
        text = _read(root, rel, 60_000)
        if any(tok in text.lower() for tok in _DB_TOKENS) or any(lib in text for lib in db_libs):
            db_files.add(rel)
        if any(tok in text.lower() for tok in _EXTERNAL_TOKENS) or any(lib in text for lib in ext_libs):
            ext_files.add(rel)

    critical: list[tuple[str, str, list[str], str]] = []  # (method, path, chain, dest_type)
    for ep in endpoints[:12]:
        owner = _route_owner(root, ep, files)
        if not owner:
            continue
        chain = [owner] + _bfs_chain(owner, imports, max_depth=5)
        dest = ""
        for hop in chain:
            if hop in db_files:
                dest = "DB"
                break
            if hop in ext_files:
                dest = "External"
                break
        if dest:
            critical.append((ep["method"], ep["path"], chain, dest))

    if not critical:
        return ""

    lines = [
        "flowchart TD",
        "  classDef toneBlue fill:#dbeafe,stroke:#2563eb,stroke-width:1.5px,color:#172554",
        "  classDef toneAmber fill:#fef3c7,stroke:#d97706,stroke-width:1.5px,color:#78350f",
        "  classDef toneMint fill:#dcfce7,stroke:#16a34a,stroke-width:1.5px,color:#14532d",
        "  classDef tonePink fill:#fce7f3,stroke:#db2777,stroke-width:1.5px,color:#831843",
    ]
    seen_nodes: set[str] = set()
    path_comments = []

    for method, ep_path, chain, dest in critical[:8]:
        prev = None
        cell_labels = []
        for hop in chain[:4]:
            nid = "cp_" + _mermaid_id(Path(hop).stem)
            label = _mermaid_label(Path(hop).stem).replace("|", "/")
            cell_labels.append(f"Code|{Path(hop).stem}")
            if nid not in seen_nodes:
                seen_nodes.add(nid)
                lines.append(f'  {nid}["{label}"]')
            if prev:
                lines.append(f"  {prev} --> {nid}")
            prev = nid
        if prev:
            dest_id = "cp_db" if dest == "DB" else "cp_ext"
            dest_label = "Database" if dest == "DB" else "External Service"
            if dest_id not in seen_nodes:
                seen_nodes.add(dest_id)
                shape = f'("{dest_label}")' if dest == "DB" else f'["{dest_label}"]'
                lines.append(f"  {dest_id}{shape}")
            lines.append(f"  {prev} --> {dest_id}")
            # write %% path comment
            entry_label = f"{method} {ep_path}"
            cells = [f"Entry|{Path(chain[0]).stem}"] + cell_labels[1:]
            path_comments.append(
                "%% path\trequest\t" + entry_label + "\t" + "\t".join(cells)
            )

    if seen_nodes:
        lines.append("  class " + ",".join(list(seen_nodes)[:8]) + " toneAmber")
        if "cp_db" in seen_nodes:
            lines.append("  class cp_db toneMint")
        if "cp_ext" in seen_nodes:
            lines.append("  class cp_ext tonePink")

    lines.extend(path_comments)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Architecture diagram (deterministic fallback for non-Java)
# ---------------------------------------------------------------------------

def _install_path_comments(
    root: Path,
    data: dict,
    files: list[str],
    imports: dict[str, list[str]],
) -> None:
    """Keep route metadata without drawing the static file-tree chart."""
    diagrams = data.setdefault("diagrams", {})
    previous = diagrams.get("architecture") or ""
    comments = [
        line for line in previous.splitlines()
        if line.startswith(("%% flow\t", "%% path\t", "%% diagram\t"))
    ]
    if not any(line.startswith("%% path\t") for line in comments):
        comments.extend(_path_comments(root, data.get("endpoints") or [], files, imports))
    if comments:
        # Placeholder visual until Groq replaces it; comments stay for the UI.
        diagrams["architecture"] = "flowchart TD\n  pending[\"Architecture pending\"]\n" + "\n".join(comments)


def _install_diagram(
    root: Path,
    data: dict,
    files: list[str],
    imports: dict[str, list[str]],
) -> None:
    diagrams = data.setdefault("diagrams", {})
    previous = diagrams.get("architecture") or ""
    # Keep existing Java %% comments intact
    comments = [
        line for line in previous.splitlines()
        if line.startswith("%%") and not line.startswith("%% href\t")
    ]
    file_set = set(files)
    if not any(line.startswith("%% path\t") for line in comments):
        comments.extend(_path_comments(root, data.get("endpoints") or [], files, imports))

    external = ((data.get("overview") or {}).get("dependencies") or {}).get("external") or []
    entry_files: list[str] = []
    for endpoint in data.get("endpoints") or []:
        owner = _route_owner(root, endpoint, files)
        if owner and owner not in entry_files:
            entry_files.append(owner)

    visual = _diagram(files, imports, external, entry_files)
    diagrams["architecture"] = visual if not comments else visual + "\n" + "\n".join(comments)


def _path_comments(
    root: Path,
    endpoints: list[dict],
    files: list[str],
    imports: dict[str, list[str]],
) -> list[str]:
    lines = []
    seen: set[tuple[str, str]] = set()
    for endpoint in endpoints:
        owner = _route_owner(root, endpoint, files)
        if not owner:
            continue
        hops = [Path(owner).stem]
        for target in imports.get(owner, []):
            stem = Path(target).stem
            if stem not in hops:
                hops.append(stem)
        key = (endpoint["method"], endpoint["path"])
        if key in seen:
            continue
        seen.add(key)
        cells = [f"Entry|{hops[0]}"] + [f"Code|{name}" for name in hops[1:]]
        entry = f"{endpoint['method']} {endpoint['path']}"
        lines.append("%% path\trequest\t" + entry + "\t" + "\t".join(cells))
    if lines or not files:
        return lines
    main = next(
        (rel for rel in files if Path(rel).name in {
            "main.py", "main.go", "index.ts", "index.js", "main.ts", "main.js",
        }),
        files[0],
    )
    hops = [Path(main).stem] + [Path(item).stem for item in imports.get(main, [])]
    unique: list[str] = []
    for name in hops:
        if name not in unique:
            unique.append(name)
    cells = [f"Entry|{unique[0]}"] + [f"Code|{name}" for name in unique[1:]]
    return ["%% path\trequest\t" + Path(main).name + "\t" + "\t".join(cells)]


def _route_owner(root: Path, endpoint: dict, files: list[str]) -> str:
    needle = endpoint["path"].strip("/")
    if not needle:
        return ""
    for rel in files:
        if needle in _read(root, rel, 80_000):
            return rel
    return ""


def _diagram(
    files: list[str],
    imports: dict[str, list[str]],
    external: list[dict],
    entry_files: list[str],
) -> str:
    shown = [
        rel for rel in files
        if ".test." not in rel and ".spec." not in rel
        and not Path(rel).name.startswith("test_")
    ]
    if not shown:
        return 'flowchart TD\n  empty["No source files"]'

    use_files = len(shown) <= 14
    database = next(
        (item["name"] for item in external
         if item.get("usedFor") == "Database"
         or any(token in item["name"].lower() for token in _DB_TOKENS)),
        "",
    )

    if use_files:
        labels = {rel: Path(rel).stem for rel in shown}
        ids: dict[str, str] = {}
        used: set[str] = set()
        for rel in shown:
            base = "node_" + _mermaid_id(labels[rel])
            nid = base
            suffix = 2
            while nid in used:
                nid = f"{base}_{suffix}"
                suffix += 1
            used.add(nid)
            ids[rel] = nid
        group_of = shown
    else:
        modules = sorted({_module_of(rel) for rel in shown})
        ids = {name: "mod_" + _mermaid_id(name) for name in modules}
        labels = {name: name for name in modules}
        group_of = modules

    edges: list[tuple[str, str, str]] = []
    edge_seen: set[tuple[str, str]] = set()

    def link(src: str, dst: str, label: str) -> None:
        if not src or not dst or src == dst or (src, dst) in edge_seen:
            return
        edge_seen.add((src, dst))
        edges.append((src, dst, label))

    if use_files:
        for src, targets in sorted(imports.items()):
            if src not in ids:
                continue
            for target in targets:
                if target in ids:
                    link(ids[src], ids[target], "calls")
        for rel in entry_files:
            if rel in ids:
                link("node_caller", ids[rel], "calls")
        if database and entry_files:
            first = next((rel for rel in entry_files if rel in ids), None)
            if first:
                link(ids[first], "node_database", "persists")
    else:
        for src, targets in sorted(imports.items()):
            for target in targets:
                link(
                    ids.get(_module_of(src), ""),
                    ids.get(_module_of(target), ""),
                    "calls",
                )
        for rel in entry_files:
            link("node_caller", ids.get(_module_of(rel), ""), "calls")
        if database and entry_files:
            link(ids.get(_module_of(entry_files[0]), ""), "node_database", "persists")

    lines = [
        "flowchart TD",
        "  classDef toneBlue fill:#dbeafe,stroke:#2563eb,stroke-width:1.5px,color:#172554",
        "  classDef toneAmber fill:#fef3c7,stroke:#d97706,stroke-width:1.5px,color:#78350f",
        "  classDef toneMint fill:#dcfce7,stroke:#16a34a,stroke-width:1.5px,color:#14532d",
    ]
    if entry_files:
        lines.append('  node_caller(("API client"))')
    lines.append('  subgraph group_app["Application"]')
    for key in group_of:
        lbl = _mermaid_label(labels[key] if use_files else key).replace("|", "/")
        lines.append(f'    {ids[key]}["{lbl}"]')
    lines.append("  end")
    if database:
        lines.append(f'  node_database[("{_mermaid_label(database)}")]')
    for src, dst, lbl in edges:
        safe = _mermaid_label(lbl).replace("|", "/")
        lines.append(f'  {src} -->|"{safe}"| {dst}')

    entry_ids = []
    for rel in entry_files:
        nid = ids.get(rel) if use_files else ids.get(_module_of(rel))
        if nid:
            entry_ids.append(nid)
    blue = (["node_caller"] if entry_files else []) + entry_ids
    amber_keys = [key for key in group_of if ids[key] not in entry_ids]
    if blue:
        lines.append("  class " + ",".join(dict.fromkeys(blue)) + " toneBlue")
    amber = [ids[key] for key in amber_keys]
    if database:
        amber.append("node_database")
    if amber:
        lines.append("  class " + ",".join(amber) + " toneAmber")
    for rel in entry_files:
        nid = ids.get(rel) if use_files else ids.get(_module_of(rel))
        if nid:
            lines.append(f"%% href\t{nid}\t{rel}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# External dependencies (multi-manifest)
# ---------------------------------------------------------------------------

def _external(root: Path) -> list[dict]:
    found: dict[str, str] = {}

    def add(name: str) -> None:
        name = name.strip().split("/")[-1]
        if name and not name.startswith("$") and name not in found and len(found) < 120:
            found[name] = _purpose(name)

    # npm
    package = root / "package.json"
    if package.is_file():
        try:
            data = json.loads(package.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            data = {}
        for section in ("dependencies", "devDependencies", "peerDependencies"):
            for name in (data.get(section) or {}):
                add(name)

    # Go modules
    gomod = root / "go.mod"
    if gomod.is_file():
        for line in gomod.read_text(encoding="utf-8", errors="ignore").splitlines():
            parts = line.split()
            if len(parts) >= 2 and "." in parts[0] and not parts[0].startswith("//"):
                add(parts[0].rstrip("/"))

    # Python
    for name in ("requirements.txt", "requirements-dev.txt", "requirements/base.txt"):
        req = root / name
        if req.is_file():
            for line in req.read_text(encoding="utf-8", errors="ignore").splitlines():
                pkg = re.split(r"[<>=\[;#]", line.strip(), maxsplit=1)[0].strip()
                if pkg and not pkg.startswith("-"):
                    add(pkg)

    pyproject = root / "pyproject.toml"
    if pyproject.is_file():
        text = pyproject.read_text(encoding="utf-8", errors="ignore")
        for m in re.finditer(r"""['"]([A-Za-z0-9_.\-]+)[<>=\[][^'"]*['"]""", text):
            add(m.group(1))

    # Rust
    cargo = root / "Cargo.toml"
    if cargo.is_file():
        in_deps = False
        for line in cargo.read_text(encoding="utf-8", errors="ignore").splitlines():
            stripped = line.strip()
            if stripped.startswith("["):
                in_deps = "dependencies" in stripped
                continue
            if in_deps and "=" in stripped and not stripped.startswith("#"):
                add(stripped.split("=", 1)[0].strip())

    # Ruby
    gemfile = root / "Gemfile"
    if gemfile.is_file():
        for m in re.finditer(r"""gem\s+['"]([^'"]+)['"]""", gemfile.read_text(encoding="utf-8", errors="ignore")):
            add(m.group(1))

    # PHP Composer
    composer = root / "composer.json"
    if composer.is_file():
        try:
            data = json.loads(composer.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            data = {}
        for section in ("require", "require-dev"):
            for name in (data.get(section) or {}):
                if "/" in name:
                    add(name.split("/")[-1])

    return [{"name": name, "usedFor": found[name]} for name in sorted(found)]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _merge_named(current: list[dict], extra: list[dict]) -> list[dict]:
    by_name = {item.get("name"): item for item in current if item.get("name")}
    for item in extra:
        by_name.setdefault(item["name"], item)
    return [by_name[name] for name in sorted(by_name)]


def _entries(root: Path, external: list[dict]) -> list[dict]:
    entries = []
    package = root / "package.json"
    if package.is_file():
        try:
            scripts = json.loads(package.read_text(encoding="utf-8")).get("scripts") or {}
        except json.JSONDecodeError:
            scripts = {}
        if scripts.get("dev"):
            entries.append({"name": "Run locally", "detail": "npm run dev"})
        elif scripts.get("start"):
            entries.append({"name": "Run locally", "detail": "npm start"})
        if scripts.get("test"):
            entries.append({"name": "Tests", "detail": "npm test"})
        if scripts.get("build"):
            entries.append({"name": "Build", "detail": "npm run build"})

    if (root / "pyproject.toml").is_file() or (root / "requirements.txt").is_file():
        names = {item["name"].lower() for item in external}
        if "fastapi" in names or "uvicorn" in names:
            entries.append({"name": "Run locally", "detail": "uvicorn main:app --reload"})
        elif "flask" in names:
            entries.append({"name": "Run locally", "detail": "flask run"})
        elif "django" in names or "djangorestframework" in names:
            entries.append({"name": "Run locally", "detail": "python manage.py runserver"})
        elif (root / "main.py").is_file():
            entries.append({"name": "Run locally", "detail": "python main.py"})
        entries.append({"name": "Tests", "detail": "pytest"})

    gomod = root / "go.mod"
    if gomod.is_file() and gomod.stat().st_size > 10:
        entries.append({"name": "Run locally", "detail": "go run ."})
        entries.append({"name": "Tests", "detail": "go test ./..."})

    if (root / "Cargo.toml").is_file():
        entries.append({"name": "Run locally", "detail": "cargo run"})
        entries.append({"name": "Tests", "detail": "cargo test"})

    if (root / "Gemfile").is_file():
        entries.append({"name": "Run locally", "detail": "bundle exec rails server"})
        entries.append({"name": "Tests", "detail": "bundle exec rspec"})

    if (root / "composer.json").is_file():
        entries.append({"name": "Run locally", "detail": "php artisan serve"})
        entries.append({"name": "Tests", "detail": "vendor/bin/phpunit"})

    for rel in (
        "main.py", "app.py", "manage.py", "main.go",
        "src/main.ts", "src/index.ts", "src/main.js", "src/index.js",
    ):
        if (root / rel).is_file():
            entries.append({"name": "Process", "detail": f"Starts in {rel}"})

    return entries


def _merge_entries(current: list[dict], extra: list[dict]) -> list[dict]:
    seen = {(item.get("name"), item.get("detail")) for item in current}
    for item in extra:
        key = (item["name"], item["detail"])
        if key in seen:
            continue
        if item["name"] == "Run locally" and any(
            e.get("name") == "Run locally" for e in current
        ):
            continue
        seen.add(key)
        current.append(item)
    return current


def _modules(files: list[str]) -> tuple[list[dict], list[dict]]:
    buckets: dict[str, dict] = {}
    for rel in files:
        folder = rel.split("/", 1)[0] if "/" in rel else "root"
        bucket = buckets.setdefault(
            folder,
            {"id": _mermaid_id(folder), "label": folder, "files": 0, "classes": []},
        )
        bucket["files"] += 1
        if len(bucket["classes"]) < 8:
            bucket["classes"].append(Path(rel).stem)
    return [buckets[name] for name in sorted(buckets)], []


def _module_of(rel: str) -> str:
    parts = [part for part in rel.split("/")[:-1] if part]
    for part in reversed(parts):
        if part.lower() in {
            "controller", "controllers", "service", "services",
            "repository", "repositories", "api", "routes", "models",
            "db", "persistence", "handler", "handlers",
        }:
            return part
    return parts[0] if parts else "root"


def _module_edges(imports: dict[str, list[str]]) -> list[dict]:
    seen: set[tuple[str, str]] = set()
    edges = []
    for src, targets in sorted(imports.items()):
        for target in targets:
            pair = (_mermaid_id(_module_of(src)), _mermaid_id(_module_of(target)))
            if pair[0] == pair[1] or pair in seen:
                continue
            seen.add(pair)
            edges.append({"from": pair[0], "to": pair[1]})
    return edges


def _test_count(root: Path) -> int:
    count = 0
    for _dirpath, _dirnames, filenames in _os_walk(root):
        for name in filenames:
            if (
                name.startswith("test_")
                or name.endswith("_test.py")
                or name.endswith("_test.go")
                or ".test." in name
                or ".spec." in name
                or name.endswith("Test.java")
                or name.endswith("Spec.rb")
                or name.endswith("_spec.rb")
            ):
                count += 1
    return count


def _language(files: list[str]) -> str:
    counts: dict[str, int] = {}
    labels = {
        ".py": "Python", ".js": "JavaScript", ".jsx": "JavaScript",
        ".ts": "TypeScript", ".tsx": "TypeScript", ".go": "Go",
        ".java": "Java", ".rs": "Rust", ".rb": "Ruby",
        ".php": "PHP", ".kt": "Kotlin", ".kts": "Kotlin",
        ".ex": "Elixir", ".exs": "Elixir", ".scala": "Scala",
    }
    for rel in files:
        label = labels.get(Path(rel).suffix.lower())
        if label:
            counts[label] = counts.get(label, 0) + 1
    if not counts:
        return ""
    return sorted(counts, key=lambda name: (-counts[name], name))[0]


def _ci_files(root: Path) -> list[str]:
    names = []
    folder = root / ".github" / "workflows"
    if folder.is_dir():
        names.extend(sorted(p.name for p in folder.iterdir() if p.suffix in {".yml", ".yaml"}))
    for name in (".gitlab-ci.yml", "azure-pipelines.yml", "Jenkinsfile", "circle.yml", ".circleci/config.yml", "bitbucket-pipelines.yml"):
        if (root / name).is_file():
            names.append(name)
    return names


def _coverage_config(root: Path) -> str:
    """Return a human-readable coverage note (no actual percentage — only the clone is available)."""
    for path in root.rglob("*.xml"):
        if "jacoco" in path.name.lower():
            return "JaCoCo report found."
    for path in root.rglob("*.toml"):
        try:
            if "coverage" in path.read_text(encoding="utf-8", errors="ignore").lower():
                return "coverage config found in " + path.name
        except OSError:
            pass
    if (root / ".coveragerc").is_file() or (root / "setup.cfg").is_file():
        return "coverage config found."
    for path in root.rglob("codecov.yml"):
        return "Codecov configured."
    return ""


def _stack_from_external(external: list[dict]) -> list[str]:
    stack: list[str] = []
    for label in ("HTTP API", "Database", "Auth", "Queue", "Cache", "External API"):
        if any(item.get("usedFor") == label for item in external) and label not in stack:
            stack.append(label)
    return stack


def _why(root: Path) -> str:
    readme = next(
        (root / name for name in ("README.md", "README.MD", "readme.md", "README.rst", "README.txt")
         if (root / name).is_file()),
        None,
    )
    if readme is None:
        return ""
    parts: list[str] = []
    for line in readme.read_text(encoding="utf-8", errors="ignore").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or stripped.startswith("![") or stripped.startswith("[!"):
            if parts:
                break
            continue
        parts.append(stripped)
        if len(" ".join(parts)) > 180:
            break
    text = re.sub(r"\s+", " ", " ".join(parts)).strip()
    return text[:220].rstrip()


def _license(root: Path) -> str:
    for path in sorted(root.glob("LICENSE*")):
        if not path.is_file():
            continue
        head = path.read_text(encoding="utf-8", errors="ignore")[:500]
        if "Apache" in head:
            return "Apache-2.0"
        if "MIT" in head:
            return "MIT"
        if "GNU GENERAL PUBLIC LICENSE" in head:
            return "GPL"
        if "BSD" in head:
            return "BSD"
        return path.name
    return ""
