RepoMap: POST a public GitHub URL, shallow-clone, scan Spring Boot Java, return one JSON. Same file tree always yields the same JSON bytes.

Key order: service, commit, summary, entities, relations, endpoints, findings, counts, diagrams.
counts: scopeGaps, nPlusOne, brokenRelations, score, risk.
finding: kind, file, symbol, detail. kind is scope_gap, n_plus_one, broken_relation, parse_error, or incomplete. parse_error and incomplete do not change score or risk.
entity: name, tenantOwned. relation: from, to, kind, broken, reason. endpoint: method, path, entity, scopeGap.
diagrams: architecture, erd, connections. Mermaid strings.

Rules: tenant-owned means a field named tenantId. Scope gap: a repository method on a tenant-owned entity returns it with no tenantId parameter, or a controller calls that method and has no @PreAuthorize. N+1: a for/while contains a call whose name starts with find or get, or a collection is FetchType.EAGER. Broken relation: mappedBy or @JoinColumn names a missing field on the target. score = scopeGaps*5 + nPlusOne*2 + brokenRelations*2. High if scopeGaps>=3, else Medium if score>=4, else Low. Link types by simple class name.

Sort every list by name, then file, then symbol. json.dumps(sort_keys=True, indent=2) and a trailing newline. No timestamps, uuids, or absolute paths. commit is the git SHA, or "local".

GitHub: public https://github.com/owner/repo only. Strip .git and /tree or /blob. Shallow clone, 45s, delete the temp dir. No Java, or no @Entity: risk Unscored, zero counts, one finding with the reason. Java file cap defaults to 2500 (REPOMAP_MAX_JAVA_FILES). Above the cap, whole Maven or Gradle modules are included in path order until the cap is reached. A module that does not fit is an incomplete finding, not an Unscored repo. If every module is over the cap, the smallest module is scanned up to the cap. A Java file that fails to parse is a parse_error finding. Never fetch a host other than github.com.

Out: sample apps, databases, React Flow, other languages.
