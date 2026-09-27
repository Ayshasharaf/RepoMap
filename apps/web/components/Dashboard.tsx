"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ScanResult, RepoMeta } from "@/lib/types";
import type { FlowClass, FlowPath } from "@/lib/flow";
import { parseFlow, parsePaths, parseStories } from "@/lib/flow";
import MermaidDiagram from "./MermaidDiagram";

const PHASE_LABEL: Record<string, string> = {
  clone:    "Cloning repository…",
  commit:   "Reading commit…",
  scan:     "Scanning Java files…",
  overview: "Building overview…",
};

async function readScanStream(
  res: Response,
  onPhase: (label: string) => void,
): Promise<ScanResult> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: ScanResult | null = null;
  let streamError: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const event = JSON.parse(trimmed) as { type?: string; phase?: string; detail?: string; data?: ScanResult };
      if (event.type === "status" && event.phase) {
        onPhase(PHASE_LABEL[event.phase] ?? event.phase);
      }
      if (event.type === "error") streamError = event.detail || "Scan failed";
      if (event.type === "result" && event.data) result = event.data;
    }
  }
  if (streamError) throw new Error(streamError);
  if (!result?.service) throw new Error("Scan finished without a result");
  return result;
}

function kindLabel(kind: string) {
  return { scope_gap: "Scope gap", n_plus_one: "N+1", broken_relation: "Broken relation" }[kind] ?? kind;
}

type SectionId = "overview" | "modules" | "flow" | "deps" | "entry" | "critical" | "health";

const NAV: { id: SectionId; label: string; hint: string; icon: string }[] = [
  { id: "overview",  label: "Overview",        hint: "What this repo is",         icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" },
  { id: "modules",   label: "Architecture",     hint: "Modules and imports",       icon: "M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" },
  { id: "flow",      label: "Data flow",        hint: "The full call chain",       icon: "M13 10V3L4 14h7v7l9-11h-7z" },
  { id: "deps",      label: "Dependencies",     hint: "Libraries and links",       icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" },
  { id: "entry",     label: "Entry points",     hint: "How to run it",             icon: "M5 3l14 9-14 9V3z" },
  { id: "critical",  label: "Critical paths",   hint: "Routes with findings",      icon: "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" },
  { id: "health",    label: "Health",           hint: "Tests, CI, GitHub",         icon: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" },
];

const PREVIEWS = [
  { label: "Overview",       hint: "What this repo is, before any diagram.",                                  sketch: "cover" },
  { label: "Architecture",   hint: "Modules by responsibility, and how they import each other.",              sketch: "rooms" },
  { label: "Data flow",      hint: "Each route as a line of stops, from the request to storage.",             sketch: "rail" },
  { label: "Dependencies",   hint: "Libraries on shelves, named by what they are for.",                      sketch: "shelves" },
  { label: "Entry points",   hint: "The class that starts it, and the command that runs it.",                 sketch: "term" },
  { label: "Critical paths", hint: "Only the routes that sit next to a finding.",                            sketch: "risk" },
  { label: "Health",         hint: "Tests, CI, stars, and what this clone cannot know.",                     sketch: "signals" },
] as const;

const MODULE_LABEL: Record<string, string> = {
  api: "API", services: "Services", data: "Data",
  workers: "Workers", outbound: "Outbound", auth: "Auth",
  config: "Config", app: "Other",
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

function NavIcon({ path }: { path: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

export default function Dashboard({ initialScans }: { initialScans: ScanResult[] }) {
  const [scans, setScans] = useState<ScanResult[]>(initialScans);
  const [selected, setSelected] = useState<ScanResult | null>(initialScans[0] ?? null);
  const [section, setSection] = useState<SectionId>("overview");
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<Record<string, string>>({});
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleScan(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    setLoading(true);
    setPhase("Cloning repository…");
    setError(null);
    try {
      const res = await fetch("/scan-github", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      const contentType = res.headers.get("content-type") ?? "";
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.detail ?? data?.error ?? `Error ${res.status}`);
        return;
      }
      const result = contentType.includes("ndjson")
        ? await readScanStream(res, setPhase)
        : (await res.json()) as ScanResult;
      setScans((prev) => [result, ...prev.filter((s) => s.service !== result.service)]);
      setSources((prev) => ({ ...prev, [result.service]: trimmed }));
      setSelected(result);
      setSection("overview");
      setUrl("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
      setPhase("");
    }
  }

  if (!selected) {
    return (
      <div>
        <section className="plaque">
          <div className="plaque-inner">
            <div className="kicker">Paste a repo</div>
            <h1>See how it is built.</h1>
            <p>Map a public Spring Boot Java repository on GitHub. Then choose Overview, Architecture, Data flow, Dependencies, Entry points, Critical paths, or Health.</p>
            <p className="lang-note">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{display:"inline",verticalAlign:"-2px",marginRight:"5px"}}><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></svg>
              Spring Boot Java only. Other languages will return an unscored result.
            </p>
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
                {loading ? (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="spin-icon" aria-hidden="true" style={{display:"inline",verticalAlign:"-2px",marginRight:"6px"}}><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0" /></svg>
                    {phase || "Mapping…"}
                  </>
                ) : "Map it"}
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
                  {item.sketch === "cover" && <><i /><i /><i /><i /></>}
                  {item.sketch === "rooms" && <><b>API</b><b>Services</b><b>Data</b></>}
                  {item.sketch === "rail" && <><span /><span /><span /></>}
                  {item.sketch === "shelves" && <><em>Database</em><em>Queue</em><em>Auth</em></>}
                  {item.sketch === "term" && <code>./mvnw spring-boot:run</code>}
                  {item.sketch === "risk" && <><span /><span className="is-hot" /><span /></>}
                  {item.sketch === "signals" && <><s /><s className="is-off" /><s /></>}
                </div>
                <strong>{item.label}</strong>
                <span>{item.hint}</span>
              </article>
            ))}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {/* Mobile overlay */}
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} aria-hidden="true" />}

      {/* Sidebar */}
      <aside className={`sidebar${sidebarOpen ? " is-open" : ""}`} aria-label="Navigation">
        <div className="sidebar-top">
          <div className="sidebar-brand">
            <span className="brand-mark" aria-hidden="true">RM</span>
            <span>RepoMap</span>
          </div>

          {/* Repo switcher */}
          <div className="sidebar-repos">
            {scans.map((scan) => (
              <button
                key={scan.service}
                type="button"
                className={`sidebar-repo${selected.service === scan.service ? " is-on" : ""}`}
                onClick={() => { setSelected(scan); setSection("overview"); setSidebarOpen(false); }}
                title={scan.service}
              >
                <span className="sidebar-repo-dot" />
                <span className="sidebar-repo-name">{scan.service}</span>
                {scan.counts.risk === "High" && <span className="sidebar-badge sidebar-badge-risk">!</span>}
                {scan.counts.risk === "Medium" && <span className="sidebar-badge sidebar-badge-warn">~</span>}
              </button>
            ))}
          </div>

          {/* Nav */}
          <nav className="sidebar-nav" aria-label="Sections">
            {NAV.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`sidebar-nav-item${section === item.id ? " is-on" : ""}`}
                aria-current={section === item.id ? "page" : undefined}
                onClick={() => { setSection(item.id); setSidebarOpen(false); }}
                title={item.hint}
              >
                <NavIcon path={item.icon} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
        </div>

        {/* Scan form at bottom of sidebar */}
        <div className="sidebar-scan">
          <form onSubmit={handleScan}>
            <input
              ref={inputRef}
              type="text"
              className="sidebar-scan-input"
              placeholder="github.com/owner/repo"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={loading}
              aria-label="GitHub repository URL"
            />
            <button className="sidebar-scan-btn" type="submit" disabled={loading || !url.trim()}>
              {loading ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="spin-icon"><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0" /></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
              )}
              <span>{loading ? (phase || "Mapping…") : "Map repo"}</span>
            </button>
          </form>
          {error && <div className="sidebar-error">{error}</div>}
        </div>
      </aside>

      {/* Main content */}
      <div className="main-area">
        {/* Top bar (mobile) */}
        <header className="topbar">
          <button className="topbar-menu" type="button" onClick={() => setSidebarOpen(true)} aria-label="Open navigation">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="topbar-title">{selected.service}</div>
          <div className="topbar-section">{NAV.find(n => n.id === section)?.label}</div>
        </header>

        <div className="main-canvas">
          <DetailPanel
            scan={selected}
            sourceUrl={sources[selected.service]}
            section={section}
            onNavigate={setSection}
          />
        </div>
      </div>
    </div>
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
        <span className="role-badge">{item.role}</span>
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
  if (role === "Service") return "logic";
  return "";
}

const ROLE_ICON: Record<string, string> = {
  Controller: "M4 6h16M4 12h8m-8 6h16",
  Service:    "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z",
  Repository: "M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4",
  Entity:     "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4",
  Outbound:   "M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14",
  Listener:   "M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z",
  Job:        "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z",
};

function HopIcon({ role }: { role: string }) {
  const iconPath = ROLE_ICON[role] ?? ROLE_ICON.Service;
  return (
    <svg className="hop-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={iconPath} />
    </svg>
  );
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
      <div className="flow-legend">
        <span className="fl-item fl-db"><i />Database / Repository</span>
        <span className="fl-item fl-logic"><i />Business logic</span>
        <span className="fl-item"><i />Other step</span>
      </div>
      {paths.map((path, pathIndex) => {
        const notes = findingsForPath(path, findings ?? []);
        const openName = picked?.startsWith(`${pathIndex}::`) ? picked.slice(picked.indexOf("::") + 2) : "";
        const open = openName ? classes.find((item) => item.name === openName) ?? null : null;
        return (
          <article className={notes.length ? "rail is-risk" : "rail"} key={`${path.kind}-${path.entry}-${pathIndex}`}>
            <div className="rail-head">
              <span className={`rail-kind-badge rk-${path.kind === "job" ? "job" : "http"}`}>
                {path.kind === "job" ? "Schedule / Message" : "HTTP Request"}
              </span>
              <strong>{path.entry}</strong>
              <span className="rail-hop-count">{path.hops.length} step{path.hops.length !== 1 ? "s" : ""}</span>
            </div>
            <ol className="flow-chain">
              <li className="flow-origin">
                <span className="fs-num" aria-hidden="true">·</span>
                <span className="fo-label">Client</span>
              </li>
              {path.hops.map((hop, index) => {
                const tone = hopTone(hop.role);
                const isOn = picked === `${pathIndex}::${hop.name}`;
                return (
                  <li className="flow-step-wrap" key={`${hop.role}-${hop.name}-${index}`}>
                    <button
                      type="button"
                      className={["flow-step", tone ? `is-${tone}` : "", isOn ? "is-on" : ""].filter(Boolean).join(" ")}
                      onClick={() => onPick(`${pathIndex}::${hop.name}`)}
                    >
                      <span className="fs-num">{index + 1}</span>
                      <HopIcon role={hop.role} />
                      <span className="fs-body">
                        <span className="fs-role">{hop.role}</span>
                        <span className="fs-name">{hop.name}</span>
                      </span>
                      <span className={isOn ? "fs-caret is-open" : "fs-caret"} aria-hidden="true" />
                    </button>
                    {isOn && open && <MethodPanel item={open} />}
                  </li>
                );
              })}
            </ol>
            {notes.length > 0 && (
              <div className="rail-notes">
                {notes.map((finding, index) => (
                  <p className="rail-note" key={`${finding.kind}-${index}`}>
                    <span className={`tag tag-${finding.kind}`}>{kindLabel(finding.kind)}</span>
                    {finding.detail}
                  </p>
                ))}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

function moduleName(id: string) {
  return MODULE_LABEL[id] ?? id;
}

const EMPTY_EDGES: { from: string; to: string }[] = [];

const MOD_LANE: Record<string, "entry" | "logic" | "storage" | "support"> = {
  api:      "entry",
  workers:  "entry",
  services: "logic",
  auth:     "logic",
  data:     "storage",
  outbound: "support",
  config:   "support",
  app:      "support",
};

const LANE_LABEL: Record<string, string> = {
  entry:   "Entry",
  logic:   "Logic",
  storage: "Storage",
  support: "Support",
};

function moduleTone(id: string) {
  if (id === "data") return "is-db";
  if (id === "services") return "is-logic";
  if (id === "auth") return "is-risk";
  return "";
}

function ArchBoard({
  modules,
  edges,
  erd,
  service,
}: {
  modules: import("@/lib/types").OverviewModule[];
  edges: { from: string; to: string }[];
  erd: string;
  service: string;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const [wires, setWires] = useState<string[]>([]);

  const lanes: Record<string, typeof modules> = { entry: [], logic: [], storage: [], support: [] };
  for (const mod of modules) {
    const lane = MOD_LANE[mod.id] ?? "support";
    lanes[lane].push(mod);
  }
  const laneOrder = (["entry", "logic", "storage", "support"] as const).filter((l) => lanes[l].length > 0);
  const moduleOrder = ["api", "workers", "auth", "services", "data", "outbound", "config", "app"];
  for (const lane of laneOrder) {
    lanes[lane].sort((a, b) => {
      const ai = moduleOrder.indexOf(a.id);
      const bi = moduleOrder.indexOf(b.id);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
  }
  const edgeKey = edges.map((edge) => `${edge.from}>${edge.to}`).join("|");

  useLayoutEffect(() => {
    const root = flowRef.current;
    if (!root) return;
    const measure = () => {
      const box = root.getBoundingClientRect();
      let bus = 0;
      const next = edges.flatMap((edge) => {
        const from = root.querySelector<HTMLElement>(`[data-mod="${edge.from}"]`);
        const to = root.querySelector<HTMLElement>(`[data-mod="${edge.to}"]`);
        if (!from || !to) return [];
        const a = from.getBoundingClientRect();
        const b = to.getBoundingClientRect();
        const round = (value: number) => Math.round(value);
        const forward = b.left >= a.right - 4;
        const x1 = round(a.right - box.left);
        const y1 = round(a.top + a.height / 2 - box.top);
        const x2 = round(b.left - box.left) - 8;
        const y2 = round(b.top + b.height / 2 - box.top);
        if (forward && x2 - x1 < a.width) {
          const mid = round((x1 + x2) / 2);
          return [`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`];
        }
        const drop = round(Math.max(a.bottom, b.bottom) - box.top + 16 + bus * 12);
        bus += 1;
        const startX = round(a.left + a.width / 2 - box.left);
        const startY = round(a.bottom - box.top);
        const endX = round(b.left + b.width / 2 - box.left);
        const endY = round(b.bottom - box.top + 8);
        return [`M ${startX} ${startY} L ${startX} ${drop} L ${endX} ${drop} L ${endX} ${endY}`];
      });
      setWires((prev) => (prev.length === next.length && prev.every((line, index) => line === next[index]) ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [edgeKey, expanded, edges]);

  return (
    <div className="arch-board">
      <div className="arch-scroll">
        <div className="arch-flow" ref={flowRef}>
          <svg className="arch-wires" aria-hidden="true">
            <defs>
              <marker id="arch-arrow" viewBox="0 0 12 12" refX="9" refY="6" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M2 2 L10 6 L2 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              </marker>
            </defs>
            {wires.map((line) => (
              <path key={line} d={line} markerEnd="url(#arch-arrow)" />
            ))}
          </svg>
          {laneOrder.map((lane) => (
            <div className="arch-lane" key={lane}>
              <div className="arch-lane-label">{LANE_LABEL[lane]}</div>
              <div className="arch-lane-cards">
                {lanes[lane].map((mod) => {
                  const isOpen = expanded === mod.id;
                  const classes = mod.classes ?? [];
                  const tone = moduleTone(mod.id);
                  return (
                    <button
                      key={mod.id}
                      type="button"
                      data-mod={mod.id}
                      className={["arch-mod", tone, isOpen ? "is-open" : ""].filter(Boolean).join(" ")}
                      onClick={() => setExpanded(isOpen ? null : mod.id)}
                      aria-expanded={isOpen}
                    >
                      <div className="arch-mod-top">
                        {tone && <span className="arch-mod-dot" aria-hidden="true" />}
                        <span className="arch-mod-name">{moduleName(mod.id)}</span>
                        <span className="arch-mod-count">{mod.files}</span>
                      </div>
                      <span className="arch-mod-about">{MODULE_ABOUT[mod.id] ?? mod.label}</span>
                      {isOpen && classes.length > 0 && (
                        <ul className="arch-mod-classes" onClick={(event) => event.stopPropagation()}>
                          {classes.map((name) => <li key={name}><code>{name}</code></li>)}
                        </ul>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {erd && (
        <div className="arch-erd">
          <h2 className="section-title">Stored records</h2>
          <p className="summary">Each box is an entity. A line is a field that points at another entity.</p>
          <MermaidDiagram chart={erd} id={`${service}-erd`} />
        </div>
      )}
    </div>
  );
}

function Dependencies({ scan }: { scan: ScanResult }) {
  const deps = scan.overview?.dependencies;
  if (!deps) return <p className="summary">Map this repo again to read its build files.</p>;
  if (deps.external.length === 0) return <p className="summary">No libraries found in the build file.</p>;

  const groups = new Map<string, string[]>();
  for (const dep of deps.external) {
    const list = groups.get(dep.usedFor) ?? [];
    list.push(dep.name);
    groups.set(dep.usedFor, list);
  }
  const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  return (
    <div className="dep-grid">
      {ranked.map(([purpose, names]) => (
        <section className="dep-card" key={purpose}>
          <div className="dep-card-head">
            <h3>{purpose}</h3>
            <span className="dep-count">{names.length}</span>
          </div>
          <ul className="dep-libs">
            {names.map((name) => <li key={name}><code>{name}</code></li>)}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Runbook({ scan }: { scan: ScanResult }) {
  const entries = scan.overview?.entryPoints ?? [];
  const steps = scan.overview?.checklist ?? [];
  if (!scan.overview) return <p className="summary">Map this repo again to see how it starts.</p>;
  const starts = entries.filter((entry) => entry.detail.includes("Spring Boot application") || entry.name === "Docker");
  const commands = steps.filter((step) => step.title !== "Set environment variables" && step.title !== "No setup file found");
  const run = commands.find((step) => step.title === "Run locally");
  const rest = commands.filter((step) => step !== run);
  const env = steps.find((step) => step.title === "Set environment variables");
  const missing = steps.find((step) => step.title === "No setup file found");
  return (
    <div className="runbook">
      {run ? (
        <article className="run-hero">
          <p className="eyebrow">Run locally</p>
          <code>{run.detail}</code>
        </article>
      ) : (
        <p className="summary">No run command was found in the Maven or Gradle files.</p>
      )}
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
      {rest.length > 0 && (
        <div className="run-grid">
          {rest.map((step) => (
            <article className="run-card" key={`${step.title}-${step.detail}`}>
              <small>{step.title}</small>
              <code>{step.detail}</code>
            </article>
          ))}
        </div>
      )}
      {env && (
        <div className="env-block">
          <h2 className="section-title">Environment</h2>
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

type FlowTab = "chain" | "sequence" | "transaction" | "trigger";

function FlowSection({
  scan,
  paths,
  stories,
  flowClasses,
}: {
  scan: ScanResult;
  paths: FlowPath[];
  stories: ReturnType<typeof parseStories>;
  flowClasses: FlowClass[];
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [routeIndex, setRouteIndex] = useState(0);
  const [flowTab, setFlowTab] = useState<FlowTab>("chain");

  useEffect(() => {
    setPicked(null);
    setRouteIndex(0);
    setFlowTab("chain");
  }, [scan.service]);

  if (paths.length === 0) {
    return <p className="summary">Map this repo again. This result has no per-route trace yet.</p>;
  }

  const story = stories[routeIndex];
  const hasSequence = Boolean(story?.sequence);
  const hasTransaction = Boolean(story?.transaction);
  const hasTrigger = Boolean(story?.trigger);
  const tabs: { id: FlowTab; label: string; available: boolean }[] = [
    { id: "chain",       label: "Call chain",    available: true },
    { id: "sequence",    label: "Sequence",       available: hasSequence },
    { id: "transaction", label: "Transaction",    available: hasTransaction },
    { id: "trigger",     label: "DB trigger",     available: hasTrigger },
  ];

  return (
    <div className="flow-page">
      {/* Route selector */}
      <div className="route-selector">
        <span className="route-selector-label">Route</span>
        <div className="chart-switch" role="tablist" aria-label="Route">
          {paths.map((path, index) => (
            <button
              key={`${path.entry}-${index}`}
              type="button"
              role="tab"
              aria-selected={routeIndex === index}
              className={routeIndex === index ? "tab is-on" : "tab"}
              onClick={() => { setRouteIndex(index); setPicked(null); setFlowTab("chain"); }}
            >
              <span className={`route-kind-dot rk-${path.kind === "job" ? "job" : "http"}`} aria-hidden="true" />
              {path.entry}
            </button>
          ))}
        </div>
      </div>

      {/* Diagram type tabs */}
      <div className="flow-tabs" role="tablist" aria-label="Diagram type">
        {tabs.filter(t => t.available).map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={flowTab === t.id}
            className={`flow-tab${flowTab === t.id ? " is-on" : ""}`}
            onClick={() => setFlowTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content by tab */}
      {flowTab === "chain" && (
        <>
          <FlowBoard
            paths={[paths[routeIndex]]}
            classes={flowClasses}
            picked={picked}
            onPick={setPicked}
          />
          {!picked && <p className="summary">Click a numbered step to read its methods. The numbers run from the request toward storage.</p>}
        </>
      )}

      {flowTab === "sequence" && story?.sequence && (
        <div className="diagram-block">
          <div className="seq-callout">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
            <span>Sequence diagram shows the message flow between actors for this route.</span>
          </div>
          <MermaidDiagram chart={story.sequence} id={`${scan.service}-seq-${routeIndex}`} />
        </div>
      )}

      {flowTab === "transaction" && story?.transaction && (
        <div className="diagram-block">
          <div className="seq-callout">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4"/></svg>
            <span>Shows which database operations happen inside a transaction boundary.</span>
          </div>
          <MermaidDiagram chart={story.transaction} id={`${scan.service}-tx-${routeIndex}`} />
        </div>
      )}

      {flowTab === "trigger" && story?.trigger && (
        <div className="diagram-block">
          <div className="seq-callout">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
            <span>Database triggers that fire as a result of this route.</span>
          </div>
          <MermaidDiagram chart={story.trigger} id={`${scan.service}-trig-${routeIndex}`} />
        </div>
      )}
    </div>
  );
}

function DetailPanel({
  scan,
  sourceUrl,
  section,
  onNavigate,
}: {
  scan: ScanResult;
  sourceUrl?: string;
  section: SectionId;
  onNavigate: (s: SectionId) => void;
}) {
  const [meta, setMeta] = useState<RepoMeta | null>(null);
  const flowClasses = useMemo(() => parseFlow(scan.diagrams.architecture), [scan.diagrams.architecture]);
  const paths = useMemo(() => parsePaths(scan.diagrams.architecture), [scan.diagrams.architecture]);
  const stories = useMemo(() => parseStories(scan.diagrams.architecture), [scan.diagrams.architecture]);
  const [picked, setPicked] = useState<string | null>(null);
  const overview = scan.overview;

  useEffect(() => {
    setPicked(null);
  }, [scan.service, scan.commit]);

  useEffect(() => {
    if (!sourceUrl) { setMeta(null); return; }
    let cancel = false;
    fetch(`/repo-meta?url=${encodeURIComponent(sourceUrl)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (!cancel) setMeta(data); })
      .catch(() => { if (!cancel) setMeta(null); });
    return () => { cancel = true; };
  }, [sourceUrl]);

  const criticalPaths = paths.filter((path) => {
    if (findingsForPath(path, scan.findings).length > 0) return true;
    return scan.endpoints.some((endpoint) => endpoint.scopeGap && endpoint.path && path.entry.includes(endpoint.path));
  });

  const pageTitle: Record<Exclude<SectionId, "overview">, { title: string; hint: string }> = {
    modules:  { title: "Architecture",   hint: "Entry receives requests, logic does the work, and storage holds the data. An arrow is an import. Click a module to see its classes." },
    flow:     { title: "Data flow",      hint: "Pick a route and a diagram type. Call chain shows numbered steps. Sequence shows actor messages. Transaction shows DB scope." },
    deps:     { title: "Dependencies",   hint: "Which group uses which, then the libraries in the build file." },
    entry:    { title: "Entry points",   hint: "If you want to run this, start here." },
    critical: { title: "Critical paths", hint: "A route is listed when a finding names a class that route calls, or when that URL is marked as missing tenant scope." },
    health:   { title: "Health",         hint: "Test files and CI workflows from the repo. Stars and open issues from GitHub." },
  };

  return (
    <div className="canvas">
      {section === "overview" ? (
        <OverviewBoard scan={scan} meta={meta} paths={paths} onNavigate={onNavigate} />
      ) : (
        <>
          <header className="page-head">
            <h1 className="page-head-title">{pageTitle[section].title}</h1>
            <p className="lede">{pageTitle[section].hint}</p>
          </header>
          <section className="diagram-block">
            {section === "modules" && (
              overview?.modules?.length ? (
                <ArchBoard
                  modules={overview.modules}
                  edges={overview.dependencies?.internal ?? EMPTY_EDGES}
                  erd={scan.diagrams.erd}
                  service={scan.service}
                />
              ) : (
                <p className="summary">Map this repo again to group the code into modules.</p>
              )
            )}
            {section === "flow" && (
              <FlowSection
                scan={scan}
                paths={paths}
                stories={stories}
                flowClasses={flowClasses}
              />
            )}
            {section === "deps" && <Dependencies scan={scan} />}
            {section === "entry" && <Runbook scan={scan} />}
            {section === "critical" && (
              <>
                <ul className="rule">
                  <li className="is-warn"><b>N+1</b> A query runs inside a loop, on a class this route calls.</li>
                  <li className="is-risk"><b>Scope gap</b> A repository method returns a tenant-owned record without a tenant id, or the URL is marked as missing scope.</li>
                  <li className="is-risk"><b>Broken relation</b> An entity this route touches points at another entity in a way the fields do not match.</li>
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
  onNavigate,
}: {
  scan: ScanResult;
  meta: RepoMeta | null;
  paths: FlowPath[];
  onNavigate: (s: SectionId) => void;
}) {
  const overview = scan.overview;
  const identity = overview?.identity;
  const why = identity?.why || meta?.description || "";
  const libraries = overview?.dependencies.external.length ?? 0;
  const run = overview?.checklist.find((step) => step.title === "Run locally")?.detail
    || overview?.checklist.find((step) => step.title === "Tests")?.detail
    || "";
  const figures = [
    { value: String(paths.length || scan.endpoints.length), label: paths.length ? "Routes" : "Endpoints", nav: "flow" as SectionId },
    { value: String(scan.entities.length), label: "Entities", nav: "modules" as SectionId },
    { value: String(libraries), label: "Libraries", nav: "deps" as SectionId },
    { value: String(scan.counts.scopeGaps), label: "Scope gaps", nav: "critical" as SectionId },
    { value: String(scan.counts.nPlusOne), label: "N+1 queries", nav: "critical" as SectionId },
    { value: String(scan.counts.brokenRelations), label: "Broken relations", nav: "critical" as SectionId },
  ];
  const facts = [
    ["Language", identity?.language || meta?.language || ""],
    ["Stack", (identity?.stack ?? []).join(", ")],
    ["License", identity?.license || meta?.license || ""],
    ["Commit", scan.commit ? scan.commit.slice(0, 12) : ""],
    ["Stars", meta?.stars != null ? formatCount(meta.stars) : ""],
    ["Run", run],
  ].filter(([, value]) => value);
  const listed = scan.findings.filter((finding) => finding.file || finding.symbol);

  const riskColor = { High: "var(--risk)", Medium: "var(--warn)", Low: "var(--ok)", Unscored: "var(--muted)" }[scan.counts.risk] ?? "var(--muted)";

  return (
    <div className="cover">
      <header className="page-head">
        <div className="overview-header">
          <div className="overview-header-main">
            <p className="eyebrow">Overview</p>
            <h1 className="page-head-title">{scan.service}</h1>
            {why && <p className="why"><RichLine text={why} /></p>}
            {scan.summary && <p className="summary">{scan.summary}</p>}
          </div>
          <div className="risk-pill" style={{ borderColor: riskColor, color: riskColor }}>
            <span className="risk-pill-label">Risk</span>
            <span className="risk-pill-value">{scan.counts.risk}</span>
            <span className="risk-pill-score">Score {scan.counts.score}</span>
          </div>
        </div>
      </header>

      {/* Metric cards */}
      <div className="figures">
        {figures.map((item) => (
          <button
            key={item.label}
            type="button"
            className="figure figure-btn"
            onClick={() => onNavigate(item.nav)}
            title={`Go to ${NAV.find(n => n.id === item.nav)?.label}`}
          >
            <b>{item.value}</b>
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      {facts.length > 0 && (
        <dl className="fact-grid">
          {facts.map(([label, value]) => (
            <div className={label === "Run" ? "is-wide" : undefined} key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {listed.length > 0 && (
        <div className="finding-block">
          <div className="finding-block-head">
            <h2 className="section-title">Findings</h2>
            <button type="button" className="link-btn" onClick={() => onNavigate("critical")}>View critical paths →</button>
          </div>
          <div className="finding-grid">
            {listed.map((finding, index) => (
              <article className="finding-card" key={`${finding.kind}-${finding.file}-${finding.symbol}-${index}`}>
                <span className={`tag tag-${finding.kind}`}>{kindLabel(finding.kind)}</span>
                <strong>{finding.symbol || kindLabel(finding.kind)}</strong>
                <p>{finding.detail}</p>
                {finding.file && <span className="finding-file">{finding.file}</span>}
              </article>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function formatCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
