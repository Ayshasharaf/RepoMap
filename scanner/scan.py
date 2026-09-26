"""
scan.py  –  Scan a Spring Boot Java project directory.

Usage:
    python scan.py <dir>

Writes  scans/<service>.json  where <service> is the directory basename.
"""

import json
import os
import sys
from pathlib import Path

import javalang


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _collect_java_files(root: str) -> list[Path]:
    return sorted(Path(root).rglob("*.java"))


def _relative(path: Path, root: str) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


def _parse(path: Path):
    """Return (tree, source) or (None, None) on failure."""
    try:
        source = path.read_text(encoding="utf-8", errors="ignore")
        tree = javalang.parse.parse(source)
        return tree, source
    except Exception:
        return None, None


def _has_annotation(node, name: str) -> bool:
    anns = getattr(node, "annotations", []) or []
    return any(a.name == name or a.name.endswith("." + name) for a in anns)


def _annotation_value(node, name: str) -> str | None:
    """Return the string value of a single-element annotation, or None."""
    anns = getattr(node, "annotations", []) or []
    for a in anns:
        if a.name == name or a.name.endswith("." + name):
            elem = a.element
            if elem is None:
                return None
            if isinstance(elem, javalang.tree.Literal):
                return elem.value.strip('"')
            if isinstance(elem, javalang.tree.MemberReference):
                return elem.member
            # ElementArrayValue or ElementValuePair list
            if isinstance(elem, list):
                for e in elem:
                    if hasattr(e, "name") and e.name == "value":
                        v = e.value
                        if isinstance(v, javalang.tree.Literal):
                            return v.value.strip('"')
            return None
    return None


def _simple_class_name(type_node) -> str | None:
    if type_node is None:
        return None
    if isinstance(type_node, javalang.tree.ReferenceType):
        # java.util.List is nested sub_types; the simple name is the innermost one.
        node = type_node
        while getattr(node, "sub_type", None) is not None:
            node = node.sub_type
        # List<Item> or Map<String, Item> → the entity argument, not the wrapper.
        inners = []
        for arg in node.arguments or []:
            if hasattr(arg, "type") and arg.type:
                inner = _simple_class_name(arg.type)
                if inner:
                    inners.append(inner)
        if inners:
            return inners[-1]
        return node.name
    return None


# ---------------------------------------------------------------------------
# Pass 1: collect entity metadata
# ---------------------------------------------------------------------------

def _scan_entities(java_files: list[Path], root: str) -> dict:
    """
    Returns {ClassName: {"name": str, "tenantOwned": bool,
                         "file": str, "fields": {fieldName: typeName}}}
    """
    entities = {}
    for path in java_files:
        tree, _ = _parse(path)
        if tree is None:
            continue
        for _, cls in tree.filter(javalang.tree.ClassDeclaration):
            if not _has_annotation(cls, "Entity"):
                continue
            tenant_owned = False
            fields = {}
            for _, field in cls.filter(javalang.tree.FieldDeclaration):
                type_name = _simple_class_name(field.type) or ""
                for decl in field.declarators:
                    fields[decl.name] = type_name
                    if decl.name == "tenantId":
                        tenant_owned = True
            entities[cls.name] = {
                "name": cls.name,
                "tenantOwned": tenant_owned,
                "file": _relative(path, root),
                "fields": fields,
            }
    return entities


# ---------------------------------------------------------------------------
# Pass 2: collect relations
# ---------------------------------------------------------------------------

def _scan_relations(java_files: list[Path], root: str, entities: dict) -> list[dict]:
    relation_kinds = {"OneToOne", "OneToMany", "ManyToOne", "ManyToMany"}
    relations = []
    broken_seen = set()

    for path in java_files:
        tree, _ = _parse(path)
        if tree is None:
            continue
        for _, cls in tree.filter(javalang.tree.ClassDeclaration):
            if cls.name not in entities:
                continue
            for _, field in cls.filter(javalang.tree.FieldDeclaration):
                ann_kind = None
                mapped_by = None
                join_column = None
                for ann in (field.annotations or []):
                    short = ann.name.split(".")[-1]
                    if short in relation_kinds:
                        ann_kind = short
                        # mappedBy
                        elem = ann.element
                        if elem is not None:
                            if isinstance(elem, javalang.tree.MemberReference):
                                pass
                            if isinstance(elem, list):
                                for e in elem:
                                    if hasattr(e, "name") and e.name == "mappedBy":
                                        v = e.value
                                        if isinstance(v, javalang.tree.Literal):
                                            mapped_by = v.value.strip('"')
                    if short == "JoinColumn":
                        elem = ann.element
                        if elem is not None:
                            if isinstance(elem, list):
                                for e in elem:
                                    if hasattr(e, "name") and e.name == "name":
                                        v = e.value
                                        if isinstance(v, javalang.tree.Literal):
                                            join_column = v.value.strip('"')
                            elif isinstance(elem, javalang.tree.Literal):
                                join_column = elem.value.strip('"')

                if ann_kind is None:
                    continue

                target = _simple_class_name(field.type)
                if target is None:
                    continue

                broken = False
                reason = None

                if mapped_by and target in entities:
                    target_fields = entities[target].get("fields", {})
                    if mapped_by not in target_fields:
                        broken = True
                        reason = f"mappedBy='{mapped_by}' not found on {target}"

                if join_column and target in entities:
                    target_fields = entities[target].get("fields", {})
                    col_field = join_column.replace("_id", "").replace("_", "")
                    match = any(
                        f.lower() == col_field.lower() or f.lower() == join_column.lower()
                        for f in target_fields
                    )
                    if not match:
                        broken = True
                        reason = f"@JoinColumn name='{join_column}' names no field on {target}"

                key = (cls.name, target, ann_kind)
                if key in broken_seen:
                    continue
                broken_seen.add(key)

                rel = {
                    "from": cls.name,
                    "to": target,
                    "kind": ann_kind,
                    "broken": broken,
                }
                if reason:
                    rel["reason"] = reason
                relations.append(rel)

    relations.sort(key=lambda r: (r["from"], r["to"], r["kind"]))
    return relations


# ---------------------------------------------------------------------------
# Pass 3: collect endpoints
# ---------------------------------------------------------------------------

def _scan_endpoints(java_files: list[Path], root: str, entities: dict,
                    repo_method_scope_gaps: set) -> list[dict]:
    mapping_anns = {"RequestMapping", "GetMapping", "PostMapping",
                    "PutMapping", "PatchMapping", "DeleteMapping"}
    method_map = {
        "GetMapping": "GET", "PostMapping": "POST",
        "PutMapping": "PUT", "PatchMapping": "PATCH",
        "DeleteMapping": "DELETE",
    }
    endpoints = []

    for path in java_files:
        tree, _ = _parse(path)
        if tree is None:
            continue
        for _, cls in tree.filter(javalang.tree.ClassDeclaration):
            if not _has_annotation(cls, "RestController") and \
               not _has_annotation(cls, "Controller"):
                continue

            class_path = _annotation_value(cls, "RequestMapping") or ""

            for method in (cls.methods or []):
                http_method = None
                method_path = ""
                for ann in (method.annotations or []):
                    short = ann.name.split(".")[-1]
                    if short in mapping_anns:
                        http_method = method_map.get(short, "REQUEST")
                        v = _annotation_value(method, short)
                        if v:
                            method_path = v
                if http_method is None:
                    continue

                has_preauth = _has_annotation(method, "PreAuthorize") or \
                              _has_annotation(cls, "PreAuthorize")

                # detect which entity this endpoint touches via return/param heuristics
                entity_name = None
                rt = _simple_class_name(method.return_type) if method.return_type else None
                if rt in entities:
                    entity_name = rt

                scope_gap = False
                # Check if this method calls a repo method that has a scope gap
                for _, inv in method.filter(javalang.tree.MethodInvocation):
                    if inv.member in repo_method_scope_gaps and not has_preauth:
                        scope_gap = True
                        break

                ep = {
                    "method": http_method,
                    "path": (class_path + method_path).replace("//", "/") or "/",
                    "entity": entity_name,
                    "scopeGap": scope_gap,
                }
                endpoints.append(ep)

    endpoints.sort(key=lambda e: (e["path"], e["method"]))
    return endpoints


# ---------------------------------------------------------------------------
# Pass 4: findings
# ---------------------------------------------------------------------------

def _scan_findings(java_files: list[Path], root: str, entities: dict,
                   relations: list[dict]) -> tuple[list[dict], set]:
    """
    Returns (findings, repo_method_scope_gaps).
    repo_method_scope_gaps: set of method names that are scope-gap repo methods.
    """
    findings = []
    repo_method_scope_gaps: set[str] = set()

    repo_interfaces = set()

    for path in java_files:
        tree, _ = _parse(path)
        if tree is None:
            continue

        for _, cls in tree.filter(javalang.tree.ClassDeclaration):
            _check_n_plus_one(cls, path, root, findings)

        for _, iface in tree.filter(javalang.tree.InterfaceDeclaration):
            # Detect repository interfaces (extends JpaRepository, CrudRepository, etc.)
            extends = iface.extends or []
            is_repo = any(
                "Repository" in (e.name if isinstance(e, javalang.tree.ReferenceType) else str(e))
                for e in extends
            )
            if is_repo or _has_annotation(iface, "Repository"):
                repo_interfaces.add(iface.name)
                _check_scope_gaps(iface, path, root, entities, findings, repo_method_scope_gaps)

    # Broken relations
    for rel in relations:
        if rel["broken"]:
            findings.append({
                "kind": "broken_relation",
                "file": entities.get(rel["from"], {}).get("file", ""),
                "symbol": rel["from"],
                "detail": rel.get("reason", f"Broken relation from {rel['from']} to {rel['to']}"),
            })

    # Sort: name(symbol), file, symbol
    findings.sort(key=lambda f: (f.get("symbol", ""), f.get("file", ""), f.get("detail", "")))
    return findings, repo_method_scope_gaps


def _check_scope_gaps(iface, path: Path, root: str, entities: dict,
                      findings: list, repo_method_scope_gaps: set):
    for method in (iface.methods or []):
        rt = _simple_class_name(method.return_type) if method.return_type else None
        if rt not in entities:
            continue
        if not entities[rt]["tenantOwned"]:
            continue
        # Check if any parameter is tenantId
        params = method.parameters or []
        has_tenant_param = any(
            p.name == "tenantId" or _simple_class_name(p.type) in ("TenantId",)
            for p in params
        )
        if not has_tenant_param:
            findings.append({
                "kind": "scope_gap",
                "file": _relative(path, root),
                "symbol": f"{iface.name}.{method.name}",
                "detail": (
                    f"Returns tenant-owned {rt} with no tenantId parameter"
                ),
            })
            repo_method_scope_gaps.add(method.name)


def _check_n_plus_one(cls, path: Path, root: str, findings: list):
    # EAGER fetch
    for _, field in cls.filter(javalang.tree.FieldDeclaration):
        for ann in (field.annotations or []):
            if ann.name.split(".")[-1] in {"OneToMany", "ManyToMany", "ManyToOne", "OneToOne"}:
                elem = ann.element
                if elem is not None:
                    pairs = elem if isinstance(elem, list) else [elem]
                    for pair in pairs:
                        if hasattr(pair, "name") and pair.name == "fetch":
                            v = pair.value
                            val = getattr(v, "member", None) or getattr(v, "value", None)
                            if val == "EAGER":
                                for decl in field.declarators:
                                    findings.append({
                                        "kind": "n_plus_one",
                                        "file": _relative(path, root),
                                        "symbol": f"{cls.name}.{decl.name}",
                                        "detail": "FetchType.EAGER on collection/relation",
                                    })

    # find/get inside loop. javalang's filter walks the tree without cycles;
    # a hand-rolled walk recurses forever on statement nodes.
    for loop_type in (
        javalang.tree.ForStatement,
        javalang.tree.WhileStatement,
        javalang.tree.DoStatement,
    ):
        for _, stmt in cls.filter(loop_type):
            for _, inv in stmt.filter(javalang.tree.MethodInvocation):
                member = inv.member or ""
                if member.startswith("find") or member.startswith("get"):
                    findings.append({
                        "kind": "n_plus_one",
                        "file": _relative(path, root),
                        "symbol": f"{cls.name}.<loop>",
                        "detail": f"Call to {member}() inside loop",
                    })
                    break  # one finding per loop


# ---------------------------------------------------------------------------
# Diagrams
# ---------------------------------------------------------------------------

def _mermaid_id(name: str) -> str:
    """Mermaid ids and ER names must be plain identifiers. A comment-only graph renders as a 16px blank."""
    cleaned = "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in (name or ""))
    cleaned = cleaned.strip("_")
    if not cleaned or cleaned[0].isdigit():
        cleaned = "n_" + cleaned
    return cleaned or "n"


def _mermaid_label(name: str) -> str:
    return (
        (name or "unknown")
        .replace('"', "'")
        .replace("[", "(")
        .replace("]", ")")
        .replace("{", "(")
        .replace("}", ")")
        .replace(">", "›")
        .replace("<", "‹")
    )


def _kebab(name: str) -> str:
    chars: list[str] = []
    for i, ch in enumerate(name):
        if ch.isupper() and i and not (name[i - 1].isupper() and (i + 1 == len(name) or name[i + 1].isupper())):
            chars.append("-")
        chars.append(ch.lower())
    return "".join(chars)


def _entity_from_path(path: str, names: list[str]) -> str | None:
    """Match /journal-entries to JournalEntry when the handler returns a DTO, not the entity."""
    segments = [s for s in (path or "").lower().replace("_", "-").split("/") if s and not s.startswith("{")]
    best = None
    best_len = -1
    for name in names:
        kebab = _kebab(name)
        flat = kebab.replace("-", "")
        forms = {kebab, kebab + "s", flat, flat + "s"}
        if kebab.endswith("y") and len(kebab) > 1 and kebab[-2] not in "aeiou":
            forms.add(kebab[:-1] + "ies")
            forms.add(flat[:-1] + "ies")
        for seg in segments:
            seg_flat = seg.replace("-", "")
            if seg in forms or seg_flat in forms:
                if len(name) > best_len:
                    best = name
                    best_len = len(name)
    return best


def _infer_links(entities: dict) -> list[tuple[str, str, str]]:
    """UUID accountId columns never carry @ManyToOne, so the flow diagram would be four loose boxes."""
    names = list(entities)
    links = []
    seen = set()
    for src, ent in entities.items():
        for fname, ftype in (ent.get("fields") or {}).items():
            if fname in {"id", "tenantId"}:
                continue
            target = ftype if ftype in entities and ftype != src else None
            if target is None:
                key = fname.lower().replace("_", "")
                for other in names:
                    if other == src:
                        continue
                    base = _kebab(other).replace("-", "")
                    if key in {base, base + "id"}:
                        target = other
                        break
            if not target:
                continue
            pair = (src, target, fname)
            if pair in seen:
                continue
            seen.add(pair)
            links.append(pair)
    return links


def _type_name_and_args(type_node) -> tuple[str | None, list[str]]:
    if type_node is None or not isinstance(type_node, javalang.tree.ReferenceType):
        return None, []
    node = type_node
    while getattr(node, "sub_type", None) is not None:
        node = node.sub_type
    args = []
    for arg in node.arguments or []:
        inner = getattr(arg, "type", None)
        name = _simple_class_name(inner) if inner is not None else None
        if name:
            args.append(name)
    return node.name, args


def _stem(name: str) -> str:
    for suffix in ("Controller", "Service", "Repository", "Repo"):
        if name.endswith(suffix) and len(name) > len(suffix):
            return name[: -len(suffix)]
    return name


def _type_chain(type_node) -> list[str]:
    names: list[str] = []
    node = type_node
    while isinstance(node, javalang.tree.ReferenceType):
        if node.name:
            names.append(node.name.split(".")[-1])
        node = getattr(node, "sub_type", None)
    return names


def _member_types(node) -> list[str]:
    found: list[str] = []
    for chain in _member_chains(node):
        if chain:
            found.append(chain[-1])
    return found


def _member_chains(node) -> list[list[str]]:
    chains: list[list[str]] = []
    for _, field in node.filter(javalang.tree.FieldDeclaration):
        chains.append(_type_chain(field.type))
    for ctor in getattr(node, "constructors", None) or []:
        for param in ctor.parameters or []:
            chains.append(_type_chain(param.type))
    return [chain for chain in chains if chain]


_LIBRARY_OUTBOUND = {
    "WebClient", "RestTemplate", "RestClient",
    "KafkaTemplate", "RabbitTemplate", "JmsTemplate",
}


def _outbound_names(chains: list[list[str]], declared: set[str]) -> list[str]:
    found = []
    for chain in chains:
        hit = None
        for name in chain:
            if name in _LIBRARY_OUTBOUND:
                hit = name
                break
        if hit is None and chain:
            simple = chain[-1]
            if simple in declared or (simple.endswith("Client") and not simple.endswith("Repository")):
                hit = simple
        if hit and hit not in found:
            found.append(hit)
    return found


def _choose_layer(options: list[str], entity: str | None, stem: str, repositories: dict) -> str | None:
    if not options:
        return None
    if entity:
        for name in options:
            if _stem(name) == entity or repositories.get(name) == entity:
                return name
    for name in options:
        if _stem(name) == stem:
            return name
    return options[0] if len(options) == 1 else None


# ---------------------------------------------------------------------------
# Method-level data-flow helpers
# ---------------------------------------------------------------------------

def _named_types(node) -> dict[str, list[str]]:
    """Field and constructor parameter names → type chain. Direct members only."""
    found: dict[str, list[str]] = {}
    if node is None:
        return found
    for ctor in getattr(node, "constructors", None) or []:
        for param in ctor.parameters or []:
            found[param.name] = _type_chain(param.type)
    for field in getattr(node, "fields", None) or []:
        chain = _type_chain(field.type)
        for decl in field.declarators:
            found[decl.name] = chain
    return found


def _qualifier_name(inv) -> str | None:
    qualifier = getattr(inv, "qualifier", None)
    if isinstance(qualifier, str):
        return qualifier.split(".")[-1]
    if isinstance(qualifier, javalang.tree.MemberReference):
        return qualifier.member
    return None


def _method_takes_tenant(method) -> bool:
    return any(
        p.name == "tenantId" or _simple_class_name(getattr(p, "type", None)) in ("TenantId",)
        for p in (method.parameters or [])
    )


def _signature(method) -> str:
    params = []
    for param in method.parameters or []:
        type_node = param.type
        if isinstance(type_node, javalang.tree.BasicType):
            params.append(type_node.name)
        else:
            params.append(_simple_class_name(type_node) or param.name)
    return f"{method.name}({', '.join(params)})"


def _http_note(method, class_path: str) -> str | None:
    mapping_anns = {"RequestMapping", "GetMapping", "PostMapping", "PutMapping", "PatchMapping", "DeleteMapping"}
    method_map = {
        "GetMapping": "GET", "PostMapping": "POST", "PutMapping": "PUT",
        "PatchMapping": "PATCH", "DeleteMapping": "DELETE", "RequestMapping": "HTTP",
    }
    for ann in method.annotations or []:
        short = ann.name.split(".")[-1]
        if short not in mapping_anns:
            continue
        http = method_map.get(short, "HTTP")
        method_path = _annotation_value(method, short) or ""
        path = ((class_path or "") + method_path).replace("//", "/") or "/"
        return f"{http} {path}"
    return None


def _arg_mentions_tenant(inv) -> bool:
    for arg in inv.arguments or []:
        if isinstance(arg, javalang.tree.MemberReference) and arg.member == "tenantId":
            return True
        if getattr(arg, "member", None) == "tenantId":
            return True
    return False


def _note_for_call(chain: list[str], member: str, inv, repositories: dict, entities: dict, outbound_declared: set[str]) -> str | None:
    library = next((name for name in chain if name in _LIBRARY_OUTBOUND), None)
    if library:
        return f"calls {library}"
    simple = chain[-1] if chain else ""
    if simple in outbound_declared or (simple.endswith("Client") and not simple.endswith("Repository")):
        return f"calls {simple}"
    is_repo = simple in repositories or simple.endswith("Repository") or simple.endswith("Repo")
    if not is_repo or not member.startswith(("find", "get", "save", "delete", "count", "exists")):
        return None
    entity = repositories.get(simple)
    if entity and entity in entities and entities[entity]["tenantOwned"]:
        if _arg_mentions_tenant(inv):
            return f"loads tenant-owned {entity}"
        return f"loads tenant-owned {entity} — no tenant id"
    if entity:
        return f"loads {entity}"
    return f"loads data from {simple}"


def _call_notes(method, fields: dict[str, list[str]], repositories: dict, entities: dict, outbound_declared: set[str]) -> list[str]:
    if not getattr(method, "body", None):
        return []
    found = []
    for _, inv in method.filter(javalang.tree.MethodInvocation):
        chain = fields.get(_qualifier_name(inv) or "", [])
        if not chain:
            continue
        note = _note_for_call(chain, inv.member or "", inv, repositories, entities, outbound_declared)
        if note and note not in found:
            found.append(note)
    found.sort()
    return found


def _return_note(method, entities: dict, role: str, takes_tenant: bool) -> str | None:
    return_type = _simple_class_name(method.return_type) if method.return_type else None
    if not return_type or return_type not in entities:
        return None
    if entities[return_type]["tenantOwned"] and role == "Repository" and not takes_tenant:
        return f"returns tenant-owned {return_type} — no tenant id"
    if entities[return_type]["tenantOwned"]:
        return f"returns tenant-owned {return_type}"
    return f"returns {return_type}"


def _describe_type(name: str, role: str, file: str, node, entities: dict, repositories: dict, outbound_declared: set[str]) -> dict:
    members = []
    note = ""
    if role == "Entity":
        for fname, ftype in sorted((entities.get(name, {}).get("fields") or {}).items()):
            members.append({
                "kind": "field",
                "name": fname,
                "note": "tenant id" if fname == "tenantId" else (ftype or ""),
            })
    else:
        class_path = ""
        if node is not None and role == "Controller":
            class_path = _annotation_value(node, "RequestMapping") or ""
        fields = _named_types(node)
        for method in list(getattr(node, "methods", None) or []):
            notes = []
            http = _http_note(method, class_path)
            if http:
                notes.append(http)
            if _has_annotation(method, "Scheduled"):
                notes.append("runs on a schedule")
            if any(_has_annotation(method, ann) for ann in ("KafkaListener", "RabbitListener", "JmsListener")):
                notes.append("starts from a message")
            takes_tenant = _method_takes_tenant(method)
            if takes_tenant:
                notes.append("takes tenantId")
            returned = _return_note(method, entities, role, takes_tenant)
            if returned:
                notes.append(returned)
            for call in _call_notes(method, fields, repositories, entities, outbound_declared):
                if call not in notes:
                    notes.append(call)
            if role == "Outbound" and not any(item.startswith("calls ") or item.startswith("sends ") for item in notes):
                notes.append("sends this call outside the service")
            members.append({"kind": "method", "name": _signature(method), "note": " · ".join(notes)})
        members.sort(key=lambda item: (
            0 if ("tenant" in item["note"] or "calls " in item["note"] or item["note"].startswith("sends ")) else 1,
            item["name"],
        ))
        if role == "Outbound" and node is None:
            note = "Called from this service. The methods live in the library, not in this repo."
    return {"name": name, "role": role, "file": file or "", "note": note, "members": members}


def _is_outbound_name(simple: str, chain: list[str], outbound_declared: set[str]) -> str | None:
    for name in chain:
        if name in _LIBRARY_OUTBOUND:
            return name
    if simple in outbound_declared or (simple.endswith("Client") and not simple.endswith("Repository")):
        return simple
    return None


def _method_named(node, name: str, argc: int | None):
    """A method on this type. Prefer the overload whose parameter count matches the call."""
    if node is None or not name:
        return None
    methods = [item for item in (getattr(node, "methods", None) or []) if item.name == name]
    if argc is not None:
        exact = [item for item in methods if len(item.parameters or []) == argc]
        if exact:
            return exact[0]
    return methods[0] if methods else None


def _project_role(name: str, services: dict, repositories: dict, entities: dict) -> str:
    if name in entities:
        return "Entity"
    if name in repositories or name.endswith("Repository") or name.endswith("Repo"):
        return "Repository"
    if name in services or name.endswith("Service"):
        return "Service"
    return "Helper"


def _trace_method(method, owner: str, fields: dict, nodes: dict, services: dict, repositories: dict, entities: dict, outbound_declared: set[str], seen: set, depth: int = 0) -> list[dict]:
    """Follow this method into the project classes it calls, including its own private methods."""
    if method is None or not getattr(method, "body", None) or depth > 12:
        return []
    key = (owner, getattr(method, "name", ""))
    if key in seen:
        return []
    seen.add(key)
    calls: list[dict] = []
    seen_edges: set[tuple[str, str, str]] = set()

    def add(src: str, dst: str, role: str) -> None:
        edge = (src, dst, role)
        if not src or not dst or src == dst or edge in seen_edges:
            return
        seen_edges.add(edge)
        calls.append({"from": src, "to": dst, "role": role})

    def follow(called, class_name: str, class_node) -> None:
        if called is None or class_node is None:
            return
        for nested in _trace_method(
            called, class_name, _named_types(class_node), nodes, services, repositories, entities, outbound_declared, seen, depth + 1,
        ):
            add(nested["from"], nested["to"], nested["role"])

    for _, inv in method.filter(javalang.tree.MethodInvocation):
        member = inv.member or ""
        argc = len(inv.arguments) if inv.arguments is not None else None
        qualifier = _qualifier_name(inv)
        if not qualifier or qualifier == "this":
            owner_node = nodes.get(owner, (None, None))[1]
            follow(_method_named(owner_node, member, argc), owner, owner_node)
            continue
        chain = fields.get(qualifier, [])
        if not chain:
            continue
        simple = chain[-1]
        outbound = _is_outbound_name(simple, chain, outbound_declared)
        if outbound:
            add(owner, outbound, "Outbound")
            continue
        if simple in repositories or simple.endswith("Repository") or simple.endswith("Repo"):
            add(owner, simple, "Repository")
            entity = repositories.get(simple)
            repo_node = nodes.get(simple)
            if repo_node:
                for repo_method in getattr(repo_node[1], "methods", None) or []:
                    if repo_method.name != member:
                        continue
                    return_type = _simple_class_name(repo_method.return_type) if repo_method.return_type else None
                    if return_type in entities:
                        entity = return_type
                    break
            if entity in entities:
                add(simple, entity, "Entity")
            continue
        if simple not in nodes and simple not in services and not simple.endswith("Service"):
            continue
        role = _project_role(simple, services, repositories, entities)
        add(owner, simple, role)
        if role == "Entity":
            continue
        target = nodes.get(simple)
        if not target:
            continue
        follow(_method_named(target[1], member, argc), simple, target[1])
    return calls


def _fallback_chain(owner: str, types: list[str], entity: str | None, services: dict, repositories: dict, entities: dict) -> list[dict]:
    """Used only when a method body has no resolvable calls. Does not invent outbound clients."""
    calls: list[dict] = []
    service = None
    if owner not in services and not owner.endswith("Service"):
        options = [name for name in types if name in services]
        service = _choose_layer(options, entity, _stem(owner), repositories)
        if service is None:
            stem = entity or _stem(owner)
            named = [name for name in services if _stem(name) == stem]
            service = named[0] if len(named) == 1 else None
        if service:
            calls.append({"from": owner, "to": service, "role": "Service"})
    repo_types = services.get(service) or types
    repo_options = [name for name in repo_types if name in repositories]
    repository = _choose_layer(repo_options, entity, _stem(owner), repositories)
    if repository is None:
        stem = entity or _stem(owner)
        named = [name for name in repositories if _stem(name) == stem or repositories[name] == entity]
        repository = named[0] if len(named) == 1 else None
    source = service or owner
    if repository:
        calls.append({"from": source, "to": repository, "role": "Repository"})
        found = repositories.get(repository) or (entity if entity in entities else None)
        if found:
            calls.append({"from": repository, "to": found, "role": "Entity"})
    elif entity in entities:
        calls.append({"from": source, "to": entity, "role": "Entity"})
    return calls


def _path_comment(step: dict) -> str:
    def cell(value: str) -> str:
        return (value or "").replace("\t", " ").replace("\n", " ").replace("\r", " ").replace("|", "/")

    parts = ["%% path", cell(step.get("entry_kind") or "request"), cell(step.get("entry") or "")]
    seen: set[str] = set()
    if step.get("owner"):
        parts.append(f"{cell(step.get('owner_role') or 'Code')}|{cell(step['owner'])}")
        seen.add(step["owner"])
    for call in step.get("calls") or []:
        if call["to"] in seen:
            continue
        seen.add(call["to"])
        parts.append(f"{cell(call['role'])}|{cell(call['to'])}")
    return "\t".join(parts)


def _classes_from_flow(chains: list[dict], nodes: dict, entities: dict, repositories: dict, outbound_declared: set[str]) -> list[dict]:
    roles: dict[str, str] = {}
    for step in chains:
        if step.get("owner"):
            roles[step["owner"]] = step.get("owner_role") or "Job"
        for call in step.get("calls") or []:
            roles.setdefault(call["to"], call["role"])
        if step.get("controller"):
            roles.setdefault(step["controller"], "Controller")
        if step.get("service"):
            roles.setdefault(step["service"], step.get("service_role") or "Service")
        if step.get("repository"):
            roles.setdefault(step["repository"], "Repository")
        if step.get("entity"):
            roles.setdefault(step["entity"], "Entity")
        for outside in step.get("outbound") or []:
            roles.setdefault(outside, "Outbound")
    described = []
    for name in sorted(roles):
        file, node = nodes.get(name, ("", None))
        if name in entities:
            file = entities[name].get("file") or file
        described.append(_describe_type(name, roles[name], file, node, entities, repositories, outbound_declared))
    return described


def _class_comment_lines(info: dict) -> list[str]:
    def cell(value: str) -> str:
        return (value or "").replace("\t", " ").replace("\n", " ").replace("\r", " ")

    base = [cell(info["name"]), cell(info["role"]), cell(info.get("file") or "")]
    lines = []
    if info.get("note"):
        lines.append("%% flow\t" + "\t".join([*base, "class", "", cell(info["note"])]))
    for member in info.get("members") or []:
        lines.append("%% flow\t" + "\t".join([
            *base,
            cell(member.get("kind") or "method"),
            cell(member.get("name") or ""),
            cell(member.get("note") or ""),
        ]))
    if not lines:
        lines.append("%% flow\t" + "\t".join([*base, "class", "", ""]))
    return lines


def _scan_flow(java_files: list[Path], entities: dict, root: str = "") -> tuple[list[dict], list[dict]]:
    """Request, schedule, or listener → controller → service → repository → entity, plus calls that leave the service."""
    controllers: dict[str, list[str]] = {}
    services: dict[str, list[str]] = {}
    repositories: dict[str, str | None] = {}
    class_chains: dict[str, list[list[str]]] = {}
    outbound_declared: set[str] = set()
    controller_methods: list[tuple[str, object, str]] = []
    other_classes: list[tuple[str, object, list[str]]] = []
    nodes: dict[str, tuple[str, object]] = {}

    for path in java_files:
        tree, _ = _parse(path)
        if tree is None:
            continue
        for _, cls in tree.filter(javalang.tree.ClassDeclaration):
            nodes[cls.name] = (_relative(path, root), cls)
            if _has_annotation(cls, "FeignClient"):
                outbound_declared.add(cls.name)
            if cls.name in entities:
                continue
            types = _member_types(cls)
            class_chains[cls.name] = _member_chains(cls)
            if _has_annotation(cls, "RestController") or _has_annotation(cls, "Controller"):
                controllers[cls.name] = types
                class_path = _annotation_value(cls, "RequestMapping") or ""
                controller_methods.append((cls.name, cls, class_path))
            elif _has_annotation(cls, "Service") or cls.name.endswith("Service"):
                services[cls.name] = types
                other_classes.append((cls.name, cls, types))
            elif _has_annotation(cls, "Repository") or cls.name.endswith("Repository") or cls.name.endswith("Repo"):
                repositories.setdefault(cls.name, None)
            else:
                other_classes.append((cls.name, cls, types))
        for _, iface in tree.filter(javalang.tree.InterfaceDeclaration):
            nodes[iface.name] = (_relative(path, root), iface)
            if _has_annotation(iface, "FeignClient"):
                outbound_declared.add(iface.name)
            entity = None
            is_repo = _has_annotation(iface, "Repository") or iface.name.endswith("Repository") or iface.name.endswith("Repo")
            for ext in iface.extends or []:
                tname, args = _type_name_and_args(ext)
                if tname and "Repository" in (tname or ""):
                    is_repo = True
                for arg in args:
                    if arg in entities:
                        entity = arg
                        break
            if is_repo:
                repositories[iface.name] = entity or repositories.get(iface.name)

    def owner_role(class_name: str) -> str:
        if class_name in controllers:
            return "Controller"
        if class_name in services or class_name.endswith("Service"):
            return "Service"
        return "Job"

    from sequence import load_triggers, route_diagrams
    triggers = load_triggers(root)

    def build_step(class_name: str, cls, types: list[str], entity: str | None, method, entry: str, entry_kind: str) -> dict:
        role = owner_role(class_name)
        calls = _trace_method(method, class_name, _named_types(cls), nodes, services, repositories, entities, outbound_declared, set())
        if not calls:
            calls = _fallback_chain(class_name, types, entity, services, repositories, entities)
        service = next((call["to"] for call in calls if call["role"] == "Service"), None)
        repository = next((call["to"] for call in calls if call["role"] == "Repository"), None)
        found_entity = next((call["to"] for call in calls if call["role"] == "Entity"), None)
        outbound = []
        for call in calls:
            if call["role"] == "Outbound" and call["to"] not in outbound:
                outbound.append(call["to"])
        story = {"sequence": "", "transaction": "", "trigger": ""}
        try:
            story = route_diagrams(
                method, class_name, cls, entry, nodes, services, repositories, entities, outbound_declared, triggers,
            )
        except Exception:
            safe_entry = (entry or class_name).replace('"', "'")
            story = {
                "sequence": "\n".join([
                    "sequenceDiagram",
                    "    participant Client",
                    f"    participant {class_name}",
                    f"    Client->>{class_name}: {safe_entry}",
                ]),
                "transaction": "",
                "trigger": "",
            }
        return {
            "entry": entry,
            "entry_kind": entry_kind,
            "owner": class_name,
            "owner_role": role,
            "calls": calls,
            "controller": class_name if role == "Controller" else None,
            "service": service if service else (class_name if role == "Service" else None),
            "service_role": "Service" if (service in services or (service or "").endswith("Service") or role == "Service") else "Job",
            "repository": repository,
            "entity": found_entity if found_entity in entities else None,
            "outbound": outbound,
            "sequence": story.get("sequence") or "",
            "transaction": story.get("transaction") or "",
            "trigger": story.get("trigger") or "",
        }

    mapping_anns = {"RequestMapping", "GetMapping", "PostMapping", "PutMapping", "PatchMapping", "DeleteMapping"}
    method_map = {
        "GetMapping": "GET", "PostMapping": "POST", "PutMapping": "PUT",
        "PatchMapping": "PATCH", "DeleteMapping": "DELETE", "RequestMapping": "REQUEST",
    }
    listener_anns = ("KafkaListener", "RabbitListener", "JmsListener")
    names = sorted(entities)
    chains = []

    for controller, cls, class_path in controller_methods:
        types = controllers.get(controller, [])
        for method in cls.methods or []:
            http_method = None
            method_path = ""
            for ann in method.annotations or []:
                short = ann.name.split(".")[-1]
                if short in mapping_anns:
                    http_method = method_map.get(short, "REQUEST")
                    v = _annotation_value(method, short)
                    if v:
                        method_path = v
            if http_method is None:
                continue
            path = (class_path + method_path).replace("//", "/") or "/"
            rt = _simple_class_name(method.return_type) if method.return_type else None
            entity = rt if rt in entities else _entity_from_path(path, names)
            chains.append(build_step(
                controller, cls, types, entity, method,
                f"{http_method} {path}".strip(), "request",
            ))

    def add_background(class_name: str, cls, types: list[str]) -> None:
        for method in cls.methods or []:
            kind = None
            if _has_annotation(method, "Scheduled"):
                kind = "Scheduled"
            else:
                for ann in listener_anns:
                    if _has_annotation(method, ann):
                        kind = "Listener"
                        break
            if kind is None:
                continue
            chains.append(build_step(
                class_name, cls, types, None, method,
                f"{kind} · {method.name}", "job",
            ))

    for class_name, cls, types in other_classes:
        add_background(class_name, cls, types)
    for controller, cls, _class_path in controller_methods:
        add_background(controller, cls, controllers.get(controller, []))

    if not chains:
        produced = 0
        for name in sorted(nodes):
            _file, node = nodes[name]
            if node is None or not getattr(node, "methods", None):
                continue
            methods = sorted((item for item in node.methods if getattr(item, "body", None)), key=lambda item: item.name)
            chosen = methods[:2] or [None]
            for method in chosen:
                label = name if method is None else f"{name}.{method.name}"
                chains.append(build_step(name, node, [], None, method, label, "request"))
                produced += 1
                if produced >= 20:
                    break
            if produced >= 20:
                break

    classes = _classes_from_flow(chains, nodes, entities, repositories, outbound_declared)
    return chains, classes


def _make_diagrams(entities: dict, relations: list[dict], endpoints: list[dict], flow: list[dict] | None = None, classes: list[dict] | None = None) -> dict:
    # Always emit a node per entity. A graph that is only a %% comment draws nothing.
    names = sorted(entities)
    declared = {(r["from"], r["to"]) for r in relations}
    inferred = [link for link in _infer_links(entities) if (link[0], link[1]) not in declared]

    arch_lines = [
        "flowchart LR",
        "  classDef api   fill:#edf1ff,stroke:#173ded,color:#0a0b14",
        "  classDef job   fill:#e6edff,stroke:#4b5bd4,color:#0a0b14",
        "  classDef code  fill:#ffffff,stroke:#173ded,color:#0a0b14",
        "  classDef entity fill:#f4f6ff,stroke:#123499,color:#0a0b14",
        "  classDef outbound fill:#fff7ed,stroke:#9a3412,color:#0a0b14",
    ]
    groups: dict[str, list[str]] = {"entry": [], "application": [], "data": [], "outside": []}
    group_title = {
        "entry": "Entry",
        "application": "Application",
        "data": "Data",
        "outside": "Outside",
    }
    seen_nodes: set[str] = set()
    seen_edges: set[tuple[str, str, str]] = set()
    class_lines: list[str] = []
    edge_lines: list[str] = []
    edge_styles: list[str] = []

    def add_node(node_id: str, role: str, label: str, kind: str, group: str, extra_lines: list[str] | None = None) -> str:
        nid = _mermaid_id(node_id)
        if nid not in seen_nodes:
            lines = [f"{role}<br/>{_mermaid_label(label)}"]
            for extra in extra_lines or []:
                lines.append(_mermaid_label(extra))
            text = "<br/>".join(lines)
            groups[group].append(f'    {nid}["{text}"]')
            class_lines.append(f"  class {nid} {kind}")
            seen_nodes.add(nid)
        return nid

    def add_edge(left: str | None, right: str | None, dashed: bool = False, label: str = "", kind: str = "sync") -> None:
        if not left or not right or left == right:
            return
        key = (left, right, "dash" if dashed else "solid")
        if key in seen_edges:
            return
        if dashed:
            arrow = f"-. {_mermaid_label(label)} .->" if label else "-.->"
        else:
            arrow = f"-- {_mermaid_label(label)} -->" if label else "-->"
        edge_lines.append(f"  {left} {arrow} {right}")
        stroke = {"sync": "#173ded", "db": "#0e7a3d", "async": "#9a3412", "exit": "#4b5bd4"}.get(kind, "#173ded")
        edge_styles.append(f"  linkStyle {len(edge_styles)} stroke:{stroke},stroke-width:2px")
        seen_edges.add(key)

    if flow:
        # Merge routes only when they call the same classes. A charge route must
        # not inherit the clients used by a different method on the same controller.
        grouped: dict[tuple, list[dict]] = {}
        order: list[tuple] = []
        for step in flow:
            call_key = tuple((call["from"], call["to"], call["role"]) for call in step.get("calls") or [])
            key = (step.get("entry_kind"), step.get("owner"), call_key)
            if key not in grouped:
                grouped[key] = []
                order.append(key)
            grouped[key].append(step)

        for index, key in enumerate(order):
            steps = grouped[key]
            local: dict[str, str] = {}

            def place(name: str, role: str, suffix: int = index, bucket: dict[str, str] = local) -> str:
                if name in bucket:
                    return bucket[name]
                if role == "Entity":
                    group, kind = "data", "entity"
                elif role == "Repository":
                    group, kind = "data", "code"
                elif role == "Outbound":
                    group, kind = "outside", "outbound"
                else:
                    group, kind = "application", "code"
                nid = add_node(f"{name}_{suffix}", role, name, kind, group)
                bucket[name] = nid
                return nid

            entry_kind = steps[0].get("entry_kind") or "request"
            labels = [step.get("entry") or "entry" for step in steps]
            if len(labels) == 1:
                role = "Request" if entry_kind == "request" else "Starts"
                entry_nid = add_node(f"entry{index}", role, labels[0], "job" if entry_kind == "job" else "api", "entry")
            else:
                entry_nid = add_node(
                    f"entry{index}", "Routes", labels[0], "api", "entry", extra_lines=labels[1:4],
                )
            def flow_kind(role: str, target: str) -> str:
                if role in ("Repository", "Entity"):
                    return "db"
                if role == "Outbound":
                    if any(token in target for token in ("Kafka", "Rabbit", "Jms")):
                        return "async"
                    return "exit"
                if entry_kind == "job":
                    return "async"
                return "sync"

            owner = steps[0].get("owner")
            if owner:
                add_edge(entry_nid, place(owner, steps[0].get("owner_role") or "Code"), kind=flow_kind(steps[0].get("owner_role") or "", owner))
            for call in steps[0].get("calls") or []:
                target = place(call["to"], call["role"])
                source = local.get(call["from"]) or place(call["from"], "Code")
                add_edge(source, target, dashed=call["role"] == "Outbound", kind=flow_kind(call["role"], call["to"]))
    else:
        for name in names:
            add_node(name, "Entity", name, "entity", "data")
        for i, ep in enumerate(endpoints):
            entity = ep.get("entity") or _entity_from_path(ep.get("path") or "", names)
            method = ep.get("method") or ""
            raw_path = ep.get("path") or "/"
            short_path = raw_path[:35] + "…" if len(raw_path) > 38 else raw_path
            label = f"{method} {short_path}".strip()
            request = add_node(f"ep{i}", "Request", label, "api", "entry")
            if entity and entity in entities:
                add_edge(request, add_node(entity, "Entity", entity, "entity", "data"), kind="db")

    for key, title in group_title.items():
        if not groups[key]:
            continue
        arch_lines.append(f"  subgraph {key} [{title}]")
        arch_lines.extend(groups[key])
        arch_lines.append("  end")
    arch_lines.extend(class_lines)
    arch_lines.extend(edge_lines)
    arch_lines.extend(edge_styles)
    for info in classes or []:
        arch_lines.extend(_class_comment_lines(info))
    for step in flow or []:
        arch_lines.append(_path_comment(step))
    for index, step in enumerate(flow or []):
        entry = (step.get("entry") or "").replace("\t", " ")
        arch_lines.append(f"%% diagram\t{index}\tentry\t{entry}")
        for kind in ("sequence", "transaction", "trigger"):
            text = step.get(kind) or ""
            if not text:
                continue
            tag = {"sequence": "seq", "transaction": "tx", "trigger": "trigger"}[kind]
            for line in text.splitlines():
                arch_lines.append(f"%% diagram\t{index}\t{tag}\t{line.replace(chr(9), '    ')}")

    erd_lines = ["erDiagram"]
    for e in sorted(entities.values(), key=lambda x: x["name"]):
        erd_lines.append(f"  {_mermaid_id(e['name'])} {{")
        fields = e.get("fields") or {}
        if not fields:
            erd_lines.append("    Object id")
        for fname, ftype in sorted(fields.items()):
            erd_lines.append(f"    {_mermaid_id(ftype or 'Object')} {_mermaid_id(fname)}")
        erd_lines.append("  }")
    for rel in relations:
        arrow = "||--o{" if "Many" in rel["kind"] else "||--||"
        erd_lines.append(
            f"  {_mermaid_id(rel['from'])} {arrow} {_mermaid_id(rel['to'])} : {_mermaid_id(rel['kind'])}"
        )
    for src, dst, fname in inferred:
        erd_lines.append(f"  {_mermaid_id(src)} }}o--|| {_mermaid_id(dst)} : {_mermaid_id(fname)}")

    conn_lines = [
        "flowchart LR",
        "  classDef entity fill:#f4f6ff,stroke:#123499,color:#0a0b14",
    ]
    for name in names:
        nid = _mermaid_id(name)
        conn_lines.append(f'  {nid}["{_mermaid_label(name)}"]')
        conn_lines.append(f"  class {nid} entity")
    for rel in relations:
        style = "-->" if not rel["broken"] else "-.->"
        conn_lines.append(
            f"  {_mermaid_id(rel['from'])} {style}|{_mermaid_label(rel['kind'])}| {_mermaid_id(rel['to'])}"
        )
    for src, dst, fname in inferred:
        conn_lines.append(
            f"  {_mermaid_id(src)} -.->|{_mermaid_label(fname)}| {_mermaid_id(dst)}"
        )

    return {
        "architecture": "\n".join(arch_lines),
        "erd": "\n".join(erd_lines) if names or relations else "",
        "connections": "\n".join(conn_lines) if names or relations else "",
    }


# ---------------------------------------------------------------------------
# Main scan function
# ---------------------------------------------------------------------------

def scan_directory(root: str, commit: str = "local") -> dict:
    root = os.path.abspath(root)
    java_files = _collect_java_files(root)

    if not java_files:
        return _unscored(root, commit, "No Java files found")

    entity_map = _scan_entities(java_files, root)

    if len(java_files) > 500:
        return _unscored(root, commit, f"Too many Java files ({len(java_files)} > 500)")

    flow, classes = _scan_flow(java_files, entity_map, root)
    if not entity_map:
        result = _unscored(root, commit, "No @Entity classes found")
        result["diagrams"] = _make_diagrams({}, [], [], flow, classes)
        return result

    relations = _scan_relations(java_files, root, entity_map)
    findings, repo_method_scope_gaps = _scan_findings(java_files, root, entity_map, relations)
    endpoints = _scan_endpoints(java_files, root, entity_map, repo_method_scope_gaps)

    scope_gaps = sum(1 for f in findings if f["kind"] == "scope_gap")
    n_plus_one = sum(1 for f in findings if f["kind"] == "n_plus_one")
    broken_relations = sum(1 for f in findings if f["kind"] == "broken_relation")
    score = scope_gaps * 5 + n_plus_one * 2 + broken_relations * 2

    if scope_gaps >= 3:
        risk = "High"
    elif score >= 4:
        risk = "Medium"
    else:
        risk = "Low"

    entities_out = sorted(
        [{"name": e["name"], "tenantOwned": e["tenantOwned"]} for e in entity_map.values()],
        key=lambda x: x["name"],
    )

    service_name = os.path.basename(root)

    result = {
        "service": service_name,
        "commit": commit,
        "summary": (
            f"{len(entity_map)} entities, {len(endpoints)} endpoints, "
            f"{len(findings)} findings"
        ),
        "entities": entities_out,
        "relations": relations,
        "endpoints": endpoints,
        "findings": findings,
        "counts": {
            "scopeGaps": scope_gaps,
            "nPlusOne": n_plus_one,
            "brokenRelations": broken_relations,
            "score": score,
            "risk": risk,
        },
        "diagrams": _make_diagrams(entity_map, relations, endpoints, flow, classes),
    }
    return result


def _unscored(root: str, commit: str, reason: str) -> dict:
    service_name = os.path.basename(root)
    return {
        "service": service_name,
        "commit": commit,
        "summary": reason,
        "entities": [],
        "relations": [],
        "endpoints": [],
        "findings": [{"kind": "scope_gap", "file": "", "symbol": "", "detail": reason}],
        "counts": {
            "scopeGaps": 0,
            "nPlusOne": 0,
            "brokenRelations": 0,
            "score": 0,
            "risk": "Unscored",
        },
        "diagrams": {"architecture": "", "erd": "", "connections": ""},
    }


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def _get_git_commit(root: str) -> str:
    try:
        import subprocess
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=root, capture_output=True, text=True, timeout=5,
        )
        sha = result.stdout.strip()
        return sha if sha else "local"
    except Exception:
        return "local"


def main():
    if len(sys.argv) != 2:
        print("Usage: python scan.py <dir>", file=sys.stderr)
        sys.exit(1)

    root = sys.argv[1]
    if not os.path.isdir(root):
        print(f"Not a directory: {root}", file=sys.stderr)
        sys.exit(1)

    commit = _get_git_commit(root)
    data = scan_directory(root, commit)

    out_dir = Path("scans")
    out_dir.mkdir(exist_ok=True)
    out_file = out_dir / f"{data['service']}.json"
    out_file.write_text(json.dumps(data, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    print(out_file)


if __name__ == "__main__":
    main()
