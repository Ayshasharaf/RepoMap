"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ScanResult, RepoMeta } from "@/lib/types";
import type { FlowClass, FlowPath } from "@/lib/flow";
import { compareScans, snapshotOf } from "@/lib/diff";
import { parseFlow, parsePaths, parseStories } from "@/lib/flow";
import MermaidDiagram, { protectFlowLabels } from "./MermaidDiagram";

const PHASE_LABEL: Record<string, string> = {
  clone:     "Cloning repository…",
  commit:    "Reading commit…",
  scan:      "Scanning repository…",
  overview:  "Building overview…",
  structure: "Reading structure…",
  diagram:   "Drawing architecture…",
};

const EXAMPLE_REPOS = [
  {
    url: "https://github.com/spring-projects/spring-petclinic",
    label: "spring-petclinic",
    hint: "Spring Boot · scored",
  },
  {
    url: "https://github.com/pallets/flask",
    label: "flask",
    hint: "Python · architecture",
  },
  {
    url: "https://github.com/expressjs/express",
    label: "express",
    hint: "Node · architecture",
  },
] as const;

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

type SectionId = "overview" | "modules" | "flow" | "endpoints" | "deps" | "entry" | "key" | "health";

const NAV: { id: SectionId; label: string; hint: string; icon: string }[] = [
  { id: "overview",  label: "Overview",        hint: "What this repo is",         icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" },
  { id: "modules",   label: "Architecture",     hint: "Modules and imports",       icon: "M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" },
  { id: "flow",      label: "Data flow",        hint: "The full call chain",       icon: "M13 10V3L4 14h7v7l9-11h-7z" },
  { id: "endpoints", label: "Endpoints",        hint: "Every HTTP route",          icon: "M4 6h16M4 12h16M4 18h10" },
  { id: "deps",      label: "Dependencies",     hint: "Libraries and links",       icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" },
  { id: "entry",     label: "Entry points",     hint: "How to run it",             icon: "M5 3l14 9-14 9V3z" },
  { id: "key",       label: "Key paths",        hint: "Routes that reach storage", icon: "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" },
  { id: "health",    label: "Health",           hint: "Tests, CI, GitHub",         icon: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" },
];

const PREVIEWS = [
  { label: "Overview",       hint: "What this repo is, before any diagram.",                                  sketch: "cover" },
  { label: "Architecture",   hint: "Modules by responsibility, and how they import each other.",              sketch: "rooms" },
  { label: "Data flow",      hint: "Each route as a line of stops, from the request to storage.",             sketch: "rail" },
  { label: "Endpoints",      hint: "A filterable list of every HTTP route.",                                 sketch: "table" },
  { label: "Dependencies",   hint: "Libraries on shelves, named by what they are for.",                      sketch: "shelves" },
  { label: "Entry points",   hint: "The class that starts it, and the command that runs it.",                 sketch: "term" },
  { label: "Key paths",      hint: "Routes that reach a database or external system.",                       sketch: "risk" },
  { label: "Health",         hint: "Tests, CI, stars, and how big the latest commit is.",                    sketch: "signals" },
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
  const [scanningService, setScanningService] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<Record<string, string>>(() => {
    const saved: Record<string, string> = {};
    for (const scan of initialScans) {
      if (scan.source) saved[scan.service] = scan.source;
    }
    return saved;
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebarOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [sidebarOpen]);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 901px)");
    const closeOnDesktop = () => {
      if (mq.matches) setSidebarOpen(false);
    };
    closeOnDesktop();
    mq.addEventListener("change", closeOnDesktop);
    return () => mq.removeEventListener("change", closeOnDesktop);
  }, []);

  function sourceFor(scan: ScanResult) {
    return sources[scan.service] || scan.source || "";
  }

  function serviceFromUrl(raw: string) {
    const match = raw.trim().match(/github\.com\/[^/]+\/([^/?#]+)/i);
    return match ? match[1].replace(/\.git$/i, "") : "";
  }

  async function runScan(rawUrl: string) {
    const trimmed = rawUrl.trim();
    if (!trimmed || loading) return;
    const target = serviceFromUrl(trimmed);
    setLoading(true);
    setScanningService(target || null);
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
      const savedUrl = result.source || trimmed;
      const previous = scans.find((scan) => scan.service === result.service);
      const nextResult = previous ? { ...result, previous: snapshotOf(previous) } : result;
      setScans((prev) => [nextResult, ...prev.filter((s) => s.service !== result.service)]);
      setSources((prev) => ({ ...prev, [result.service]: savedUrl }));
      setSelected(nextResult);
      setSection("overview");
      setUrl("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
      setPhase("");
      setScanningService(null);
    }
  }

  function handleScan(e: React.FormEvent) {
    e.preventDefault();
    void runScan(url);
  }

  async function removeScan(service: string) {
    if (loading) return;
    let res: Response;
    try {
      res = await fetch(`/scans?service=${encodeURIComponent(service)}`, { method: "DELETE" });
    } catch {
      setError("Could not remove that scan.");
      return;
    }
    if (!res.ok) {
      setError("Could not remove that scan.");
      return;
    }
    setError(null);
    const rest = scans.filter((scan) => scan.service !== service);
    setScans(rest);
    setSelected((current) => (current?.service === service ? rest[0] ?? null : current));
    setSources((prev) => {
      const next = { ...prev };
      delete next[service];
      return next;
    });
  }

  if (!selected) {
    return (
      <div>
        <section className="plaque">
          <div className="plaque-inner">
            <div className="kicker">Paste a repo</div>
            <h1>See how it is built.</h1>
            <p>
              Map any public GitHub repository. Architecture, data flow, endpoints, dependencies, and entry points — with deeper Spring Boot structure when the repo is Java.
            </p>
            <p className="lang-note">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{display:"inline",verticalAlign:"-2px",marginRight:"5px"}}><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></svg>
              Architecture maps any public repo when an AI key is set. Spring Boot Java repos also get entity and endpoint detail.
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
            <div className="example-repos" role="group" aria-label="Example repositories">
              <span className="example-repos-label">Try one</span>
              {EXAMPLE_REPOS.map((example) => (
                <button
                  key={example.url}
                  type="button"
                  className="example-repo"
                  disabled={loading}
                  onClick={() => setUrl(example.url)}
                  title={example.url}
                >
                  <strong>{example.label}</strong>
                  <span>{example.hint}</span>
                </button>
              ))}
            </div>
            {error && <div className="error">{error}</div>}
          </div>
        </section>
        <section className="previews">
          <p className="section-kicker">After you map it</p>
          <h2>Eight readings of the same repo.</h2>
          <div className="preview-grid">
            {PREVIEWS.map((item) => (
              <article className="preview" key={item.label}>
                <div className={`sketch sketch-${item.sketch}`} aria-hidden="true">
                  {item.sketch === "cover" && <><i /><i /><i /><i /></>}
                  {item.sketch === "rooms" && <><b>API</b><b>Services</b><b>Data</b></>}
                  {item.sketch === "rail" && <><span /><span /><span /></>}
                  {item.sketch === "table" && <><span /><span /><span /></>}
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
      {sidebarOpen && (
        <button
          type="button"
          className="sidebar-overlay"
          aria-label="Close navigation"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={`sidebar${sidebarOpen ? " is-open" : ""}`}
        aria-label="Navigation"
        id="app-sidebar"
      >
        <div className="sidebar-top">
          <div className="sidebar-brand">
            <div className="sidebar-brand-main">
              <span className="brand-mark" aria-hidden="true">RM</span>
              <div className="sidebar-brand-copy">
                <span className="sidebar-brand-name">RepoMap</span>
                <span className="sidebar-brand-tag">Codebase map</span>
              </div>
            </div>
            <button
              type="button"
              className="sidebar-close"
              aria-label="Close navigation"
              onClick={() => setSidebarOpen(false)}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="sidebar-section">
            <p className="sidebar-section-label">Repos</p>
            <div className="sidebar-repos">
              {scans.map((scan) => {
                const source = sourceFor(scan);
                const isScanning = loading && scanningService === scan.service;
                return (
                  <div
                    key={scan.service}
                    className={`sidebar-repo${selected.service === scan.service ? " is-on" : ""}${isScanning ? " is-scanning" : ""}`}
                  >
                    <button
                      type="button"
                      className="sidebar-repo-open"
                      onClick={() => { setSelected(scan); setSection("overview"); setSidebarOpen(false); }}
                      title={scan.service}
                    >
                      <span className="sidebar-repo-dot" />
                      <span className="sidebar-repo-text">
                        <span className="sidebar-repo-name">{scan.service}</span>
                        {isScanning ? (
                          <span className="sidebar-repo-phase">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="spin-icon" aria-hidden="true"><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0" /></svg>
                            {phase || "Mapping…"}
                          </span>
                        ) : null}
                      </span>
                    </button>
                    <span className="sidebar-repo-actions">
                      <button
                        type="button"
                        className="sidebar-repo-action"
                        aria-label={`Scan ${scan.service} again`}
                        title={source ? "Scan again" : "No GitHub URL saved for this scan"}
                        disabled={loading || !source}
                        onClick={() => { void runScan(source); }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 00-9-9 9.75 9.75 0 00-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M3 12a9 9 0 009 9 9.75 9.75 0 006.74-2.74L21 16" /><path d="M16 16h5v5" /></svg>
                      </button>
                      <button
                        type="button"
                        className="sidebar-repo-action"
                        aria-label={`Remove ${scan.service}`}
                        title="Remove scan"
                        disabled={loading}
                        onClick={() => { void removeScan(scan.service); }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></svg>
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="sidebar-section sidebar-section-nav">
            <p className="sidebar-section-label">Views</p>
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
                  <span className="sidebar-nav-copy">
                    <span className="sidebar-nav-label">{item.label}</span>
                    <span className="sidebar-nav-hint">{item.hint}</span>
                  </span>
                </button>
              ))}
            </nav>
          </div>
        </div>

        <div className="sidebar-scan">
          <p className="sidebar-section-label">Map another</p>
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
              <span>
                {loading
                  ? (scanningService && scans.some((scan) => scan.service === scanningService)
                    ? "Scanning…"
                    : (phase || "Mapping…"))
                  : "Map repo"}
              </span>
            </button>
          </form>
          {error && <div className="sidebar-error">{error}</div>}
        </div>
      </aside>

      <div className="main-area">
        <header className="topbar">
          <button
            className="topbar-menu"
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open navigation"
            aria-expanded={sidebarOpen}
            aria-controls="app-sidebar"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="topbar-copy">
            <div className="topbar-title">{selected.service}</div>
            <div className="topbar-section">{NAV.find(n => n.id === section)?.label}</div>
          </div>
        </header>

        <div className="main-canvas">
          <DetailPanel
            scan={selected}
            sourceUrl={sourceFor(selected)}
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
}: {
  paths: FlowPath[];
  classes: FlowClass[];
  picked: string | null;
  onPick: (name: string | null) => void;
}) {
  function hopKey(pathIndex: number, hopName: string) {
    return `${pathIndex}::${hopName}`;
  }

  return (
    <div className="rails">
      <div className="flow-legend">
        <span className="fl-item fl-db"><i />Database / Repository</span>
        <span className="fl-item fl-logic"><i />Business logic</span>
        <span className="fl-item"><i />Other step</span>
      </div>
      {paths.map((path, pathIndex) => {
        const openName = picked?.startsWith(`${pathIndex}::`) ? picked.slice(picked.indexOf("::") + 2) : "";
        const open = openName ? classes.find((item) => item.name === openName) ?? null : null;
        return (
          <article className="rail" key={`${path.kind}-${path.entry}-${pathIndex}`}>
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
                const key = hopKey(pathIndex, hop.name);
                const isOn = picked === key;
                return (
                  <li className="flow-step-wrap" key={`${hop.role}-${hop.name}-${index}`}>
                    <button
                      type="button"
                      className={["flow-step", tone ? `is-${tone}` : "", isOn ? "is-on" : ""].filter(Boolean).join(" ")}
                      aria-expanded={isOn}
                      onClick={() => onPick(isOn ? null : key)}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                          event.preventDefault();
                          const nextIndex = event.key === "ArrowDown"
                            ? Math.min(path.hops.length - 1, index + 1)
                            : Math.max(0, index - 1);
                          onPick(hopKey(pathIndex, path.hops[nextIndex].name));
                          const root = event.currentTarget.closest("ol");
                          requestAnimationFrame(() => {
                            root
                              ?.querySelectorAll<HTMLButtonElement>("button.flow-step")
                              [nextIndex]?.focus();
                          });
                        } else if (event.key === "Escape" && isOn) {
                          event.preventDefault();
                          onPick(null);
                        }
                      }}
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
          </article>
        );
      })}
    </div>
  );
}

function moduleName(id: string) {
  return MODULE_LABEL[id] ?? id;
}

function diagramSource(chart: string, sourceUrl?: string, commit?: string) {
  const base = (sourceUrl || "").replace(/\.git$/, "");
  const sha = commit && commit !== "local" ? commit : "main";
  const body: string[] = [];
  const clicks: string[] = [];
  for (const line of chart.split("\n")) {
    if (line.startsWith("%% href\t")) {
      const [, id, file] = line.split("\t");
      if (base && id && file) clicks.push(`  click ${id} "${base}/blob/${sha}/${file}" _blank`);
      continue;
    }
    if (line.trimStart().startsWith("%%")) continue;
    body.push(line);
  }
  return protectFlowLabels([...body, ...clicks].join("\n").trim());
}

type DiagramView = "system" | "modules";

function ArchBoard({
  modules,
  chart,
  moduleChart,
  erd,
  service,
  classes,
  sourceUrl,
  commit,
}: {
  modules: import("@/lib/types").OverviewModule[];
  chart: string;
  moduleChart: string;
  erd: string;
  service: string;
  classes: FlowClass[];
  sourceUrl?: string;
  commit: string;
}) {
  const systemChart = diagramSource(chart, sourceUrl, commit);
  const modulesChart = diagramSource(moduleChart);
  const [view, setView] = useState<DiagramView>(systemChart ? "system" : "modules");
  const [picked, setPicked] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [copied, setCopied] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const zoomInnerRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState({ w: 0, h: 0 });

  useEffect(() => {
    setView(systemChart ? "system" : "modules");
    setPicked(null);
    setZoom(1);
  }, [service, commit, systemChart, modulesChart]);

  const activeChart = view === "system" && systemChart ? systemChart : modulesChart;
  const selectable = view === "system"
    ? classes.map((item) => item.name)
    : modules.map((item) => item.label);
  const pickedClass = classes.find((item) => item.name === picked) ?? null;
  const pickedModule = modules.find((item) => item.label === picked) ?? null;
  const fileUrl = sourceUrl && pickedClass?.file && commit
    ? `${sourceUrl.replace(/\.git$/, "")}/blob/${commit}/${pickedClass.file}`
    : "";

  // Measure the unscaled diagram so transform:scale can expand the scroll area.
  useEffect(() => {
    const inner = zoomInnerRef.current;
    if (!inner) return;
    const measure = () => {
      const svg = inner.querySelector("svg");
      if (svg) {
        const box = svg.viewBox?.baseVal;
        const w = box?.width || svg.clientWidth || inner.scrollWidth;
        const h = box?.height || svg.clientHeight || inner.scrollHeight;
        setNatural({ w: Math.ceil(w), h: Math.ceil(h) });
        return;
      }
      setNatural({ w: inner.scrollWidth, h: inner.scrollHeight });
    };
    measure();
    const timer = window.setInterval(measure, 200);
    const stop = window.setTimeout(() => window.clearInterval(timer), 2500);
    const ro = new ResizeObserver(measure);
    ro.observe(inner);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(stop);
      ro.disconnect();
    };
  }, [activeChart, view, service]);

  function fitToCanvas() {
    const canvas = canvasRef.current;
    if (!canvas || natural.w <= 0) {
      setZoom(1);
      return;
    }
    const available = Math.max(120, canvas.clientWidth - 40);
    const next = Math.min(1.5, Math.max(0.35, available / natural.w));
    setZoom(Math.round(next * 100) / 100);
  }

  async function copyMermaid() {
    try {
      await navigator.clipboard.writeText(activeChart);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="arch-board">
      <div className="diagram-toolbar">
        <div className="method-filters" role="group" aria-label="Diagram">
          {systemChart && (
            <button type="button" className={view === "system" ? "is-on" : ""} onClick={() => { setView("system"); setPicked(null); setZoom(1); }}>
              System
            </button>
          )}
          {modulesChart && (
            <button type="button" className={view === "modules" ? "is-on" : ""} onClick={() => { setView("modules"); setPicked(null); setZoom(1); }}>
              Modules
            </button>
          )}
        </div>
        <div className="diagram-toolbar-actions">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setZoom((value) => Math.max(0.35, Math.round((value - 0.15) * 100) / 100))}
            aria-label="Zoom out"
          >
            −
          </button>
          <button type="button" className="btn-ghost" onClick={() => fitToCanvas()} title="Fit diagram to the panel width">
            Fit
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setZoom((value) => Math.min(2.5, Math.round((value + 0.15) * 100) / 100))}
            aria-label="Zoom in"
          >
            +
          </button>
          <span className="zoom-readout" aria-live="polite">{Math.round(zoom * 100)}%</span>
          <button type="button" className="btn-ghost" onClick={() => { void copyMermaid(); }} disabled={!activeChart}>
            {copied ? "Mermaid copied" : "Copy Mermaid"}
          </button>
        </div>
      </div>

      {activeChart ? (
        <div className="diagram-canvas" ref={canvasRef}>
          <div
            className="diagram-zoom-frame"
            style={{
              width: natural.w ? `${Math.ceil(natural.w * zoom)}px` : undefined,
              height: natural.h ? `${Math.ceil(natural.h * zoom)}px` : undefined,
            }}
          >
            <div
              className="diagram-zoom"
              ref={zoomInnerRef}
              style={{
                transform: `scale(${zoom})`,
                transformOrigin: "top left",
              }}
            >
              <MermaidDiagram
                chart={activeChart}
                id={`${service}-${view}`}
                selectable={selectable}
                active={picked}
                onPick={setPicked}
              />
            </div>
          </div>
        </div>
      ) : (
        <p className="summary">This scan has no architecture diagram yet. Map the repo again.</p>
      )}

      {pickedClass && (
        <aside className="diagram-detail">
          <div>
            <strong>{pickedClass.name}</strong>
            <span>{pickedClass.role}</span>
          </div>
          {pickedClass.file && <code>{pickedClass.file}</code>}
          {pickedClass.note && <p>{pickedClass.note}</p>}
          {fileUrl && <a href={fileUrl} target="_blank" rel="noreferrer">Open on GitHub</a>}
          {pickedClass.members.length > 0 && (
            <ul>
              {pickedClass.members.slice(0, 12).map((member) => (
                <li key={`${member.kind}-${member.name}`}><code>{member.name}</code> {member.note}</li>
              ))}
            </ul>
          )}
        </aside>
      )}

      {pickedModule && !pickedClass && (
        <aside className="diagram-detail">
          <div>
            <strong>{moduleName(pickedModule.id)}</strong>
            <span>{pickedModule.files} files</span>
          </div>
          <p>{MODULE_ABOUT[pickedModule.id] ?? pickedModule.label}</p>
          {(pickedModule.classes ?? []).length > 0 && (
            <ul>
              {(pickedModule.classes ?? []).map((name) => <li key={name}><code>{name}</code></li>)}
            </ul>
          )}
        </aside>
      )}

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
  const starts = entries.filter((entry) => entry.detail.includes("Spring Boot application") || entry.detail.includes("starts in") || entry.name === "Docker");
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
        <p className="summary">No run command was found in the build files or README.</p>
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
      state: health?.churn ? "ok" : "unknown",
      detail: health?.churn || "No commit diff in this clone.",
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

  const keyPaths = paths.filter((path) =>
    path.hops.some((hop) => /repository|entity|database|db|dao|mapper/i.test(`${hop.role} ${hop.name}`))
  );
  const shownPaths = keyPaths.length > 0 ? keyPaths : paths.slice(0, 8);

  const pageTitle: Record<Exclude<SectionId, "overview">, { title: string; hint: string }> = {
    modules:  { title: "Architecture",   hint: "The system as a diagram. Click a box to see the classes in it. Copy Mermaid if you want the source." },
    flow:     { title: "Data flow",      hint: "Pick a route and a diagram type. Call chain shows numbered steps. Sequence shows actor messages. Transaction shows DB scope." },
    deps:     { title: "Dependencies",   hint: "Which group uses which, then the libraries in the build file." },
    endpoints:{ title: "Endpoints",      hint: "Every HTTP route this scan found. Filter by method, path, or entity." },
    entry:    { title: "Entry points",   hint: "If you want to run this, start here." },
    key:      { title: "Key paths",      hint: "Request paths that reach persistence or storage. Click a step to see its methods." },
    health:   { title: "Health",         hint: "Test files, CI workflows, and the latest commit from the clone. Stars and open issues from GitHub." },
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
              (overview?.moduleDiagram || scan.diagrams.architecture) ? (
                <ArchBoard
                  modules={overview?.modules ?? []}
                  chart={scan.diagrams.architecture}
                  moduleChart={overview?.moduleDiagram ?? ""}
                  erd={scan.diagrams.erd}
                  service={scan.service}
                  classes={flowClasses}
                  sourceUrl={sourceUrl}
                  commit={scan.commit}
                />
              ) : (
                <p className="summary">Map this repo again to draw its architecture.</p>
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
            {section === "endpoints" && <EndpointBoard scan={scan} />}
            {section === "deps" && <Dependencies scan={scan} />}
            {section === "entry" && <Runbook scan={scan} />}
            {section === "key" && (
              paths.length > 0 ? (
                <FlowBoard paths={shownPaths} classes={flowClasses} picked={picked} onPick={setPicked} />
              ) : (
                <p className="summary">Map this repo again. This result has no request path yet.</p>
              )
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

const METHOD_ORDER = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function methodRank(method: string) {
  const index = METHOD_ORDER.indexOf(method.toUpperCase());
  return index === -1 ? METHOD_ORDER.length : index;
}

function downloadScan(scan: ScanResult) {
  const { previous: _previous, ...rest } = scan;
  const blob = new Blob([JSON.stringify(rest, null, 2) + "\n"], { type: "application/json" });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = `${scan.service}.json`;
  link.click();
  URL.revokeObjectURL(href);
}

function ScanActions({ scan }: { scan: ScanResult }) {
  const [copied, setCopied] = useState(false);

  async function copyLink() {
    const link = `${window.location.origin}/scans/${encodeURIComponent(scan.service)}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="scan-actions">
      <button type="button" className="btn-ghost" onClick={() => { void copyLink(); }}>
        {copied ? "Link copied" : "Copy link"}
      </button>
      <button type="button" className="btn-ghost" onClick={() => downloadScan(scan)}>
        Export JSON
      </button>
    </div>
  );
}

function DiffBoard({ scan }: { scan: ScanResult }) {
  const previous = scan.previous;
  if (!previous) return null;
  const diff = compareScans(scan, previous);
  const entityDelta = diff.entitiesAfter - diff.entitiesBefore;
  const structureSame =
    entityDelta === 0 &&
    diff.entitiesAdded.length === 0 &&
    diff.entitiesRemoved.length === 0;
  return (
    <section className="diff-card">
      <div className="diff-head">
        <h2 className="section-title">Since last scan</h2>
        <p>Compared with the previous result stored for this repo.</p>
      </div>
      {structureSame ? (
        <p className="summary">Entities and structure look the same as the last scan.</p>
      ) : (
        <>
          <div className="diff-stats">
            <article>
              <span>Entities</span>
              <strong>{diff.entitiesBefore} → {diff.entitiesAfter}</strong>
              <em>{entityDelta > 0 ? `+${entityDelta}` : entityDelta}</em>
            </article>
          </div>
          {diff.entitiesAdded.length > 0 && <p className="summary">New entities: {diff.entitiesAdded.join(", ")}</p>}
          {diff.entitiesRemoved.length > 0 && <p className="summary">Removed entities: {diff.entitiesRemoved.join(", ")}</p>}
        </>
      )}
    </section>
  );
}

function EndpointBoard({ scan }: { scan: ScanResult }) {
  const [query, setQuery] = useState("");
  const [method, setMethod] = useState("ALL");

  useEffect(() => {
    setQuery("");
    setMethod("ALL");
  }, [scan.service, scan.commit]);

  const methods = [...new Set(scan.endpoints.map((endpoint) => endpoint.method || ""))].sort((a, b) => methodRank(a) - methodRank(b) || a.localeCompare(b));
  const needle = query.trim().toLowerCase();
  const rows = scan.endpoints.filter((endpoint) => {
    if (method !== "ALL" && endpoint.method !== method) return false;
    if (!needle) return true;
    const haystack = `${endpoint.method} ${endpoint.path} ${endpoint.entity ?? ""}`.toLowerCase();
    return haystack.includes(needle);
  });

  if (scan.endpoints.length === 0) {
    return <p className="summary">This scan did not find any HTTP endpoints.</p>;
  }

  return (
    <div className="endpoint-board">
      <div className="endpoint-toolbar">
        <label className="endpoint-search">
          <span>Filter</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Path or entity"
            aria-label="Filter endpoints"
          />
        </label>
        <div className="method-filters" role="group" aria-label="HTTP method">
          <button type="button" className={method === "ALL" ? "is-on" : ""} onClick={() => setMethod("ALL")}>All</button>
          {methods.map((item) => (
            <button key={item} type="button" className={method === item ? "is-on" : ""} onClick={() => setMethod(item)}>
              {item || "—"}
            </button>
          ))}
        </div>
      </div>
      <p className="summary">{rows.length} of {scan.endpoints.length}</p>
      {rows.length === 0 ? (
        <p className="summary">Nothing matches that filter.</p>
      ) : (
        <div className="endpoint-scroll">
          <table className="endpoint-table">
            <thead>
              <tr>
                <th>Method</th>
                <th>Path</th>
                <th>Entity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((endpoint, index) => (
                <tr key={`${endpoint.method}-${endpoint.path}-${endpoint.entity ?? ""}-${index}`}>
                  <td><span className={`method method-${(endpoint.method || "other").toLowerCase()}`}>{endpoint.method || "—"}</span></td>
                  <td><code>{endpoint.path}</code></td>
                  <td>{endpoint.entity || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function plainBlurb(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#*_`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  const why = plainBlurb(identity?.why || meta?.description || "");
  const libraries = overview?.dependencies.external.length ?? 0;
  const run = overview?.checklist.find((step) => step.title === "Run locally")?.detail
    || overview?.checklist.find((step) => step.title === "Tests")?.detail
    || "";
  const figures = [
    { value: String(paths.length), label: "Routes", nav: "flow" as SectionId },
    { value: String(scan.endpoints.length), label: "Endpoints", nav: "endpoints" as SectionId },
    { value: String(scan.entities.length), label: "Entities", nav: "modules" as SectionId },
    { value: String(libraries), label: "Libraries", nav: "deps" as SectionId },
  ];
  const facts = [
    ["Language", identity?.language || meta?.language || ""],
    ["Stack", (identity?.stack ?? []).join(", ")],
    ["License", identity?.license || meta?.license || ""],
    ["Commit", scan.commit ? scan.commit.slice(0, 12) : ""],
    ["Stars", meta?.stars != null ? formatCount(meta.stars) : ""],
    ["Run", run],
  ].filter(([, value]) => value);

  return (
    <div className="cover">
      <header className="page-head">
        <div className="overview-header">
          <div className="overview-header-main">
            <p className="eyebrow">Overview</p>
            <h1 className="page-head-title">{scan.service}</h1>
            {why && <p className="why">{why}</p>}
            {scan.summary && !scan.summary.startsWith("<") && (
              <p className="summary">
                {plainBlurb(scan.summary)
                  .replace(/,?\s*\d+\s+findings?/i, "")
                  .replace(/\s+,/g, ",")
                  .replace(/\s+/g, " ")
                  .trim()}
              </p>
            )}
            <div className="overview-meta-row">
              {identity?.language && <span className="overview-chip">{identity.language}</span>}
              {(identity?.stack ?? []).slice(0, 3).map((item) => (
                <span className="overview-chip" key={item}>{item}</span>
              ))}
            </div>
            <ScanActions scan={scan} />
          </div>
        </div>
      </header>

      {scan.previous && <DiffBoard scan={scan} />}

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
    </div>
  );
}

function formatCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
