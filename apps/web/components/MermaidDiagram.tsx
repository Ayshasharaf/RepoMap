"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  chart: string;
  id: string;
  selectable?: string[];
  active?: string | null;
  onPick?: (name: string) => void;
}

/** Mermaid erDiagram: PK/FK/UK are key suffixes, never the type. Fix saved scans. */
export function sanitizeErd(chart: string): string {
  if (!chart.trimStart().startsWith("erDiagram")) return chart;
  return chart
    .split("\n")
    .map((line) => {
      const match = line.match(/^(\s+)(PK|FK|UK)\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i);
      if (!match) return line;
      return `${match[1]}string ${match[3]} ${match[2].toUpperCase()}`;
    })
    .join("\n");
}

function decodeFileBrackets(text: string): string {
  const hash = "\uFF03";
  return text
    .replace(new RegExp(`&#91;|&${hash}91;`, "g"), "[")
    .replace(new RegExp(`&#93;|&${hash}93;`, "g"), "]");
}

/** Turn stored bracket codes back into [file.ext], and distinguish duplicate names. */
export function protectFlowLabels(chart: string): string {
  const lines = chart.split("\n").map((line) => {
    const trimmed = line.trimStart();
    if (
      trimmed.startsWith("click ") ||
      trimmed.startsWith("classDef ") ||
      trimmed.startsWith("class ") ||
      trimmed.startsWith("style ")
    ) {
      return line;
    }
    return line.replace(/"([^"\n]*)"/g, (_match, inner: string) => `"${decodeFileBrackets(inner)}"`);
  });

  const files = new Map<string, string>();
  for (const line of lines) {
    const match = line.trimStart().match(/^click\s+(\S+)\s+"[^"]*\/blob\/[^/]+\/([^"]+)"/);
    if (match) files.set(match[1], match[2]);
  }
  const baseCount = new Map<string, number>();
  for (const file of files.values()) {
    const base = file.split("/").pop() || file;
    baseCount.set(base, (baseCount.get(base) || 0) + 1);
  }

  return lines
    .map((line) => {
      const match = line.match(/^(\s*)(\w+)(\[")(.*?)("\])$/);
      if (!match) return line;
      const [, indent, id, open, inner, close] = match;
      const file = files.get(id);
      if (!file) return line;
      const base = file.split("/").pop() || file;
      if ((baseCount.get(base) || 0) < 2 || !inner.includes(`[${base}]`)) return line;
      const parent = file.split("/").slice(-2, -1)[0] || "";
      const caption = parent ? `${parent}/${base}` : base;
      return `${indent}${id}${open}${inner.replace(`[${base}]`, `[${caption}]`)}${close}`;
    })
    .join("\n");
}

function matchNode(node: Element, names: string[]): string | null {
  const id = node.getAttribute("id") || "";
  const compact = (node.textContent || "").replace(/\s+/g, "");
  const ordered = [...names].sort((a, b) => b.replace(/\s+/g, "").length - a.replace(/\s+/g, "").length);
  for (const name of ordered) {
    const token = name.replace(/\s+/g, "");
    if (!token) continue;
    if (id.includes(token) || compact.endsWith(token) || compact.startsWith(token)) return name;
  }
  return null;
}

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, text: string) => Promise<{ svg: string }>;
};

let mermaidReady: Promise<MermaidApi> | null = null;
/** Mermaid keeps global DOM state — parallel renders scramble ERDs on first paint. */
let renderChain: Promise<unknown> = Promise.resolve();

function getMermaid(): Promise<MermaidApi> {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then(async (mod) => {
      const mermaid = mod.default as MermaidApi;
      mermaid.initialize({
        startOnLoad: false,
        theme: "base",
        securityLevel: "loose",
        fontFamily: "IBM Plex Mono, ui-monospace, Inter, system-ui, sans-serif",
        themeVariables: {
          fontSize: "14px",
          lineColor: "#3d4460",
          textColor: "#0a0b14",
          primaryColor: "#eef2ff",
          primaryBorderColor: "#173ded",
          primaryTextColor: "#0a0b14",
          secondaryColor: "#f5f5f7",
          tertiaryColor: "#e8edff",
          background: "#ffffff",
          mainBkg: "#ffffff",
          nodeBorder: "#173ded",
          clusterBkg: "#f0f3ff",
          clusterBorder: "#b8c4f0",
          titleColor: "#0a0b14",
          edgeLabelBackground: "#ffffff",
          actorBkg: "#eef2ff",
          actorBorder: "#173ded",
          actorTextColor: "#0a0b14",
          actorLineColor: "#8b93ad",
          signalColor: "#0a0b14",
          signalTextColor: "#0a0b14",
          labelBoxBkgColor: "#ffffff",
          labelBoxBorderColor: "#c5c9d6",
          loopTextColor: "#0a0b14",
          noteBkgColor: "#fbf3dd",
          noteTextColor: "#0a0b14",
          noteBorderColor: "#d4b86a",
          activationBkgColor: "#e8edff",
          activationBorderColor: "#173ded",
          sequenceNumberColor: "#ffffff",
          // ER diagram
          entityBkg: "#ffffff",
          entityBorder: "#173ded",
          entityTextColor: "#0a0b14",
          attributeBackgroundColorOdd: "#f7f8fc",
          attributeBackgroundColorEven: "#eef2ff",
          relationshipLabelBackground: "#ffffff",
          relationshipLabelColor: "#5c5f6b",
        },
        sequence: { useMaxWidth: false, diagramMarginX: 12, diagramMarginY: 12 },
        flowchart: {
          useMaxWidth: false,
          htmlLabels: true,
          curve: "linear",
          padding: 22,
          nodeSpacing: 48,
          rankSpacing: 64,
        },
        er: {
          useMaxWidth: true,
          fontSize: 13,
          entityPadding: 12,
          layoutDirection: "TB",
        },
      });
      if (typeof document !== "undefined" && document.fonts?.ready) {
        try {
          await document.fonts.ready;
        } catch {
          /* ignore */
        }
      }
      return mermaid;
    });
  }
  return mermaidReady;
}

function renderMermaid(renderId: string, text: string): Promise<{ svg: string }> {
  const job = renderChain.then(async () => {
    const mermaid = await getMermaid();
    return mermaid.render(renderId, text);
  });
  // Keep the queue moving even if one diagram fails.
  renderChain = job.catch(() => undefined);
  return job;
}

function sizeSvg(svgEl: SVGSVGElement, fitPanel: boolean, container?: HTMLElement | null) {
  const box = svgEl.viewBox?.baseVal;
  svgEl.style.display = "block";
  svgEl.style.height = "auto";
  if (fitPanel) {
    // ERD: scale into the panel (width + ~half viewport height), never blow past 1×.
    const maxW = Math.max(
      200,
      (container?.clientWidth || container?.parentElement?.clientWidth || 720) - 8,
    );
    const maxH = Math.min(Math.round(window.innerHeight * 0.5), 480);
    if (box && box.width > 0 && box.height > 0) {
      const scale = Math.min(1, maxW / box.width, maxH / box.height);
      const w = Math.max(1, Math.ceil(box.width * scale));
      const h = Math.max(1, Math.ceil(box.height * scale));
      svgEl.setAttribute("width", String(w));
      svgEl.setAttribute("height", String(h));
      svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
      svgEl.style.width = `${w}px`;
      svgEl.style.height = `${h}px`;
      svgEl.style.maxWidth = "100%";
      svgEl.style.marginInline = "auto";
      return;
    }
    svgEl.removeAttribute("width");
    svgEl.removeAttribute("height");
    svgEl.style.width = "100%";
    svgEl.style.maxWidth = "100%";
    svgEl.style.maxHeight = `${maxH}px`;
    return;
  }
  if (box && box.width > 0 && box.height > 0) {
    // Flowcharts: intrinsic size so +/- zoom has a fixed base.
    svgEl.setAttribute("width", String(Math.ceil(box.width)));
    svgEl.setAttribute("height", String(Math.ceil(box.height)));
    svgEl.style.width = `${Math.ceil(box.width)}px`;
    svgEl.style.maxWidth = "none";
  }
}

export default function MermaidDiagram({ chart, id, selectable, active, onPick }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const onPickRef = useRef(onPick);
  const activeRef = useRef(active);
  onPickRef.current = onPick;
  activeRef.current = active;
  const selectableKey = (selectable ?? []).join("\0");
  const isErd = chart.trimStart().startsWith("erDiagram");
  const [loading, setLoading] = useState(Boolean(chart));

  useEffect(() => {
    if (!chart || !ref.current) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const names = selectableKey ? selectableKey.split("\0") : [];
    const drawable = sanitizeErd(chart)
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("%%"))
      .join("\n");

    // Stable-enough id; queue avoids Mermaid's global DOM collisions.
    const renderId = `mmd-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Math.random().toString(36).slice(2, 9)}`;

    const paint = async () => {
      try {
        const { svg } = await renderMermaid(renderId, drawable);
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = svg;
        const svgEl = ref.current.querySelector("svg");
        if (!svgEl) return;
        sizeSvg(svgEl, isErd, ref.current);
        if (!names.length) return;
        svgEl.querySelectorAll("g.node").forEach((node) => {
          const matched = matchNode(node, names);
          if (!matched) return;
          node.classList.add("is-class");
          node.setAttribute("data-class", matched);
          if (matched === activeRef.current) node.classList.add("is-picked");
          node.addEventListener("click", (event) => {
            event.stopPropagation();
            onPickRef.current?.(matched);
          });
        });
      } catch (err) {
        if (!cancelled && ref.current) {
          ref.current.textContent = `Diagram error: ${err}`;
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void paint();

    if (!isErd) {
      return () => {
        cancelled = true;
      };
    }

    const onResize = () => {
      const svgEl = ref.current?.querySelector("svg");
      if (svgEl) sizeSvg(svgEl, true, ref.current);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
    };
  }, [chart, id, selectableKey, isErd]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.querySelectorAll("g.node").forEach((node) => {
      node.classList.toggle("is-picked", !!active && node.getAttribute("data-class") === active);
    });
  }, [active, chart, selectableKey]);

  return (
    <div className={`diagram-wrap${loading ? " is-loading" : ""}${isErd ? " is-erd" : ""}`}>
      {loading && (
        <div className="diagram-loading" role="status" aria-live="polite">
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="spin-icon"
            aria-hidden="true"
          >
            <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0" />
          </svg>
          <span>{isErd ? "Drawing ERD…" : "Drawing diagram…"}</span>
        </div>
      )}
      <div ref={ref} className={`diagram-scroll${isErd ? " is-erd" : ""}`} />
    </div>
  );
}
