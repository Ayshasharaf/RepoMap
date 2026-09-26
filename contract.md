RepoMap: POST a public GitHub URL, shallow-clone, scan Spring Boot Java, return one JSON. Same file tree always yields the same JSON bytes.

Key order: service, commit, summary, entities, relations, endpoints, findings, counts, diagrams.
counts: scopeGaps, nPlusOne, brokenRelations, score, risk.
finding: kind, file, symbol, detail. kind is scope_gap, n_plus_one, or broken_relation.
entity: name, tenantOwned. relation: from, to, kind, broken, reason. endpoint: method, path, entity, scopeGap.
diagrams: architecture, erd, connections. Mermaid strings.

Rules: tenant-owned means a field named tenantId. Scope gap: a repository method on a tenant-owned entity returns it with no tenantId parameter, or a controller calls that method and has no @PreAuthorize. N+1: a for/while contains a call whose name starts with find or get, or a collection is FetchType.EAGER. Broken relation: mappedBy or @JoinColumn names a missing field on the target. score = scopeGaps*5 + nPlusOne*2 + brokenRelations*2. High if scopeGaps>=3, else Medium if score>=4, else Low. Link types by simple class name.

Sort every list by name, then file, then symbol. json.dumps(sort_keys=True, indent=2) and a trailing newline. No timestamps, uuids, or absolute paths. commit is the git SHA, or "local".

GitHub: public https://github.com/owner/repo only. Strip .git and /tree or /blob. Shallow clone, 45s, delete the temp dir. No Java, or no @Entity, or more than 500 Java files: risk Unscored, zero counts, one finding with the reason. Never fetch a host other than github.com.

Out: sample apps, databases, React Flow, other languages.
