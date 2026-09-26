"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ScanResult, RepoMeta } from "@/lib/types";
import type { FlowClass, FlowPath } from "@/lib/flow";
import { parseFlow, parsePaths, parseStories } from "@/lib/flow";
import MermaidDiagram from "./MermaidDiagram";

function kindLabel(kind: string) {
  return { scope_gap: "Scope gap", n_plus_one: "N+1", broken_relation: "Broken rel." }[kind] ?? kind;
}

type SectionId = "overview" | "modules" | "flow" | "deps" | "entry" | "critical" | "health" | "checklist";

const NAV = [
  { id: "overview", label: "Overview", hint: "What this repo is" },
  { id: "modules", label: "Architecture", hint: "Modules and imports" },
  { id: "flow", label: "Data flow", hint: "The full call chain" },
  { id: "deps", label: "Dependencies", hint: "Libraries and links" },
  { id: "entry", label: "Entry points", hint: "How to run it" },
  { id: "critical", label: "Critical paths", hint: "Routes with findings" },
  { id: "health", label: "Health", hint: "Tests, CI, GitHub" },
] as const;

const PREVIEWS = [
  { label: "Overview", hint: "What this repo is, before any diagram.", sketch: "cover" },
  { label: "Architecture", hint: "Modules by responsibility, and how they import each other.", sketch: "rooms" },
  { label: "Data flow", hint: "Each route as a line of stops, from the request to storage.", sketch: "rail" },
  { label: "Dependencies", hint: "Libraries on shelves, named by what they are for.", sketch: "shelves" },
  { label: "Entry points", hint: "The class that starts it, and the command that runs it.", sketch: "term" },
  { label: "Critical paths", hint: "Only the routes that sit next to a finding.", sketch: "risk" },
  { label: "Health", hint: "Tests, CI, stars, and what this clone cannot know.", sketch: "signals" },
] as const;

const MODULE_LABEL: Record<string, string> = {
  api: "API",
  services: "Services",
  data: "Data",
  workers: "Workers",
  outbound: "Outbound",
  auth: "Auth",
  config: "Config",
  app: "Other",
};

const MODULE_ABOUT: Record<string, string> = {
  api: "The URLs this app exposes.",
  services: "The classes that do the work.",
  data: "Stored records and the repositories that load them.",
  workers: "Jobs and message listeners.",
  outbound: "Calls out to another system.",
  auth: "Sign-in and access rules.",
  config: "Spring setup.",
  app: "DTOs, exceptions, and classes that are not one of the groups above.",
};

function findingClass(symbol: string) {
  if (!symbol) return "";
  const dot = symbol.indexOf(".");
  return dot === -1 ? symbol : symbol.slice(0, dot);
}

function findingsForPath(path: FlowPath, findings: ScanResult["findings"]) {
  return findings.filter((finding) => {
    const owner = findingClass(finding.symbol);
    const onHop = Boolean(owner) && path.hops.some((hop) => hop.name === owner);
    const onRoute = Boolean(path.entry) && Boolean(finding.detail) && finding.detail.includes(path.entry);
    return onHop || onRoute;
  });
}

export default function Dashboard({ initialScans }: { initialScans: ScanResult[] }) {
  const [scans, setScans] = useState<ScanResult[]>(initialScans);
  const [selected, setSelected] = useState<ScanResult | null>(initialScans[0] ?? null);
  const [section, setSection] = useState<SectionId>("overview");
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleScan(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/scan-github", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.detail ?? data?.error ?? `Error ${res.status}`);
      } else {
        const result = data as ScanResult;
        setScans((prev) => [result, ...prev.filter((s) => s.service !== result.service)]);
        setSources((prev) => ({ ...prev, [result.service]: trimmed }));
        setSelected(result);
        setSection("overview");
        setUrl("");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      {!selected ? (
        <>
        <section className="plaque">
          <div className="plaque-inner">
            <div className="kicker">Paste a repo</div>
            <h1>See how it is built.</h1>
            <p>Map a public GitHub repository. Then choose Overview, Architecture, Data flow, Dependencies, Entry points, Critical paths, or Health.</p>
            <form className="scan-form" onSubmit={handleScan}>
              <input
                ref={inputRef}
                type="text"
                placeholder="https://github.com/owner/repo"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={loading}
                aria-label="GitHub repository URL"
              />
              <button className="btn-solid" type="submit" disabled={loading || !url.trim()}>
                {loading ? "Mapping…" : "Map it"}
              </button>
            </form>
            {error && <div className="error">{error}</div>}
          </div>
        </section>
        <section className="previews">
          <p className="section-kicker">After you map it</p>
          <h2>Seven readings of the same repo.</h2>
          <div className="preview-grid">
            {PREVIEWS.map((item) => (
              <article className="preview" key={item.label}>
                <div className={`sketch sketch-${item.sketch}`} aria-hidden="true">
                  {item.sketch === "cover" && (
                    <>
                      <i /><i /><i /><i />
                    </>
                  )}
                  {item.sketch === "rooms" && (
                    <>
                      <b>API</b><b>Services</b><b>Data</b>
                    </>
                  )}
                  {item.sketch === "rail" && (
                    <>
                      <span /><span /><span />
                    </>
                  )}
                  {item.sketch === "shelves" && (
                    <>
                      <em>Database</em><em>Queue</em><em>Auth</em>
                    </>
                  )}
                  {item.sketch === "term" && <code>./mvnw spring-boot:run</code>}
                  {item.sketch === "risk" && (
                    <>
                      <span /><span className="is-hot" /><span />
                    </>
                  )}
                  {item.sketch === "signals" && (
                    <>
                      <s /><s className="is-off" /><s />
                    </>
                  )}
                </div>
                <strong>{item.label}</strong>
                <span>{item.hint}</span>
              </article>
            ))}
          </div>
        </section>
        </>
      ) : (
        <>
          <header className="command">
            <div className="command-inner">
              <div className="command-brand">Repo Map</div>
              <form className="scan-form" onSubmit={handleScan}>
                <input
                  ref={inputRef}
                  type="text"
                  placeholder="https://github.com/owner/repo"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={loading}
                  aria-label="GitHub repository URL"
                />
                <button className="btn-solid" type="submit" disabled={loading || !url.trim()}>
                  {loading ? "Mapping…" : "Map it"}
                </button>
              </form>
            </div>
          </header>
          {error && <div className="error band-error">{error}</div>}
          {scans.length > 1 && (
            <div className="repo-row">
              {scans.map((scan) => (
                <button
                  key={scan.service}
                  type="button"
                  className={selected.service === scan.service ? "repo-pill is-on" : "repo-pill"}
                  onClick={() => {
                    setSelected(scan);
                    setSection("overview");
                  }}
                >
                  {scan.service}
                </button>
              ))}
            </div>
          )}
          <nav className="choices" aria-label="What to show">
            {NAV.map((item) => (
              <button
                key={item.id}
                type="button"
                className={section === item.id ? "choice is-on" : "choice"}
                aria-current={section === item.id ? "page" : undefined}
                onClick={() => setSection(item.id)}
              >
                <strong>{item.label}</strong>
                <span>{item.hint}</span>
              </button>
            ))}
          </nav>
          <DetailPanel
            scan={selected}
            sourceUrl={sources[selected.service]}
            section={section}
          />
        </>
      )}
    </div>
  );
}

function sequenceFromPath(path: FlowPath | undefined) {
  if (!path) return "sequenceDiagram\n    participant Client";
  const label = path.entry.replace(/:/g, " ");
  const ids = path.hops.map((hop, index) => `${hop.name.replace(/[^\w]/g, "_")}_${index}`);
  const lines = [
    "sequenceDiagram",
    "    participant Client",
    ...path.hops.map((hop, index) => `    participant ${ids[index]} as ${hop.name}`),
  ];
  if (!ids.length) {
    lines.push(`    Client->>Client: ${label}`);
    return lines.join("\n");
  }
  lines.push(`    Client->>${ids[0]}: ${label}`);
  for (let index = 1; index < ids.length; index += 1) {
    lines.push(`    ${ids[index - 1]}->>${ids[index]}: ${path.hops[index].role}`);
  }
  return lines.join("\n");
}

function noteClass(note: string) {
  if (note.includes("tenant")) return "mark mark-tenant";
  if (note.startsWith("calls ") || note.startsWith("sends ")) return "mark mark-call";
  return "mark";
}

function MethodPanel({ item }: { item: FlowClass }) {
  const heading = item.role === "Entity" ? "Fields" : "Methods";
  return (
    <div className="method-panel">
      <h5>
        {item.name}
        <span className="role">{item.role}</span>
      </h5>
      {item.file && <p className="file">{item.file}</p>}
      {item.note && <p>{item.note}</p>}
      {item.members.length > 0 && (
        <>
          <p className="method-heading">{heading}</p>
          {item.members.map((member) => (
            <div className="method-row" key={`${member.kind}-${member.name}`}>
              <span className="mono">{member.name}</span>
              <span>
                {member.note.split(" · ").filter(Boolean).map((part) => (
                  <span className={noteClass(part)} key={part}>{part}</span>
                ))}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function hopTone(role: string) {
  if (role === "Entity" || role === "Repository") return "db";
  if (role === "Outbound") return "exit";
  if (role === "Listener" || role === "Job" || role === "Scheduler") return "async";
  return "sync";
}

function FlowBoard({
  paths,
  classes,
  picked,
  onPick,
  findings,
}: {
  paths: FlowPath[];
  classes: FlowClass[];
  picked: string | null;
  onPick: (name: string) => void;
  findings?: ScanResult["findings"];
}) {
  return (
    <div className="rails">
      {paths.map((path, pathIndex) => {
        const notes = findingsForPath(path, findings ?? []);
        const openName = picked?.startsWith(`${pathIndex}::`) ? picked.slice(picked.indexOf("::") + 2) : "";
        const open = openName ? classes.find((item) => item.name === openName) ?? null : null;
        return (
          <article className={notes.length ? "rail is-risk" : "rail"} key={`${path.kind}-${path.entry}-${pathIndex}`}>
            <div className="rail-head">
              <span>{path.kind === "job" ? "Schedule or message" : "Request"}</span>
              <strong>{path.entry}</strong>
            </div>
            <div className="rail-line">
              {path.hops.map((hop, index) => (
                <span className="station-wrap" key={`${hop.role}-${hop.name}-${index}`}>
                  {index > 0 && <i className={`join join-${hopTone(hop.role)}`} aria-hidden="true" />}
                  <button
                    type="button"
                    className={["station", `st-${hopTone(hop.role)}`, picked === `${pathIndex}::${hop.name}` ? "is-on" : ""].filter(Boolean).join(" ")}
                    onClick={() => onPick(`${pathIndex}::${hop.name}`)}
                  >
                    <small>{hop.role}</small>
                    {hop.name}
                  </button>
                </span>
              ))}
            </div>
            {open && <MethodPanel item={open} />}
            {notes.map((finding, index) => (
              <p className="rail-note" key={`${finding.kind}-${index}`}>
                <span className={`tag tag-${finding.kind}`}>{kindLabel(finding.kind)}</span>
                {finding.detail}
              </p>
            ))}
          </article>
        );
      })}
    </div>
  );
}

function moduleName(id: string) {
  return MODULE_LABEL[id] ?? id;
}

const DEP_ACCENT: Record<string, string> = {
  "Web / API":      "var(--blue)",
  "Data":           "#0e7a3d",
  "Security":       "#9a3412",
  "Messaging":      "#4b5bd4",
  "Testing":        "#7c3aed",
  "Observability":  "#0369a1",
  "Cloud":          "#0891b2",
  "Utilities":      "#57606a",
};

function depAccent(purpose: string): string {
  for (const [key, color] of Object.entries(DEP_ACCENT)) {
    if (purpose.toLowerCase().includes(key.toLowerCase().split(" / ")[0].toLowerCase())) {
      return color;
    }
  }
  return "var(--blue-deep)";
}

function Dependencies({ scan }: { scan: ScanResult }) {
  const deps = scan.overview?.dependencies;
  if (!deps) return <p className="summary">Map this repo again to read its build files.</p>;

  if (deps.external.length === 0) {
    return <p className="summary">No libraries found in the build file.</p>;
  }

  const groups = new Map<string, string[]>();
  for (const dep of deps.external) {
    const list = groups.get(dep.usedFor) ?? [];
    list.push(dep.name);
    groups.set(dep.usedFor, list);
  }
  const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  return (
    <div className="dep-grid">
      {ranked.map(([purpose, names]) => {
        const accent = depAccent(purpose);
        return (
          <div className="dep-card" key={purpose} style={{ "--dep-accent": accent } as React.CSSProperties}>
            <div className="dep-card-head">
              <span className="dep-dot" aria-hidden="true" />
              <strong>{purpose}</strong>
              <span className="dep-count">{names.length}</span>
            </div>
            <ul className="dep-libs">
              {names.map((name) => (
                <li key={name}><code>{name}</code></li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function Runbook({ scan }: { scan: ScanResult }) {
  const entries = scan.overview?.entryPoints ?? [];
  const steps = scan.overview?.checklist ?? [];
  if (!scan.overview) return <p className="summary">Map this repo again to see how it starts.</p>;
  const starts = entries.filter((entry) => entry.detail.includes("Spring Boot application") || entry.name === "Docker");
  const commands = steps.filter((step) => step.title !== "Set environment variables" && step.title !== "No setup file found");
  const env = steps.find((step) => step.title === "Set environment variables");
  const missing = steps.find((step) => step.title === "No setup file found");
  return (
    <div className="runbook">
      <div className="starts">
        {starts.length === 0 && <p className="summary">No @SpringBootApplication class was found.</p>}
        {starts.map((entry) => (
          <article className="start-card" key={`${entry.name}-${entry.detail}`}>
            <span>{entry.name === "Docker" ? "Container" : "Process starts in"}</span>
            <strong>{entry.name}</strong>
            <code>{entry.detail}</code>
          </article>
        ))}
      </div>
      {commands.length > 0 && (
        <div className="run-grid">
          {commands.map((step, index) => (
            <article className="run-card" key={`${step.title}-${step.detail}`}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <small>{step.title}</small>
              <code>{step.detail}</code>
            </article>
          ))}
        </div>
      )}
      {env && (
        <div className="env-block">
          <h3>Environment</h3>
          <div className="env-grid">
            {env.detail.split(", ").map((name) => <code key={name}>{name}</code>)}
          </div>
        </div>
      )}
      {missing && <p className="summary">{missing.detail}</p>}
    </div>
  );
}

function HealthBoard({ scan, meta }: { scan: ScanResult; meta: RepoMeta | null }) {
  const health = scan.overview?.health;
  const tests = health?.testFiles ?? 0;
  const workflows = health?.workflows ?? [];
  const signals = [
    {
      name: "Tests",
      state: tests > 0 ? "ok" : "miss",
      detail: tests > 0 ? `${tests} Java file${tests === 1 ? "" : "s"} under src/test` : "No Java files under src/test",
    },
    {
      name: "CI",
      state: workflows.length > 0 ? "ok" : "miss",
      detail: workflows.length > 0 ? workflows.join(", ") : "No GitHub workflow, Jenkinsfile, or GitLab CI file",
    },
    {
      name: "Coverage",
      state: health?.coverage ? "ok" : "unknown",
      detail: health?.coverage || "No JaCoCo config in the Maven or Gradle files",
    },
    {
      name: "Stars",
      state: meta?.stars != null ? "ok" : "unknown",
      detail: meta?.stars != null ? `${meta.stars.toLocaleString()} on GitHub` : "GitHub did not return a star count for this URL",
    },
    {
      name: "Open issues",
      state: meta?.openIssues != null ? "ok" : "unknown",
      detail: meta?.openIssues != null ? `${meta.openIssues.toLocaleString()} open` : "GitHub did not return an issue count",
    },
    {
      name: "Last push",
      state: meta?.pushedAt ? "ok" : "unknown",
      detail: meta?.pushedAt || "No push date from GitHub",
    },
    {
      name: "Churn",
      state: "unknown",
      detail: health?.churn || "Only the latest commit is cloned, so the files that change most often are not in this scan.",
    },
  ];
  return (
    <ul className="signals">
      {signals.map((signal) => (
        <li key={signal.name}>
          <i className={`dot dot-${signal.state}`} aria-hidden="true" />
          <strong>{signal.name}</strong>
          <span>{signal.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function DetailPanel({
  scan,
  sourceUrl,
  section,
}: {
  scan: ScanResult;
  sourceUrl?: string;
  section: SectionId;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [meta, setMeta] = useState<RepoMeta | null>(null);
  const flowClasses = useMemo(() => parseFlow(scan.diagrams.architecture), [scan.diagrams.architecture]);
  const paths = useMemo(() => parsePaths(scan.diagrams.architecture), [scan.diagrams.architecture]);
  const stories = useMemo(() => parseStories(scan.diagrams.architecture), [scan.diagrams.architecture]);
  const [routeIndex, setRouteIndex] = useState(0);
  const overview = scan.overview;

  useEffect(() => {
    setPicked(null);
    setRouteIndex(0);
  }, [scan.service, scan.commit]);

  useEffect(() => {
    if (!sourceUrl) {
      setMeta(null);
      return;
    }
    let cancel = false;
    fetch(`/repo-meta?url=${encodeURIComponent(sourceUrl)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancel) setMeta(data);
      })
      .catch(() => {
        if (!cancel) setMeta(null);
      });
    return () => {
      cancel = true;
    };
  }, [sourceUrl]);

  const criticalPaths = paths.filter((path) => {
    if (findingsForPath(path, scan.findings).length > 0) return true;
    return scan.endpoints.some((endpoint) => endpoint.scopeGap && endpoint.path && path.entry.includes(endpoint.path));
  });

  const pageTitle: Record<Exclude<SectionId, "overview">, { title: string; hint: string }> = {
    modules: { title: "Architecture", hint: "Each card is a group of classes. The diagram under them is only the stored records." },
    flow: { title: "Data flow", hint: "Pick a route. The sequence is the order of calls. Branches are the if and catch paths in the code. The transaction and trigger charts appear only when this route has them." },
    deps: { title: "Dependencies", hint: "Which group uses which, then the libraries in the build file." },
    entry: { title: "Entry points", hint: "If you want to run this, start here." },
    critical: { title: "Critical paths", hint: "A route is listed when a finding names a class that route calls, or when that URL is marked as missing tenant scope." },
    checklist: { title: "Entry points", hint: "If you want to run this, start here." },
    health: { title: "Health", hint: "Test files and CI workflows from the repo. Stars and open issues from GitHub." },
  };

  return (
    <div className="canvas">
      {section === "overview" ? (
        <OverviewBoard scan={scan} meta={meta} paths={paths} />
      ) : (
        <>
          <h1>{pageTitle[section].title}</h1>
          <p className="lede">{pageTitle[section].hint}</p>
          <section className="diagram-block">
        {section === "modules" && (
          overview?.modules?.length ? (
            <>
              <div className="arch-grid">
                {overview.modules.map((mod) => (
                  <article className={`arch-card mod-${mod.id}`} key={mod.id}>
                    <header>
                      <b>{moduleName(mod.id)}</b>
                      <span>{MODULE_ABOUT[mod.id] ?? mod.label}</span>
                    </header>
                    <div className="chips">
                      {(mod.classes ?? []).map((name) => <code key={name}>{name}</code>)}
                    </div>
                  </article>
                ))}
              </div>
              {scan.diagrams.erd && (
                <div className="erd-block">
                  <h3>Stored records</h3>
                  <p className="quiet">Each box is an @Entity. A line is a field that points at another entity.</p>
                  <MermaidDiagram chart={scan.diagrams.erd} id={`${scan.service}-erd`} />
                </div>
              )}
            </>
          ) : (
            <p className="summary">Map this repo again to group the code into modules.</p>
          )
        )}
        {section === "flow" && (
          paths.length > 0 ? (
            <>
              <div className="chart-switch" role="tablist" aria-label="Route">
                {paths.map((path, index) => (
                  <button
                    key={`${path.entry}-${index}`}
                    type="button"
                    className={routeIndex === index ? "tab is-on" : "tab"}
                    onClick={() => { setRouteIndex(index); setPicked(null); }}
                  >
                    {path.entry}
                  </button>
                ))}
              </div>
              <h3 className="map-title">Sequence</h3>
              <MermaidDiagram
                chart={stories[routeIndex]?.sequence || sequenceFromPath(paths[routeIndex])}
                id={`${scan.service}-seq-${routeIndex}`}
              />
              {stories[routeIndex]?.transaction && (
                <>
                  <h3 className="map-title">Transaction</h3>
                  <MermaidDiagram chart={stories[routeIndex].transaction} id={`${scan.service}-tx-${routeIndex}`} />
                </>
              )}
              {stories[routeIndex]?.trigger && (
                <>
                  <h3 className="map-title">Database trigger</h3>
                  <MermaidDiagram chart={stories[routeIndex].trigger} id={`${scan.service}-trig-${routeIndex}`} />
                </>
              )}
              <FlowBoard paths={[paths[routeIndex]]} classes={flowClasses} picked={picked} onPick={setPicked} />
              {!picked && <p className="summary">Select a stop to read its methods.</p>}
            </>
          ) : (
            <p className="summary">Map this repo again. This result has no per-route trace yet.</p>
          )
        )}
        {section === "deps" && (
          <Dependencies scan={scan} />
        )}
        {section === "entry" && (
          <Runbook scan={scan} />
        )}
        {section === "critical" && (
          <>
            <ul className="rule">
              <li><b>N+1</b> A query runs inside a loop, on a class this route calls.</li>
              <li><b>Scope gap</b> A repository method returns a tenant-owned record without a tenant id, or the URL is marked as missing scope.</li>
              <li><b>Broken relation</b> An entity this route touches points at another entity in a way the fields do not match.</li>
            </ul>
            {criticalPaths.length > 0 ? (
              <FlowBoard paths={criticalPaths} classes={flowClasses} picked={picked} onPick={setPicked} findings={scan.findings} />
            ) : (
              <p className="summary">{scan.findings.length === 0 ? "No findings on this repo, so no route is marked critical." : "Findings exist, but none of them name a class on a traced route."}</p>
            )}
          </>
        )}
        {section === "health" && <HealthBoard scan={scan} meta={meta} />}
          </section>
        </>
      )}
    </div>
  );
}

function RichLine({ text }: { text: string }) {
  const clean = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*/g;
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of clean.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(clean.slice(last, start));
    if (match[1] != null) nodes.push(<strong key={index}>{match[1]}</strong>);
    else if (match[2] != null) nodes.push(<code key={index}>{match[2]}</code>);
    else if (match[3] != null) nodes.push(<em key={index}>{match[3]}</em>);
    last = start + match[0].length;
    index += 1;
  }
  if (last < clean.length) nodes.push(clean.slice(last));
  return <>{nodes}</>;
}

function OverviewBoard({
  scan,
  meta,
  paths,
}: {
  scan: ScanResult;
  meta: RepoMeta | null;
  paths: FlowPath[];
}) {
  const overview = scan.overview;
  const identity = overview?.identity;
  const why = identity?.why || meta?.description || "";
  const libraries = overview?.dependencies.external.length ?? 0;
  const run = overview?.checklist.find((step) => step.title === "Run locally")?.detail
    || overview?.checklist.find((step) => step.title === "Tests")?.detail
    || "";
  const figures: { value: string; label: string; tone?: string }[] = [
    { value: String(paths.length || scan.endpoints.length), label: paths.length ? "Routes" : "Endpoints" },
    { value: String(scan.entities.length), label: "Entities" },
    { value: String(libraries), label: "Libraries" },
  ];
  if (scan.counts.scopeGaps) figures.push({ value: String(scan.counts.scopeGaps), label: "Scope gaps", tone: "hot" });
  if (scan.counts.nPlusOne) figures.push({ value: String(scan.counts.nPlusOne), label: "N+1", tone: "hot" });
  if (scan.counts.brokenRelations) figures.push({ value: String(scan.counts.brokenRelations), label: "Broken relations", tone: "hot" });
  const metaBits = [
    identity?.language || meta?.language || "",
    (identity?.stack ?? []).join(", "),
    identity?.license || meta?.license || "",
    scan.commit ? scan.commit.slice(0, 12) : "",
    meta?.stars != null ? `${formatCount(meta.stars)} stars` : "",
    meta?.contributors != null ? `${formatCount(meta.contributors)} contributors` : "",
    meta?.pushedAt ? `pushed ${meta.pushedAt}` : "",
    run,
  ].filter(Boolean);

  return (
    <div className="cover">
      <div className="cover-head">
        <p className="repo-name">Overview</p>
        <h1>{scan.service}</h1>
      </div>
      {why && <p className="why"><RichLine text={why} /></p>}
      <div className="figures">
        {figures.map((item) => (
          <div className={item.tone ? `figure is-${item.tone}` : "figure"} key={item.label}>
            <b>{item.value}</b>
            <span>{item.label}</span>
          </div>
        ))}
      </div>
      {metaBits.length > 0 && <p className="cover-meta">{metaBits.join("  ·  ")}</p>}
    </div>
  );
}

function formatCount(value: number) {
  if (value >= 1000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}
