/**
 * flow.ts
 *
 * Reads the `%% flow\t…` comment lines that scan.py embeds in every
 * architecture Mermaid string and turns them into typed objects that the
 * UI can display in the "Data flow" detail panel.
 *
 * Line format (7 tab-separated columns, all produced by _class_comment_lines):
 *
 *   %% flow \t name \t role \t file \t kind \t member_name \t note
 *
 *   kind = "class"   → class-level note (member_name and note may be empty)
 *   kind = "method"  → a method on the class
 *   kind = "field"   → a field on an Entity
 */

export interface FlowMember {
  kind: "method" | "field";
  name: string;
  note: string;
}

export interface FlowClass {
  name: string;
  role: string;
  file: string;
  note: string;
  members: FlowMember[];
}

/**
 * Parse `%% flow\t...` comment lines from a Mermaid architecture string.
 * Returns one FlowClass per unique (name, role) pair, in the order first seen.
 * Returns [] for old scans that pre-date the embedded metadata.
 */
export function parseFlow(mermaid: string): FlowClass[] {
  if (!mermaid) return [];

  const map = new Map<string, FlowClass>();

  for (const raw of mermaid.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("%% flow\t")) continue;

    // Strip the "%% flow\t" prefix then split on tabs
    const cols = line.slice("%% flow\t".length).split("\t");
    // Pad to 7 columns so destructuring is always safe
    while (cols.length < 7) cols.push("");

    const [name, role, file, kind, memberName, note] = cols;
    if (!name) continue;

    const key = name;
    if (!map.has(key)) {
      map.set(key, { name, role, file, note: "", members: [] });
    }
    const entry = map.get(key)!;

    if (kind === "class") {
      // class-level note (may be empty — that's fine)
      if (note) entry.note = note;
    } else if (kind === "method" || kind === "field") {
      // avoid duplicates (same member can appear in multiple chain steps)
      const dupKey = `${kind}:${memberName}`;
      if (!entry.members.some((m) => `${m.kind}:${m.name}` === dupKey)) {
        entry.members.push({ kind, name: memberName, note });
      }
    }
  }

  return Array.from(map.values());
}

export interface FlowHop {
  role: string;
  name: string;
}

export interface FlowPath {
  kind: "request" | "job";
  entry: string;
  hops: FlowHop[];
}

/** One line per route: %% path \t kind \t entry \t Role|Class \t ... */
export function parsePaths(mermaid: string): FlowPath[] {
  if (!mermaid) return [];
  const paths: FlowPath[] = [];
  for (const raw of mermaid.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("%% path\t")) continue;
    const cols = line.slice("%% path\t".length).split("\t");
    const kind = cols[0] === "job" ? "job" : "request";
    const entry = cols[1] || "";
    const hops: FlowHop[] = [];
    for (const cell of cols.slice(2)) {
      const [role, name] = cell.split("|");
      if (!name) continue;
      hops.push({ role: role || "Code", name });
    }
    if (entry) paths.push({ kind, entry, hops });
  }
  return paths;
}
