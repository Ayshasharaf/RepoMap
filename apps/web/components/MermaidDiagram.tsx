"use client";

import { useEffect, useRef } from "react";

interface Props {
  chart: string;
  id: string;
  selectable?: string[];
  active?: string | null;
  onPick?: (name: string) => void;
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

export default function MermaidDiagram({ chart, id, selectable, active, onPick }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const onPickRef = useRef(onPick);
  const activeRef = useRef(active);
  onPickRef.current = onPick;
  activeRef.current = active;
  const selectableKey = (selectable ?? []).join("\0");

  useEffect(() => {
    if (!chart || !ref.current) return;

    let cancelled = false;
    const names = selectableKey ? selectableKey.split("\0") : [];

    import("mermaid").then((mod) => {
      if (cancelled) return;
      const mermaid = mod.default;
      mermaid.initialize({
        startOnLoad: false,
        theme: "base",
        securityLevel: "loose",
        fontFamily: "Inter, system-ui, sans-serif",
        themeVariables: {
          fontSize: "14px",
          lineColor: "#5c5f6b",
          textColor: "#0a0b14",
          primaryColor: "#ffffff",
          primaryBorderColor: "#e4e5ea",
          primaryTextColor: "#0a0b14",
          secondaryColor: "#f5f5f7",
          tertiaryColor: "#f5f5f7",
          background: "#ffffff",
          mainBkg: "#ffffff",
          nodeBorder: "#e4e5ea",
          clusterBkg: "#f5f5f7",
          titleColor: "#0a0b14",
          actorBkg: "#ffffff",
          actorBorder: "#173ded",
          actorTextColor: "#0a0b14",
          signalColor: "#0a0b14",
          signalTextColor: "#0a0b14",
          labelBoxBkgColor: "#ffffff",
          labelBoxBorderColor: "#e4e5ea",
          loopTextColor: "#0a0b14",
          noteBkgColor: "#f5f5f7",
          noteTextColor: "#0a0b14",
          noteBorderColor: "#e4e5ea",
          activationBkgColor: "#e8edff",
          activationBorderColor: "#173ded",
          sequenceNumberColor: "#ffffff",
        },
        sequence: { useMaxWidth: false, diagramMarginX: 12, diagramMarginY: 12 },
        flowchart: {
          useMaxWidth: false,
          htmlLabels: true,
          curve: "basis",
          padding: 16,
          nodeSpacing: 36,
          rankSpacing: 48,
        },
        er: { useMaxWidth: false, fontSize: 14 },
      });

      const container = ref.current!;
      container.innerHTML = "";
      const drawable = chart
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("%%"))
        .join("\n");

      mermaid
        .render(`mermaid-${id}-${Date.now()}`, drawable)
        .then(({ svg }) => {
          if (cancelled || !ref.current) return;
          ref.current.innerHTML = svg;
          const svgEl = ref.current.querySelector("svg");
          if (!svgEl) return;
          const box = svgEl.viewBox?.baseVal;
          svgEl.style.display = "block";
          svgEl.style.height = "auto";
          if (box && box.width > 0 && box.height > 0) {
            svgEl.removeAttribute("width");
            svgEl.removeAttribute("height");
            svgEl.style.width = "100%";
            svgEl.style.maxWidth = `${Math.ceil(box.width)}px`;
          }
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
        })
        .catch((err) => {
          if (!cancelled && ref.current) {
            ref.current.textContent = `Diagram error: ${err}`;
          }
        });
    });

    return () => {
      cancelled = true;
    };
  }, [chart, id, selectableKey]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.querySelectorAll("g.node").forEach((node) => {
      node.classList.toggle("is-picked", !!active && node.getAttribute("data-class") === active);
    });
  }, [active, chart, selectableKey]);

  return <div ref={ref} className="diagram-scroll" />;
}
