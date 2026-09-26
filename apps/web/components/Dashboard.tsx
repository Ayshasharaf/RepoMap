"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ScanResult, RepoMeta } from "@/lib/types";
import type { FlowClass, FlowPath } from "@/lib/flow";
import { parseFlow, parsePaths } from "@/lib/flow";
import MermaidDiagram from "./MermaidDiagram";

function kindLabel(kind: string) {
  return { scope_gap: "Scope gap", n_plus_one: "N+1", broken_relation: "Broken rel." }[kind] ?? kind;
}

export default function Dashboard({ initialScans }: { initialScans: ScanResult[] }) {
  const [scans, setScans] = useState<ScanResult[]>(initialScans);
  const [selected, setSelected] = useState<ScanResult | null>(null);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (selected) window.scrollTo({ top: 0, behavior: "smooth" });
  }, [selected]);

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
        setUrl("");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }

  function goHome() {
    setSelected(null);
    window.setTimeout(() => inputRef.current?.focus(), 50);
  }

  return (
    <div>
      <header className="topbar">
        <div className="topbar-inner">
          <button type="button" className="brand" onClick={goHome}>
            RepoMap
          </button>
          {scans.length > 0 && (
            <nav className="service-switch" aria-label="Scanned services">
              {scans.map((scan) => {
                const on = selected?.service === scan.service;
                return (
                  <button
                    key={scan.service}
                    type="button"
                    className={on ? "service-chip is-on" : "service-chip"}
                    aria-current={on ? "page" : undefined}
                    onClick={() => setSelected(scan)}
                  >
                    {scan.service}
                    <span className={`risk risk-${scan.counts.risk}`}>{scan.counts.risk}</span>
                  </button>
                );
              })}
            </nav>
          )}
        </div>
      </header>

      {selected ? (
        <DetailPanel scan={selected} onHome={goHome} sourceUrl={sources[selected.service]} />
      ) : (
        <Home
          scans={scans}
          url={url}
          setUrl={setUrl}
          loading={loading}
          error={error}
          inputRef={inputRef}
          onScan={handleScan}
          onOpen={setSelected}
        />
      )}
    </div>
  );
}

function Home({
  scans,
  url,
  setUrl,
  loading,
  error,
  inputRef,
  onScan,
  onOpen,
}: {
  scans: ScanResult[];
  url: string;
  setUrl: (value: string) => void;
  loading: boolean;
  error: string | null;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onScan: (e: React.FormEvent) => void;
  onOpen: (scan: ScanResult) => void;
}) {
  return (
    <>
      <header className="plaque">
        <div className="plaque-inner">
          <div className="kicker">01 / scan</div>
          <h1>RepoMap</h1>
          <p>Paste a public GitHub repo. RepoMap reads the Spring Boot code and draws how data moves through the service.</p>
          <form className="scan-form" onSubmit={onScan}>
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
              {loading ? "Scanning…" : "Scan"}
            </button>
          </form>
          <p className="form-note">Scan clones that public repo and looks for entities, endpoints, and risky data access. It does not change the repository.</p>
          {error && <div className="error">{error}</div>}
        </div>
      </header>

      <section className="section">
        <div className="section-kicker">02 / results</div>
        <h2>Scans</h2>
        <p className="section-lead">Open a service. The bar keeps Identity, Modules, Data flow, and the setup list in reach.</p>
        <div className="key">
          <span><strong>Scope gaps</strong> — a query returns tenant data with no tenant id</span>
          <span><strong>N+1</strong> — a query inside a loop, or an eager collection</span>
          <span><strong>Broken</strong> — a relation names a field that is not there</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Service</th>
                <th>Scope gaps</th>
                <th>N+1</th>
                <th>Broken</th>
                <th>Risk</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {scans.length === 0 ? (
                <tr>
                  <td className="empty" colSpan={6}>
                    No scans yet. Paste a GitHub URL above.
                  </td>
                </tr>
              ) : (
                scans.map((scan) => (
                  <tr key={scan.service} onClick={() => onOpen(scan)}>
                    <td className="service-name">{scan.service}</td>
                    <td>{scan.counts.scopeGaps}</td>
                    <td>{scan.counts.nPlusOne}</td>
                    <td>{scan.counts.brokenRelations}</td>
                    <td>
                      <span className={`risk risk-${scan.counts.risk}`}>{scan.counts.risk}</span>
                    </td>
                    <td className="open-hint">Open</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
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

function PathList({ paths, picked, onPick }: { paths: FlowPath[]; picked: string | null; onPick: (name: string) => void }) {
  return (
    <div className="path-list">
      {paths.map((path, pathIndex) => (
        <article className="path-card" key={`${path.kind}-${path.entry}-${pathIndex}`}>
          <div className="path-kicker">{path.kind === "job" ? "Starts on its own" : "Request"}</div>
          <div className="path-entry">{path.entry}</div>
          <div className="hops">
            {path.hops.map((hop, index) => (
              <span className="hop-wrap" key={`${hop.role}-${hop.name}-${index}`}>
                {index > 0 && (
                  <span className={hop.role === "Outbound" ? "hop-arrow is-out" : "hop-arrow"} aria-hidden="true">
                    {hop.role === "Outbound" ? "⇢" : "→"}
                  </span>
                )}
                <button
                  type="button"
                  className={[
                    "hop",
                    hop.role === "Outbound" ? "is-out" : "",
                    hop.role === "Entity" ? "is-entity" : "",
                    picked === hop.name ? "is-on" : "",
                  ].filter(Boolean).join(" ")}
                  onClick={() => onPick(hop.name)}
                >
                  <small>{hop.role}</small>
                  {hop.name}
                </button>
              </span>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}

function Identity({ scan, meta }: { scan: ScanResult; meta: RepoMeta | null }) {
  const identity = scan.overview?.identity;
  const why = identity?.why || meta?.description || "";
  return (
    <div className="identity">
      <p className="why">{why || "No README summary was found in this clone."}</p>
      <div className="stack">
        {(identity?.language || meta?.language) && <span className="stack-tag">{identity?.language || meta?.language}</span>}
        {(identity?.stack ?? []).map((item) => <span className="stack-tag" key={item}>{item}</span>)}
        {(identity?.license || meta?.license) && <span className="stack-tag">{identity?.license || meta?.license}</span>}
        <span className="stack-tag">commit {scan.commit.slice(0, 12)}</span>
        {meta?.stars != null && <span className="stack-tag">{meta.stars} stars</span>}
        {meta?.contributors != null && <span className="stack-tag">{meta.contributors} contributors</span>}
        {meta?.pushedAt && <span className="stack-tag">pushed {meta.pushedAt}</span>}
      </div>
    </div>
  );
}

function Dependencies({ scan }: { scan: ScanResult }) {
  const deps = scan.overview?.dependencies;
  if (!deps) return <p className="summary">Scan this repo again to list what it imports.</p>;
  return (
    <>
      <h3 className="map-title">Inside the repo</h3>
      <p>Which responsibility imports which. This stays at module level so the picture does not turn into a file hairball.</p>
      {deps.internal.length === 0 ? (
        <p className="summary">No cross-module imports were found.</p>
      ) : (
        <ul className="dep-list">
          {deps.internal.map((edge) => (
            <li key={`${edge.from}-${edge.to}`}>{edge.from} → {edge.to}</li>
          ))}
        </ul>
      )}
      <h3 className="map-title">Libraries</h3>
      <div className="stack">
        {deps.external.length === 0 && <p className="summary">No Maven or Gradle dependencies were found.</p>}
        {deps.external.map((dep) => (
          <span className="stack-tag" key={dep.name}>{dep.name} · {dep.usedFor}</span>
        ))}
      </div>
    </>
  );
}

function EntryPoints({ scan }: { scan: ScanResult }) {
  const entries = scan.overview?.entryPoints ?? [];
  if (entries.length === 0) return <p className="summary">Scan this repo again to see where it starts.</p>;
  return (
    <div className="entry-list">
      {entries.map((entry) => (
        <article className="entry-card" key={`${entry.name}-${entry.detail}`}>
          <h3>{entry.name}</h3>
          <p>{entry.detail}</p>
        </article>
      ))}
    </div>
  );
}

function Checklist({ scan }: { scan: ScanResult }) {
  const steps = scan.overview?.checklist ?? [];
  if (steps.length === 0) return <p className="summary">Scan this repo again to see how to run it.</p>;
  return (
    <ol className="checklist">
      {steps.map((step, index) => (
        <li key={step.title}>
          <span className="check-index">{index + 1}</span>
          <span>
            <strong>{step.title}</strong>
            <span className="check-detail">{step.detail}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function Health({ scan, meta }: { scan: ScanResult; meta: RepoMeta | null }) {
  const health = scan.overview?.health;
  return (
    <>
      <div className="stat-row">
        <div className="stat"><b>{health?.testFiles ?? "—"}</b><span>Test files</span></div>
        <div className="stat"><b>{health?.workflows?.length ?? "—"}</b><span>CI workflows</span></div>
        <div className="stat"><b>{meta?.openIssues ?? "—"}</b><span>Open issues</span></div>
        <div className="stat"><b>{meta?.stars ?? "—"}</b><span>Stars</span></div>
      </div>
      {health?.coverage && <p>{health.coverage}</p>}
      {health?.workflows && health.workflows.length > 0 && (
        <div className="stack">
          {health.workflows.map((name) => <span className="stack-tag" key={name}>{name}</span>)}
        </div>
      )}
      <p className="summary">{health?.churn || "Stars and open issues come from GitHub. File churn needs more than the one commit this scan clones."}</p>
    </>
  );
}

const SECTIONS = [
  { id: "identity", label: "Identity" },
  { id: "modules", label: "Modules" },
  { id: "flow", label: "Data flow" },
  { id: "deps", label: "Dependencies" },
  { id: "entry", label: "Entry points" },
  { id: "critical", label: "Critical paths" },
  { id: "checklist", label: "Checklist" },
  { id: "health", label: "Health" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function DetailPanel({ scan, onHome, sourceUrl }: { scan: ScanResult; onHome: () => void; sourceUrl?: string }) {
  const [view, setView] = useState<SectionId>("identity");
  const [picked, setPicked] = useState<string | null>(null);
  const [meta, setMeta] = useState<RepoMeta | null>(null);
  const [chart, setChart] = useState<"flow" | "conn" | "erd">("flow");
  const flowClasses = useMemo(() => parseFlow(scan.diagrams.architecture), [scan.diagrams.architecture]);
  const paths = useMemo(() => parsePaths(scan.diagrams.architecture), [scan.diagrams.architecture]);
  const pickedClass = flowClasses.find((item) => item.name === picked) ?? null;
  const overview = scan.overview;

  useEffect(() => {
    setView("identity");
    setPicked(null);
    setChart("flow");
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

  const activeChart = chart === "conn" ? scan.diagrams.connections : chart === "erd" ? scan.diagrams.erd : scan.diagrams.architecture;
  const criticalPaths = paths.filter((path) => {
    const gap = scan.endpoints.some((endpoint) => endpoint.scopeGap && endpoint.path && path.entry.includes(endpoint.path));
    const hit = path.hops.some((hop) => scan.findings.some((finding) => finding.symbol.startsWith(hop.name)));
    return gap || hit;
  });

  return (
    <main className="workspace">
      <div className="workspace-head">
        <div>
          <button type="button" className="back" onClick={onHome}>
            All scans
          </button>
          <h2>{scan.service}</h2>
          <p className="summary">
            {scan.summary} · commit <code>{scan.commit.slice(0, 12)}</code>
          </p>
        </div>
      </div>

      <div className="stat-row">
        <div className="stat">
          <b>{scan.counts.scopeGaps}</b>
          <span>Scope gaps</span>
        </div>
        <div className="stat">
          <b>{scan.counts.nPlusOne}</b>
          <span>N+1</span>
        </div>
        <div className="stat">
          <b>{scan.counts.brokenRelations}</b>
          <span>Broken</span>
        </div>
        <div className={`stat stat-risk risk-${scan.counts.risk}`}>
          <b>{scan.counts.risk}</b>
          <span>Score {scan.counts.score}</span>
        </div>
      </div>

      <div className="tabbar" role="tablist" aria-label="What to show">
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={view === item.id}
            className={view === item.id ? "tab is-on" : "tab"}
            onClick={() => setView(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <section className="diagram-block">
        {view === "identity" && (
          <Identity scan={scan} meta={meta} />
        )}
        {view === "modules" && (
          overview?.moduleDiagram ? (
            <>
              <p>Boxes are responsibilities, not folders. Color is the layer: API, services, data, workers, and calls that leave the service.</p>
              <MermaidDiagram chart={overview.moduleDiagram} id={`${scan.service}-modules`} />
            </>
          ) : (
            <p className="summary">Scan this repo again to group the code into modules.</p>
          )
        )}
        {view === "flow" && (
          <>
            <p>Read each route left to right. Blue is a sync call, green is a database write or read, orange is a schedule or a message, and a dashed arrow leaves the service.</p>
            <div className="lanes" aria-hidden="true">
              <span><i className="lane lane-sync" /> Sync call</span>
              <span><i className="lane lane-db" /> Database</span>
              <span><i className="lane lane-async" /> Event or schedule</span>
              <span><i className="lane lane-exit" /> External call</span>
            </div>
            {paths.length > 0 ? (
              <PathList paths={paths} picked={picked} onPick={setPicked} />
            ) : (
              scan.diagrams.architecture && <p className="summary">Scan this repo again to see each route as its own path.</p>
            )}
            {pickedClass && <MethodPanel item={pickedClass} />}
            {paths.length > 0 && !pickedClass && <p className="summary">Select a class in a path to read its methods.</p>}
            <div className="chart-switch" role="tablist" aria-label="Diagram">
              {([
                ["flow", "Flow map"],
                ["conn", "Connections"],
                ["erd", "ERD"],
              ] as const).map(([id, label]) => (
                <button key={id} type="button" className={chart === id ? "tab is-on" : "tab"} onClick={() => setChart(id)}>
                  {label}
                </button>
              ))}
            </div>
            {activeChart && (
              <MermaidDiagram
                chart={activeChart}
                id={`${scan.service}-${chart}`}
                selectable={chart === "flow" ? flowClasses.map((item) => item.name) : undefined}
                active={chart === "flow" ? picked : null}
                onPick={chart === "flow" ? setPicked : undefined}
              />
            )}
          </>
        )}
        {view === "deps" && (
          <Dependencies scan={scan} />
        )}
        {view === "entry" && (
          <EntryPoints scan={scan} />
        )}
        {view === "critical" && (
          <>
            <p>These are the risky paths inside the data flow, not a second map. A highlighted route touches a scope gap or another finding.</p>
            {criticalPaths.length > 0 ? (
              <PathList paths={criticalPaths} picked={picked} onPick={setPicked} />
            ) : (
              <p className="summary">No route is tied to a finding yet.</p>
            )}
            {scan.findings.length === 0 ? (
              <p className="summary">No findings.</p>
            ) : (
              scan.findings.map((f, i) => (
                <div className="finding" key={i}>
                  <span><span className={`tag tag-${f.kind}`}>{kindLabel(f.kind)}</span></span>
                  <span>
                    {f.symbol && <span className="mono">{f.symbol}</span>}
                    {f.file && <span className="file">{f.file}</span>}
                    {f.detail && <span>{f.symbol || f.file ? " — " : ""}{f.detail}</span>}
                  </span>
                </div>
              ))
            )}
            <p className="summary">{overview?.health.churn}</p>
          </>
        )}
        {view === "checklist" && <Checklist scan={scan} />}
        {view === "health" && <Health scan={scan} meta={meta} />}
      </section>
    </main>
  );
}
