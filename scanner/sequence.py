"""Sequence and transaction diagrams for one route, taken from the method body.

Branches are emitted only where the code returns or throws. SQL triggers are
emitted only when a write hits a table that has one. Nothing here is invented
from a README.
"""

import re
from pathlib import Path

import javalang.tree as tree

from scan import (
    _annotation_value,
    _has_annotation,
    _is_outbound_name,
    _method_named,
    _named_types,
    _project_role,
    _qualifier_name,
    _simple_class_name,
)

_WRITE = {"save", "saveall", "saveandflush", "delete", "deleteall", "deletebyid"}
_HTTP = {
    "OK": "200 OK",
    "CREATED": "201 Created",
    "ACCEPTED": "202 Accepted",
    "NO_CONTENT": "204 No Content",
    "BAD_REQUEST": "400 Bad Request",
    "CONFLICT": "409 Conflict",
    "NOT_FOUND": "404 Not Found",
    "INTERNAL_SERVER_ERROR": "500 Internal Server Error",
}


def load_triggers(root: str) -> list[dict]:
    found = []
    base = Path(root)
    if not base.is_dir():
        return found
    skip = {".git", "target", "build", "node_modules"}
    for path in base.rglob("*.sql"):
        if any(part in skip for part in path.parts):
            continue
        try:
            if path.stat().st_size > 1_500_000:
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        functions: dict[str, dict] = {}
        for match in re.finditer(
            r"CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\w+)\s*\([^)]*\)\s*RETURNS\s+TRIGGER\s+AS\s+\$\$(.*?)\$\$",
            text,
            flags=re.I | re.S,
        ):
            body = match.group(2)
            raises = re.findall(r"RAISE\s+EXCEPTION\s+'([^']+)'", body, flags=re.I)
            checks_sum = bool(re.search(r"\bSUM\s*\(", body, flags=re.I)) and bool(
                re.search(r"(<>|!=)\s*0|=\s*0", body)
            )
            functions[match.group(1).lower()] = {"raises": raises, "checks_sum": checks_sum}
        for match in re.finditer(
            r"CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+(\w+)\b.*?\bON\s+(\w+)\b.*?EXECUTE\s+(?:PROCEDURE|FUNCTION)\s+(\w+)",
            text,
            flags=re.I | re.S,
        ):
            info = functions.get(match.group(3).lower(), {})
            found.append({
                "name": match.group(1),
                "table": match.group(2).lower(),
                "raises": info.get("raises") or [],
                "checks_sum": bool(info.get("checks_sum")),
            })
    found.sort(key=lambda item: (item["table"], item["name"]))
    return found


def route_diagrams(method, owner: str, owner_node, entry: str, nodes: dict, services: dict, repositories: dict, entities: dict, outbound_declared: set, triggers: list[dict]) -> dict:
    db = "PostgreSQL" if _uses_postgres(nodes, triggers) else "Database"
    statuses: list[str] = []
    headers: list[str] = []
    tx: list[str] = []
    used_triggers: list[dict] = []
    counter = [0]
    events = [{
        "k": "msg",
        "src": "Client",
        "dst": owner,
        "label": entry,
        "back": False,
    }]
    if method is not None and getattr(method, "body", None):
        events.extend(_walk_method(
            method, owner, owner_node, "Client", {}, nodes, services, repositories, entities,
            outbound_declared, db, triggers, used_triggers, tx, statuses, headers, counter, set(), True,
        ))
    return_label = _return_label(statuses, headers)
    if return_label:
        events.append({"k": "msg", "src": owner, "dst": "Client", "label": return_label, "back": True})
    sequence = _render_sequence(events, db)
    transaction = _render_transaction(tx)
    trigger = _render_trigger(used_triggers, db)
    return {"sequence": sequence, "transaction": transaction, "trigger": trigger}


def _uses_postgres(nodes: dict, triggers: list[dict]) -> bool:
    if triggers:
        return True
    for _file, node in nodes.values():
        if node is None:
            continue
        for _, inv in node.filter(tree.MethodInvocation):
            if (inv.member or "") != "createNativeQuery":
                continue
            sql = _literal((inv.arguments or [None])[0])
            if sql and ("pg_" in sql.lower() or "postgres" in sql.lower()):
                return True
    return False


def _walk_method(method, actor, class_node, reply_to, bindings, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen, collect_http: bool):
    key = (actor, getattr(method, "name", ""))
    if key in seen or counter[0] > 120:
        return []
    seen.add(key)
    if _transactional(method, class_node):
        readonly = _transactional_readonly(method, class_node)
        label = f"@Transactional {actor}.{method.name}"
        if readonly:
            label += " readOnly"
        if label not in tx:
            tx.append(label)
    events = []
    _walk_statements(
        method.body or [], events, actor, class_node, reply_to, bindings, nodes, services, repositories,
        entities, outbound, db, triggers, used_triggers, tx, statuses if collect_http else [], headers if collect_http else [],
        counter, seen,
    )
    return events


def _walk_statements(statements, events, actor, class_node, reply_to, bindings, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen):
    statements = list(statements or [])
    index = 0
    while index < len(statements):
        if counter[0] > 120:
            return
        stmt = statements[index]
        if isinstance(stmt, tree.IfStatement) and stmt.else_statement is None and _terminal(stmt.then_statement):
            then_events = []
            _walk_one(stmt.then_statement, then_events, actor, class_node, reply_to, bindings, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen)
            else_events = []
            _walk_statements(statements[index + 1:], else_events, actor, class_node, reply_to, bindings, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen)
            _add_alt(events, _condition_label(stmt.condition), then_events, "otherwise", else_events)
            return
        _walk_one(stmt, events, actor, class_node, reply_to, bindings, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen)
        index += 1


def _walk_one(stmt, events, actor, class_node, reply_to, bindings, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen):
    if stmt is None or counter[0] > 120:
        return
    if isinstance(stmt, tree.BlockStatement):
        _walk_statements(stmt.statements, events, actor, class_node, reply_to, bindings, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen)
        return
    if isinstance(stmt, tree.IfStatement):
        then_events = []
        _walk_one(stmt.then_statement, then_events, actor, class_node, reply_to, bindings, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen)
        else_events = []
        if stmt.else_statement is not None:
            _walk_one(stmt.else_statement, else_events, actor, class_node, reply_to, bindings, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen)
        if _terminal(stmt.then_statement) or _terminal(stmt.else_statement) or else_events:
            _add_alt(events, _condition_label(stmt.condition), then_events, "otherwise", else_events)
        else:
            events.extend(then_events)
        return
    if isinstance(stmt, tree.TryStatement):
        try_events = []
        block = stmt.block if isinstance(stmt.block, list) else getattr(stmt.block, "statements", None) or []
        _walk_statements(block, try_events, actor, class_node, reply_to, bindings, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen)
        catch_events = []
        names = []
        for catch in stmt.catches or []:
            caught = _simple_class_name(getattr(catch.parameter, "type", None)) or "Exception"
            names.append(caught)
            body = catch.block if isinstance(catch.block, list) else getattr(catch.block, "statements", None) or []
            _walk_statements(body, catch_events, actor, class_node, reply_to, bindings, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen)
        if try_events and catch_events:
            _add_alt(events, "no " + " / ".join(names), try_events, "catch " + " / ".join(names), catch_events)
        else:
            events.extend(try_events)
            events.extend(catch_events)
        return
    if isinstance(stmt, (tree.ForStatement, tree.WhileStatement, tree.DoStatement)):
        body = stmt.body
        _walk_one(body, events, actor, class_node, reply_to, bindings, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen)
        return
    if isinstance(stmt, tree.ThrowStatement):
        events.append({"k": "msg", "src": actor, "dst": reply_to or actor, "label": _throw_label(stmt.expression, nodes), "back": True})
        counter[0] += 1
        return
    if isinstance(stmt, tree.ReturnStatement):
        _walk_expr(stmt.expression, events, actor, class_node, reply_to, bindings, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen)
        _collect_http(stmt.expression, statuses, headers)
        return
    _walk_expr(stmt, events, actor, class_node, reply_to, bindings, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen)


def _walk_expr(node, events, actor, class_node, reply_to, bindings, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen):
    if node is None or counter[0] > 120:
        return
    if isinstance(node, list):
        for item in node:
            _walk_expr(item, events, actor, class_node, reply_to, bindings, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen)
        return
    if not isinstance(node, tree.Node):
        return
    if isinstance(node, tree.LambdaExpression):
        return
    if isinstance(node, tree.MethodInvocation):
        _emit_call(node, events, actor, class_node, reply_to, bindings, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen)
        return
    if isinstance(node, tree.ClassCreator):
        _collect_http(node, statuses, headers)
        for arg in node.arguments or []:
            _walk_expr(arg, events, actor, class_node, reply_to, bindings, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen)
        return
    if isinstance(node, tree.MemberReference):
        _collect_http(node, statuses, headers)
        return
    if isinstance(node, tree.Literal):
        _collect_header(node, headers)
        return
    for child in node.children:
        _walk_expr(child, events, actor, class_node, reply_to, bindings, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen)


def _emit_call(inv, events, actor, class_node, reply_to, bindings, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen):
    if isinstance(inv.qualifier, tree.Node):
        _walk_expr(inv.qualifier, events, actor, class_node, reply_to, bindings, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen)
    member = inv.member or ""
    qualifier = _qualifier_name(inv)
    passed = _passed_lambdas(inv, bindings, class_node)
    for arg in inv.arguments or []:
        if isinstance(arg, tree.LambdaExpression):
            continue
        if _ref_name(arg) in bindings:
            continue
        _walk_expr(arg, events, actor, class_node, reply_to, bindings, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen)
    if counter[0] > 120:
        return
    if qualifier and qualifier in bindings and member in {"get", "run", "apply", "accept", "call"}:
        lam, defined_on = bindings[qualifier]
        _walk_lambda(lam, events, actor, defined_on, reply_to, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen)
        return
    if member == "createNativeQuery":
        sql = _literal((inv.arguments or [None])[0])
        if sql:
            _msg(events, counter, actor, db, sql, False)
        return
    if not qualifier or qualifier == "this":
        called = _method_named(class_node, member, _argc(inv))
        if called is not None:
            child_bindings = _bind_params(called, passed)
            events.extend(_walk_method(
                called, actor, class_node, reply_to, child_bindings, nodes, services, repositories, entities,
                outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen, True,
            ))
        return
    chain = _named_types(class_node).get(qualifier, [])
    if not chain:
        return
    simple = chain[-1]
    native = None
    target = nodes.get(simple)
    called = _method_named(target[1], member, _argc(inv)) if target else None
    if called is not None:
        native = _native_sql(called)
    if native:
        _msg(events, counter, actor, db, native, False)
        return
    outbound_name = _is_outbound_name(simple, chain, outbound)
    if outbound_name:
        _msg(events, counter, actor, outbound_name, member, False)
        return
    if simple in repositories or simple.endswith("Repository") or simple.endswith("Repo"):
        entity = repositories.get(simple)
        _msg(events, counter, actor, db, f"{simple}.{member}", False)
        if member.lower() in _WRITE or member.lower().startswith("save") or member.lower().startswith("delete"):
            guessed = entity or _repo_entity(simple)
            for trig in _matching_triggers(guessed, triggers):
                _msg(events, counter, db, db, f"trigger {trig['name']} on {trig['table']}", False)
                if trig not in used_triggers:
                    used_triggers.append(trig)
        return
    if simple not in nodes and simple not in services and not simple.endswith("Service"):
        return
    role = _project_role(simple, services, repositories, entities)
    if role == "Entity":
        return
    _msg(events, counter, actor, simple, member, False)
    if called is None or target is None:
        return
    child_bindings = _bind_params(called, passed)
    events.extend(_walk_method(
        called, simple, target[1], actor, child_bindings, nodes, services, repositories, entities,
        outbound, db, triggers, used_triggers, tx, [], [], counter, seen, False,
    ))


def _walk_lambda(lam, events, actor, class_node, reply_to, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen):
    body = lam.body
    if isinstance(body, tree.BlockStatement):
        _walk_statements(body.statements, events, actor, class_node, reply_to, {}, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen)
    else:
        _walk_expr(body, events, actor, class_node, reply_to, {}, nodes, services, repositories, entities, outbound, db, triggers, used_triggers, tx, statuses, headers, counter, seen)


def _ref_name(arg) -> str:
    if isinstance(arg, str):
        return arg
    if isinstance(arg, tree.MemberReference) and not arg.qualifier:
        return arg.member or ""
    return ""


def _passed_lambdas(inv, bindings, class_node) -> dict[int, tuple]:
    passed = {}
    for index, arg in enumerate(inv.arguments or []):
        if isinstance(arg, tree.LambdaExpression):
            passed[index] = (arg, class_node)
            continue
        name = _ref_name(arg)
        if name and name in bindings:
            passed[index] = bindings[name]
    return passed


def _bind_params(method, passed: dict[int, tuple]) -> dict:
    bound = {}
    for index, param in enumerate(method.parameters or []):
        if index in passed:
            bound[param.name] = passed[index]
    return bound


def _msg(events, counter, src, dst, label, back):
    if not src or not dst or counter[0] > 120:
        return
    events.append({"k": "msg", "src": src, "dst": dst, "label": label, "back": back})
    counter[0] += 1


def _add_alt(events, label, then_events, else_label, else_events):
    if not then_events and not else_events:
        return
    events.append({
        "k": "alt",
        "label": label or "condition",
        "then": then_events,
        "else_label": else_label,
        "else": else_events,
    })


def _terminal(stmt) -> bool:
    if stmt is None:
        return False
    if isinstance(stmt, (tree.ReturnStatement, tree.ThrowStatement)):
        return True
    if isinstance(stmt, tree.BlockStatement):
        return any(_terminal(item) for item in (stmt.statements or []))
    if isinstance(stmt, tree.IfStatement):
        return _terminal(stmt.then_statement) or _terminal(stmt.else_statement)
    return False


def _condition_label(node) -> str:
    negated = "!" in (getattr(node, "prefix_operators", None) or [])
    selectors = [item for item in (getattr(node, "selectors", None) or []) if isinstance(item, tree.MethodInvocation)]
    if isinstance(node, tree.MethodInvocation) and selectors and selectors[0].member in {"equals", "equalsIgnoreCase"}:
        left = _call_name(node)
        right = _short((selectors[0].arguments or [None])[0])
        text = f"{left} differs from {right}" if negated else f"{left} equals {right}"
        return _safe(text)
    if isinstance(node, tree.MethodInvocation):
        member = node.member or ""
        if member in {"equals", "equalsIgnoreCase"}:
            left = _short(node.qualifier)
            right = _short((node.arguments or [None])[0])
            text = f"{left} differs from {right}" if negated else f"{left} equals {right}"
            return _safe(text)
        if member == "isPresent":
            text = f"{_short(node.qualifier)} is empty" if negated else f"{_short(node.qualifier)} is present"
            return _safe(text)
        if member == "isEmpty":
            text = f"{_short(node.qualifier)} is present" if negated else f"{_short(node.qualifier)} is empty"
            return _safe(text)
    if isinstance(node, tree.BinaryOperation):
        if node.operator in {"==", "!="} and _is_null(node.operandr):
            name = _short(node.operandl)
            absent = node.operator == "=="
            if negated:
                absent = not absent
            return _safe(f"{name} is null" if absent else f"{name} is not null")
        if node.operator in {"&&", "||"}:
            left = _condition_label(node.operandl)
            right = _condition_label(node.operandr)
            joiner = " and " if node.operator == "&&" else " or "
            return _safe(f"{left}{joiner}{right}")
        left = _condition_label(node.operandl)
        right = _condition_label(node.operandr)
        if left and right and left != "condition" and right != "condition":
            return _safe(f"{left} {node.operator} {right}")
    text = "not (" + _short(node) + ")" if negated else _short(node)
    return _safe(text or "condition")


def _call_name(node) -> str:
    if not isinstance(node, tree.MethodInvocation):
        return _short(node)
    member = node.member or ""
    if member.startswith("get") and len(member) > 3:
        member = member[3:4].lower() + member[4:]
    qual = node.qualifier if isinstance(node.qualifier, str) else _short(node.qualifier)
    return f"{qual}.{member}" if qual else member


def _short(node) -> str:
    if node is None:
        return ""
    if isinstance(node, str):
        return node.split(".")[-1]
    if isinstance(node, tree.Literal):
        return (node.value or "").strip('"')[:40]
    if isinstance(node, tree.MemberReference):
        return node.member or ""
    if isinstance(node, tree.MethodInvocation):
        name = node.member or ""
        if name.startswith("get") and len(name) > 3:
            return name[3:4].lower() + name[4:]
        return name
    return ""


def _is_null(node) -> bool:
    return isinstance(node, tree.Literal) and (node.value or "") == "null"


def _throw_label(expr, nodes) -> str:
    if isinstance(expr, tree.ClassCreator):
        name = _simple_class_name(expr.type) or "Exception"
        status = _status_of(name, nodes)
        message = ""
        for arg in expr.arguments or []:
            lit = _literal(arg)
            if lit:
                message = lit.strip('"')[:60]
                break
        label = f"throw {name}"
        if status:
            label += f" {status}"
        if message:
            label += f": {message}"
        return _safe(label)
    return "throw"


def _status_of(class_name: str, nodes: dict) -> str:
    target = nodes.get(class_name)
    if not target:
        return ""
    node = target[1]
    for ann in getattr(node, "annotations", None) or []:
        if not (ann.name == "ResponseStatus" or ann.name.endswith(".ResponseStatus")):
            continue
        value = _annotation_value(node, "ResponseStatus")
        if value in _HTTP:
            return _HTTP[value]
        elem = ann.element
        if isinstance(elem, tree.MemberReference) and elem.member in _HTTP:
            return _HTTP[elem.member]
        if isinstance(elem, list):
            for pair in elem:
                if getattr(pair, "name", "") in {"value", "code"} and isinstance(getattr(pair, "value", None), tree.MemberReference):
                    if pair.value.member in _HTTP:
                        return _HTTP[pair.value.member]
    return ""


def _collect_http(node, statuses: list[str], headers: list[str]):
    if node is None:
        return
    if isinstance(node, tree.MemberReference):
        qualifier = node.qualifier if isinstance(node.qualifier, str) else ""
        if (qualifier or "").endswith("HttpStatus") and node.member in _HTTP and _HTTP[node.member] not in statuses:
            statuses.append(_HTTP[node.member])
        return
    if isinstance(node, tree.Literal):
        _collect_header(node, headers)
        return
    if isinstance(node, tree.Node):
        for child in node.children:
            _collect_http(child, statuses, headers)


def _collect_header(node, headers: list[str]):
    if not isinstance(node, tree.Literal):
        return
    text = (node.value or "").strip('"')
    if text and re.fullmatch(r"[A-Za-z]+(?:-[A-Za-z]+)+", text) and text not in headers:
        headers.append(text)


def _return_label(statuses: list[str], headers: list[str]) -> str:
    parts = []
    if statuses:
        parts.append(" or ".join(statuses))
    if headers:
        parts.append("header " + ", ".join(headers[:2]))
    if not parts:
        return ""
    return _safe("response " + ", ".join(parts))


def _literal(node) -> str:
    if isinstance(node, tree.Literal) and node.value:
        return node.value.strip('"')
    return ""


def _argc(inv) -> int | None:
    if inv.arguments is None:
        return None
    return len(inv.arguments)


def _native_sql(method) -> str:
    if method is None:
        return ""
    for _, inv in method.filter(tree.MethodInvocation):
        if (inv.member or "") != "createNativeQuery":
            continue
        return _literal((inv.arguments or [None])[0])
    return ""


def _transactional(method, class_node) -> bool:
    return _has_annotation(method, "Transactional") or _has_annotation(class_node, "Transactional")


def _transactional_readonly(method, class_node) -> bool:
    for node in (method, class_node):
        for ann in getattr(node, "annotations", None) or []:
            if not (ann.name == "Transactional" or str(ann.name).endswith(".Transactional")):
                continue
            elem = ann.element
            if isinstance(elem, list):
                for pair in elem:
                    if getattr(pair, "name", "") == "readOnly":
                        value = getattr(pair, "value", None)
                        if isinstance(value, tree.Literal) and value.value == "true":
                            return True
    return False


def _repo_entity(repository: str) -> str:
    for suffix in ("Repository", "Repo"):
        if repository.endswith(suffix) and len(repository) > len(suffix):
            return repository[: -len(suffix)]
    return ""


def _table_matches(entity: str | None, table: str) -> bool:
    if not entity or not table:
        return False
    snake = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", entity).lower()
    plural = snake[:-1] + "ies" if snake.endswith("y") else snake + "s"
    return table in {snake, plural}


def _matching_triggers(entity: str | None, triggers: list[dict]) -> list[dict]:
    return [item for item in triggers if _table_matches(entity, item["table"])]


def _safe(text: str) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    text = text.replace(";", ",").replace("#", "").replace('"', "'")
    return text[:110]


def _render_sequence(events, db: str) -> str:
    if not events:
        return ""
    names = []

    def add(name: str):
        if name and name not in names:
            names.append(name)

    def walk(items):
        for item in items:
            if item["k"] == "msg":
                add(item["src"])
                add(item["dst"])
            else:
                walk(item["then"])
                walk(item["else"])

    walk(events)
    ordered = [name for name in names if name not in {"Client", db}]
    if "Client" in names:
        ordered.insert(0, "Client")
    if db in names:
        ordered.append(db)
    lines = ["sequenceDiagram"]
    for name in ordered:
        lines.append(f"    participant {name}")
    _render_events(events, lines, 1)
    return "\n".join(lines)


def _render_events(events, lines, indent: int):
    pad = "    " * indent
    for item in events:
        if item["k"] == "msg":
            arrow = "-->>" if item["back"] else "->>"
            lines.append(f"{pad}{item['src']}{arrow}{item['dst']}: {_safe(item['label'])}")
        else:
            lines.append(f"{pad}alt {_safe(item['label'])}")
            _render_events(item["then"], lines, indent + 1)
            if item["else"]:
                lines.append(f"{pad}else {_safe(item['else_label'])}")
                _render_events(item["else"], lines, indent + 1)
            lines.append(f"{pad}end")


def _render_transaction(labels: list[str]) -> str:
    write = [label for label in labels if "readOnly" not in label]
    if not write:
        return ""
    title = _safe(write[0])
    return "\n".join([
        "flowchart TD",
        f"    START[\"{title}\"] --> WORK[\"the calls in this route run inside the transaction\"]",
        "    WORK --> OK{runtime error?}",
        "    OK -->|No| COMMIT[\"COMMIT\"]",
        "    OK -->|Yes| ROLL[\"ROLLBACK\"]",
        "    style COMMIT fill:#d4edda,stroke:#0e7a3d,color:#0a0b14",
        "    style ROLL fill:#f8d7da,stroke:#9f1239,color:#0a0b14",
    ])


def _render_trigger(triggers: list[dict], db: str) -> str:
    interesting = [item for item in triggers if item["raises"] or item["checks_sum"]]
    if not interesting:
        return ""
    lines = ["flowchart TD"]
    for index, item in enumerate(interesting[:3]):
        check_bits = []
        if item["checks_sum"]:
            check_bits.append("sum of amounts")
        if item["raises"]:
            check_bits.append(_safe(item["raises"][0]))
        label = _safe(f"{item['name']}: {' / '.join(check_bits) or item['name']}")
        lines.extend([
            f"    W{index}[\"write {item['table']}\"] --> C{index}{{\"{label}\"}}",
            f"    C{index} -->|passes| OK{index}[\"trigger allows the write\"]",
            f"    C{index} -->|RAISE| BAD{index}[\"trigger rejects the write\"]",
            f"    style OK{index} fill:#d4edda,stroke:#0e7a3d,color:#0a0b14",
            f"    style BAD{index} fill:#f8d7da,stroke:#9f1239,color:#0a0b14",
        ])
    return "\n".join(lines)
