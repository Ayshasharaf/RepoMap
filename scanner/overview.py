"""Facts a new teammate needs, read from the cloned tree. No network, no timestamps."""

import json
import os
import re
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

import javalang

from scan import merge_findings, parse_failure_finding

_LAYER_SUFFIXES = (
    ("Controller", "api", "API"),
    ("Resource", "api", "API"),
    ("Service", "services", "Services"),
    ("Repository", "data", "Data"),
    ("Repo", "data", "Data"),
    ("Entity", "data", "Data"),
    ("Client", "outbound", "Outbound"),
    ("Listener", "workers", "Workers"),
    ("Consumer", "workers", "Workers"),
    ("Job", "workers", "Workers"),
    ("Scheduler", "workers", "Workers"),
    ("Config", "config", "Config"),
    ("Configuration", "config", "Config"),
    ("Security", "auth", "Auth"),
)

_PURPOSE = (
    ("security", "Auth"),
    ("oauth", "Auth"),
    ("kafka", "Queue"),
    ("amqp", "Queue"),
    ("rabbit", "Queue"),
    ("jpa", "Database"),
    ("jdbc", "Database"),
    ("r2dbc", "Database"),
    ("postgres", "Database"),
    ("mysql", "Database"),
    ("mongo", "Database"),
    ("redis", "Cache"),
    ("cache", "Cache"),
    ("webflux", "HTTP client"),
    ("feign", "External API"),
    ("web", "HTTP API"),
    ("validation", "Validation"),
    ("actuator", "Health"),
    ("lombok", "Boilerplate"),
    ("test", "Tests"),
    ("express", "HTTP API"),
    ("fastapi", "HTTP API"),
    ("flask", "HTTP API"),
    ("gin-gonic", "HTTP API"),
    ("echo", "HTTP API"),
    ("django", "HTTP API"),
    ("axios", "HTTP client"),
    ("sqlalchemy", "Database"),
    ("prisma", "Database"),
    ("mongoose", "Database"),
    ("sqlite", "Database"),
    ("postgres", "Database"),
    ("redis", "Cache"),
)


def build_overview(root: str, scan: dict, scanned_files: set[str] | None = None) -> dict:
    base = Path(root)
    java_files = sorted(p for p in base.rglob("*.java") if "node_modules" not in p.parts)
    if scanned_files is not None:
        java_files = [path for path in java_files if _rel(path, base) in scanned_files]
    entity_names = {item.get("name") for item in scan.get("entities") or [] if item.get("name")}
    modules, class_module = _modules(java_files, base, entity_names)
    edges, parse_errors = _import_edges(java_files, base, class_module)
    if parse_errors:
        scan["findings"] = merge_findings(list(scan.get("findings") or []), parse_errors)
    external = _external_deps(base)
    entries = _entry_points(base, java_files)
    env_vars = _env_vars(base)
    checklist = _checklist(entries, env_vars)
    # Test files: Java tests + any language's test files
    java_test_files = [p for p in java_files if "/src/test/" in f"/{_rel(p, base)}"]
    test_count = _test_count_all(base) or len({str(p) for p in java_test_files})
    workflows = _ci_files(base)
    coverage = _coverage(base)
    return {
        "identity": {
            "why": _why(base),
            "language": _language(base, java_files),
            "stack": _stack(base, external),
            "license": _license(base),
            "commit": scan.get("commit") or "local",
        },
        "modules": modules,
        "moduleDiagram": _module_diagram(modules, edges),
        "dependencies": {
            "internal": edges,
            "external": external,
        },
        "entryPoints": entries,
        "checklist": checklist,
        "health": {
            "testFiles": test_count,
            "coverage": coverage,
            "workflows": workflows,
            "churn": _churn(base),
        },
    }


def _modules(java_files: list[Path], root: Path, entity_names: set[str]) -> tuple[list[dict], dict[str, str]]:
    counts: dict[str, dict] = {}
    class_module: dict[str, str] = {}
    for path in java_files:
        rel = _rel(path, root)
        if rel.startswith("src/test/"):
            continue
        name = path.stem
        key, label = ("data", "Data") if name in entity_names else _layer(name, rel)
        class_module[name] = key
        bucket = counts.setdefault(key, {"id": key, "label": label, "files": 0, "classes": []})
        bucket["files"] += 1
        bucket["classes"].append(name)
    for bucket in counts.values():
        bucket["classes"] = sorted(set(bucket["classes"]))
    return sorted(counts.values(), key=lambda item: item["label"]), class_module


def _layer(class_name: str, rel: str) -> tuple[str, str]:
    segments = [part.lower() for part in rel.split("/") if part]
    if "security" in segments or class_name.lower().endswith("security"):
        return "auth", "Auth"
    for suffix, key, label in _LAYER_SUFFIXES:
        if class_name.endswith(suffix):
            return key, label
    if class_name.endswith("Application"):
        return "app", "Application"
    return "app", "Application"


_SHORTSTAT = re.compile(
    r"(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?"
)


def _churn(root: Path) -> str:
    """Line stats for the one commit a shallow clone actually has."""
    try:
        result = subprocess.run(
            ["git", "show", "-1", "--shortstat", "--format=", "HEAD"],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    if result.returncode != 0:
        return ""
    match = _SHORTSTAT.search(result.stdout)
    if not match:
        return ""
    files = int(match.group(1))
    added = int(match.group(2) or 0)
    deleted = int(match.group(3) or 0)
    file_word = "file" if files == 1 else "files"
    return f"Latest commit changes {files} {file_word}, +{added} / -{deleted} lines."


def _import_edges(java_files: list[Path], root: Path, class_module: dict[str, str]) -> tuple[list[dict], list[dict]]:
    seen = set()
    edges = []
    parse_errors = []
    for path in java_files:
        rel = _rel(path, root)
        if rel.startswith("src/test/"):
            continue
        source = class_module.get(path.stem)
        if not source:
            continue
        try:
            tree = javalang.parse.parse(path.read_text(encoding="utf-8", errors="ignore"))
        except Exception as exc:
            parse_errors.append(parse_failure_finding(path, str(root), exc))
            continue
        names = []
        for imp in tree.imports or []:
            names.append((imp.path or "").split(".")[-1])
        for _, node in tree.filter(javalang.tree.ReferenceType):
            if node.name:
                names.append(node.name.split(".")[-1])
        for target_name in names:
            target = class_module.get(target_name)
            if not target or target == source:
                continue
            pair = (source, target)
            if pair in seen:
                continue
            seen.add(pair)
            edges.append({"from": source, "to": target})
    edges.sort(key=lambda item: (item["from"], item["to"]))
    return edges, parse_errors


def _module_diagram(modules: list[dict], edges: list[dict]) -> str:
    if not modules:
        return ""
    lines = [
        "flowchart LR",
        "  classDef api fill:#edf1ff,stroke:#173ded,color:#0a0b14",
        "  classDef code fill:#ffffff,stroke:#173ded,color:#0a0b14",
        "  classDef entity fill:#f4f6ff,stroke:#123499,color:#0a0b14",
        "  classDef job fill:#fff7ed,stroke:#9a3412,color:#0a0b14",
        "  classDef outbound fill:#ffffff,stroke:#4b5bd4,color:#0a0b14",
    ]
    style = {
        "api": "api", "services": "code", "data": "entity", "workers": "job",
        "outbound": "outbound", "auth": "job", "config": "code", "app": "code",
    }
    for module in modules:
        label = f"{module['label']}<br/>{module['files']} files"
        lines.append(f'  {module["id"]}["{label}"]')
        lines.append(f'  class {module["id"]} {style.get(module["id"], "code")}')
    for edge in edges:
        lines.append(f'  {edge["from"]} --> {edge["to"]}')
    return "\n".join(lines)


def _named_files(root: Path, names: set[str]) -> list[Path]:
    skip = {".git", "node_modules", "target", "build", ".gradle", "out"}
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name not in skip and not name.startswith(".")]
        for filename in filenames:
            if filename not in names:
                continue
            path = Path(dirpath) / filename
            try:
                if path.stat().st_size > 1_500_000:
                    continue
            except OSError:
                continue
            found.append(path)
    return found


def _external_deps(root: Path) -> list[dict]:
    found: dict[str, str] = {}
    for pom in _named_files(root, {"pom.xml"}):
        try:
            tree = ET.parse(pom)
        except ET.ParseError:
            continue
        ns = ""
        if tree.getroot().tag.startswith("{"):
            ns = tree.getroot().tag.split("}")[0] + "}"
        for dep in tree.findall(f".//{ns}dependency"):
            artifact = (dep.findtext(f"{ns}artifactId") or "").strip()
            if artifact and artifact not in found and not artifact.startswith("$"):
                found[artifact] = _purpose(artifact)
    gradle_re = re.compile(r"""['"]([A-Za-z0-9_.\-]+):([A-Za-z0-9_.\-]+)(?::[^'"]+)?['"]""")
    for gradle in _named_files(root, {"build.gradle", "build.gradle.kts"}):
        text = gradle.read_text(encoding="utf-8", errors="ignore")
        for match in gradle_re.findall(text):
            artifact = match[1]
            if artifact not in found:
                found[artifact] = _purpose(artifact)
    _manifest_deps(root, found)
    return [{"name": name, "usedFor": found[name]} for name in sorted(found)][:80]


def _remember_dep(found: dict[str, str], name: str, purpose: str | None = None) -> None:
    clean = name.strip().split("/")[-1]
    if not clean or clean.startswith("$") or clean in found or len(found) >= 80:
        return
    found[clean] = purpose or _purpose(clean)


def _manifest_deps(root: Path, found: dict[str, str]) -> None:
    for path in _named_files(root, {"package.json"}):
        try:
            data = json.loads(path.read_text(encoding="utf-8", errors="ignore"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(data, dict):
            continue
        for name in (data.get("dependencies") or {}):
            _remember_dep(found, str(name))
        for name in (data.get("devDependencies") or {}):
            _remember_dep(found, str(name), "Development")
    for path in _named_files(root, {"requirements.txt"}):
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for line in text.splitlines():
            line = line.split("#", 1)[0].strip()
            if not line or line.startswith("-"):
                continue
            name = re.split(r"[<>=\[]", line, maxsplit=1)[0].strip()
            _remember_dep(found, name)
    for path in _named_files(root, {"pyproject.toml"}):
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for name in re.findall(r"""['"]([A-Za-z0-9_.\-]+)[<>=\[][^'"]*['"]""", text):
            _remember_dep(found, name)
    for path in _named_files(root, {"Cargo.toml"}):
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for name in re.findall(r"^([A-Za-z0-9_-]+)\s*=\s*['\"]", text, flags=re.M):
            if name not in {"name", "version", "edition", "authors"}:
                _remember_dep(found, name)
    for path in _named_files(root, {"go.mod"}):
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for module in re.findall(r"^\s+([A-Za-z0-9_.\-/]+)\s+v", text, flags=re.M):
            _remember_dep(found, module)


def _language(root: Path, java_files: list[Path]) -> str:
    if java_files:
        return "Java"
    if _named_files(root, {"package.json"}):
        return "JavaScript"
    if _named_files(root, {"go.mod"}):
        return "Go"
    if _named_files(root, {"Cargo.toml"}):
        return "Rust"
    if _named_files(root, {"pyproject.toml", "requirements.txt"}):
        return "Python"
    return ""


def _purpose(artifact: str) -> str:
    lowered = artifact.lower()
    for token, label in _PURPOSE:
        if token in lowered:
            return label
    return "Library"


def _build_blob(root: Path) -> str:
    parts = []
    for path in _named_files(root, {"pom.xml", "build.gradle", "build.gradle.kts"}):
        parts.append(path.read_text(encoding="utf-8", errors="ignore").lower())
    return "\n".join(parts)


def _stack(root: Path, external: list[dict]) -> list[str]:
    stack = []
    blob = _build_blob(root)
    if "spring-boot" in blob or any("spring-boot" in item["name"] for item in external):
        stack.append("Spring Boot")
    # Detect popular non-Java frameworks by manifest presence
    ext_names = {item["name"].lower() for item in external}
    _FRAMEWORK_LABELS = [
        ("fastapi", "FastAPI"), ("flask", "Flask"), ("django", "Django"),
        ("express", "Express"), ("nextjs", "Next.js"), ("next", "Next.js"),
        ("gin", "Gin"), ("echo", "Echo"), ("fiber", "Fiber"),
        ("actix", "Actix"), ("axum", "Axum"),
        ("rails", "Rails"), ("sinatra", "Sinatra"),
        ("laravel", "Laravel"), ("symfony", "Symfony"),
        ("nestjs", "NestJS"), ("nest", "NestJS"),
        ("hono", "Hono"), ("fastify", "Fastify"),
    ]
    for token, label in _FRAMEWORK_LABELS:
        if token in ext_names and label not in stack:
            stack.append(label)
            break
    for label in ("HTTP API", "Database", "Auth", "Queue", "Cache", "External API"):
        if any(item["usedFor"] == label for item in external) and label not in stack:
            stack.append(label)
    return stack


def _why(root: Path) -> str:
    readme = next((root / name for name in ("README.md", "README.MD", "readme.md") if (root / name).is_file()), None)
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


def _root_json(root: Path, name: str) -> dict:
    path = root / name
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="ignore"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _entry_points(root: Path, java_files: list[Path]) -> list[dict]:
    entries = []
    for path in java_files:
        text = path.read_text(encoding="utf-8", errors="ignore")
        if "@SpringBootApplication" in text:
            entries.append({"name": path.stem, "detail": f"Spring Boot application · {_rel(path, root)}"})
    docker = root / "Dockerfile"
    if docker.is_file():
        for line in docker.read_text(encoding="utf-8", errors="ignore").splitlines():
            stripped = line.strip()
            upper = stripped.upper()
            if upper.startswith("CMD") or upper.startswith("ENTRYPOINT"):
                entries.append({"name": "Docker", "detail": stripped})
                break
    blob = _build_blob(root)
    spring = "spring-boot" in blob
    has_maven = bool(_named_files(root, {"pom.xml"}))
    has_gradle = bool(_named_files(root, {"build.gradle", "build.gradle.kts"}))
    mvn = "./mvnw" if (root / "mvnw").is_file() else "mvn"
    gradle = "./gradlew" if (root / "gradlew").is_file() else "gradle"
    if spring and has_maven:
        entries.append({"name": "Run locally", "detail": f"{mvn} spring-boot:run"})
        entries.append({"name": "Tests", "detail": f"{mvn} test"})
    elif spring and has_gradle:
        entries.append({"name": "Run locally", "detail": f"{gradle} bootRun"})
        entries.append({"name": "Tests", "detail": f"{gradle} test"})
    elif has_maven:
        entries.append({"name": "Tests", "detail": f"{mvn} test"})
    elif has_gradle:
        entries.append({"name": "Tests", "detail": f"{gradle} test"})
    package = _root_json(root, "package.json")
    scripts = package.get("scripts") if isinstance(package.get("scripts"), dict) else {}
    if scripts.get("start"):
        entries.append({"name": "Run locally", "detail": "npm start"})
    elif scripts.get("dev"):
        entries.append({"name": "Run locally", "detail": "npm run dev"})
    if scripts.get("test"):
        entries.append({"name": "Tests", "detail": "npm test"})
    if (root / "go.mod").is_file():
        entries.append({"name": "Run locally", "detail": "go run ."})
        entries.append({"name": "Tests", "detail": "go test ./..."})
    if (root / "Cargo.toml").is_file():
        entries.append({"name": "Run locally", "detail": "cargo run"})
        entries.append({"name": "Tests", "detail": "cargo test"})
    if (root / "pyproject.toml").is_file() or (root / "requirements.txt").is_file():
        for name in ("main.py", "app.py", "manage.py"):
            if (root / name).is_file():
                entries.append({"name": name, "detail": f"starts in · {name}"})
                entries.append({"name": "Run locally", "detail": f"python {name}"})
                break
    for command in _readme_commands(root):
        entries.append({"name": "From the README", "detail": command})
    return entries


def _readme_commands(root: Path) -> list[str]:
    readme = next((root / name for name in ("README.md", "README.MD", "readme.md") if (root / name).is_file()), None)
    if readme is None:
        return []
    text = readme.read_text(encoding="utf-8", errors="ignore")
    found = []
    seen = set()
    for block in re.findall(r"```(?:bash|sh|shell|console|zsh)?\s*\n(.*?)```", text, flags=re.S | re.I):
        for line in block.splitlines():
            command = line.strip().lstrip("$").strip()
            if not command or command.startswith("#"):
                continue
            if not re.match(r"(\./)?(mvnw|gradlew|mvn|gradle|docker|java|npm|pnpm|yarn|python|python3|uvicorn|flask|go|cargo)\b", command):
                continue
            if command in seen:
                continue
            seen.add(command)
            found.append(command)
            if len(found) == 4:
                return found
    return found


def _env_vars(root: Path) -> list[str]:
    found = set()
    candidates = [root / name for name in (".env.example", ".env.sample")]
    for pattern in ("application*.yml", "application*.yaml", "application*.properties"):
        candidates.extend(path for path in root.rglob(pattern) if ".git" not in path.parts)
    for path in candidates:
        if not path.is_file() or path.stat().st_size > 200_000:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for name in re.findall(r"\$\{([A-Z][A-Z0-9_]{1,})(?::[^}]*)?\}", text):
            found.add(name)
        if path.name.startswith(".env"):
            for line in text.splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                found.add(line.split("=", 1)[0].strip())
    return sorted(found)


def _checklist(entries: list[dict], env_vars: list[str]) -> list[dict]:
    steps = []
    if env_vars:
        shown = ", ".join(env_vars[:12])
        extra = f" (+{len(env_vars) - 12} more)" if len(env_vars) > 12 else ""
        steps.append({"title": "Set environment variables", "detail": shown + extra})
    run = next((item["detail"] for item in entries if item["name"] == "Run locally"), "")
    test = next((item["detail"] for item in entries if item["name"] == "Tests"), "")
    if run:
        steps.append({"title": "Run locally", "detail": run})
    if test:
        steps.append({"title": "Run tests", "detail": test})
    if any(item["name"] == "Docker" for item in entries):
        steps.append({"title": "Or start the container", "detail": "docker build and run, using the Dockerfile command"})
    for item in entries:
        if item["name"] == "From the README" and item["detail"] not in {run, test}:
            steps.append({"title": "From the README", "detail": item["detail"]})
    if not steps:
        steps.append({"title": "No setup file found", "detail": "This clone has no build file, Dockerfile, or env example."})
    return steps


def _ci_files(root: Path) -> list[str]:
    names = []
    folder = root / ".github" / "workflows"
    if folder.is_dir():
        names.extend(sorted(path.name for path in folder.iterdir() if path.suffix in {".yml", ".yaml"}))
    for name in ("Jenkinsfile", ".gitlab-ci.yml", "azure-pipelines.yml"):
        if (root / name).is_file():
            names.append(name)
    return names


def _coverage(root: Path) -> str:
    for path in _named_files(root, {"pom.xml", "build.gradle", "build.gradle.kts"}):
        if "jacoco" in path.read_text(encoding="utf-8", errors="ignore").lower():
            return "JaCoCo is configured. A percentage is not in the clone."
    # Non-Java coverage configs
    for name in (".coveragerc", "setup.cfg", "pytest.ini"):
        if (root / name).is_file():
            try:
                if "coverage" in (root / name).read_text(encoding="utf-8", errors="ignore").lower():
                    return f"coverage config found in {name}."
            except OSError:
                pass
    for path in root.rglob("codecov.yml"):
        return "Codecov configured."
    for path in root.rglob("*.toml"):
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
            if "[tool.coverage" in text or "[coverage]" in text:
                return f"coverage config found in {path.name}."
        except OSError:
            pass
    return ""


def _test_count_all(root: Path) -> int:
    """Count test files across all supported languages."""
    count = 0
    _TEST_SKIP = {
        ".git", "node_modules", "dist", "build", "target", "vendor",
        ".venv", "venv", "__pycache__", ".next", ".gradle", "out",
    }
    import os
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _TEST_SKIP]
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


def _rel(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root)).replace("\\", "/")
    except ValueError:
        return path.name
