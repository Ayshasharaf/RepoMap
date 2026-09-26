"""Facts a new teammate needs, read from the cloned tree. No network, no timestamps."""

import re
import xml.etree.ElementTree as ET
from pathlib import Path

import javalang

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
)


def build_overview(root: str, scan: dict) -> dict:
    base = Path(root)
    java_files = sorted(p for p in base.rglob("*.java") if "node_modules" not in p.parts)
    entity_names = {item.get("name") for item in scan.get("entities") or [] if item.get("name")}
    modules, class_module = _modules(java_files, base, entity_names)
    edges = _import_edges(java_files, base, class_module)
    external = _external_deps(base)
    entries = _entry_points(base, java_files)
    env_vars = _env_vars(base)
    checklist = _checklist(entries, env_vars)
    test_files = [p for p in java_files if _rel(p, base).startswith("src/test/")]
    workflows = sorted(p.name for p in (base / ".github" / "workflows").glob("*") if p.suffix in {".yml", ".yaml"}) if (base / ".github" / "workflows").is_dir() else []
    coverage = _coverage(base)
    return {
        "identity": {
            "why": _why(base),
            "language": "Java" if java_files else "",
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
            "testFiles": len({str(p) for p in test_files}),
            "coverage": coverage,
            "workflows": workflows,
            "churn": "Only the latest commit is cloned, so the files that change most often are not in this scan.",
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
        bucket = counts.setdefault(key, {"id": key, "label": label, "files": 0})
        bucket["files"] += 1
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


def _import_edges(java_files: list[Path], root: Path, class_module: dict[str, str]) -> list[dict]:
    seen = set()
    edges = []
    for path in java_files:
        rel = _rel(path, root)
        if rel.startswith("src/test/"):
            continue
        source = class_module.get(path.stem)
        if not source:
            continue
        try:
            tree = javalang.parse.parse(path.read_text(encoding="utf-8", errors="ignore"))
        except Exception:
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
    return edges


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


def _external_deps(root: Path) -> list[dict]:
    found: dict[str, str] = {}
    pom = root / "pom.xml"
    if pom.is_file():
        try:
            tree = ET.parse(pom)
            ns = ""
            if tree.getroot().tag.startswith("{"):
                ns = tree.getroot().tag.split("}")[0] + "}"
            for dep in tree.findall(f".//{ns}dependency"):
                artifact = dep.findtext(f"{ns}artifactId") or ""
                artifact = artifact.strip()
                if artifact and artifact not in found:
                    found[artifact] = _purpose(artifact)
        except ET.ParseError:
            pass
    for name in ("build.gradle", "build.gradle.kts"):
        gradle = root / name
        if not gradle.is_file():
            continue
        for match in re.findall(r"""['"]([A-Za-z0-9_.\-]+):([A-Za-z0-9_.\-]+)(?::[^'"]+)?['"]""", gradle.read_text(encoding="utf-8", errors="ignore")):
            artifact = match[1]
            if artifact not in found:
                found[artifact] = _purpose(artifact)
    return [{"name": name, "usedFor": found[name]} for name in sorted(found)]


def _purpose(artifact: str) -> str:
    lowered = artifact.lower()
    for token, label in _PURPOSE:
        if token in lowered:
            return label
    return "Library"


def _stack(root: Path, external: list[dict]) -> list[str]:
    stack = []
    blob = ""
    for name in ("pom.xml", "build.gradle", "build.gradle.kts"):
        path = root / name
        if path.is_file():
            blob += path.read_text(encoding="utf-8", errors="ignore").lower()
    if "spring-boot" in blob or any("spring-boot" in item["name"] for item in external):
        stack.append("Spring Boot")
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
    if (root / "mvnw").is_file() or (root / "pom.xml").is_file():
        entries.append({"name": "Run locally", "detail": "./mvnw spring-boot:run"})
        entries.append({"name": "Tests", "detail": "./mvnw test"})
    elif (root / "gradlew").is_file() or (root / "build.gradle").is_file() or (root / "build.gradle.kts").is_file():
        entries.append({"name": "Run locally", "detail": "./gradlew bootRun"})
        entries.append({"name": "Tests", "detail": "./gradlew test"})
    package_json = root / "package.json"
    if package_json.is_file():
        entries.append({"name": "Node scripts", "detail": "package.json"})
    return entries


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
    if not steps:
        steps.append({"title": "No setup file found", "detail": "The clone has no Maven or Gradle build, Dockerfile, or env example."})
    return steps


def _coverage(root: Path) -> str:
    for name in ("pom.xml", "build.gradle", "build.gradle.kts"):
        path = root / name
        if path.is_file() and "jacoco" in path.read_text(encoding="utf-8", errors="ignore").lower():
            return "JaCoCo is configured. A percentage is not in the clone."
    return ""


def _rel(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root)).replace("\\", "/")
    except ValueError:
        return path.name
