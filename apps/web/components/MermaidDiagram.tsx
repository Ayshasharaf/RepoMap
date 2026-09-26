"use client";

import { useEffect, useRef } from "react";

interface Props {
  chart: string;
  id: string;
  selectable?: string[];
  active?: string | null;
  onPick?: (name: string) => void;
}

function matchClass(text: string, names: string[]): string | null {
  const compact = text.replace(/\s+/g, "");
  const ordered = [...names].sort((a, b) => b.length - a.length);
  for (const name of ordered) {
    if (compact.endsWith(name)) return name;
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
          fontSize: "15px",
          lineColor: "#5c5f6b",
          textColor: "#0a0b14",
          primaryColor: "#edf1ff",
          primaryBorderColor: "#173ded",
          primaryTextColor: "#0a0b14",
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
        .filter((line) => !line.startsWith("%% flow\t") && !line.startsWith("%% path\t"))
        .join("\n");

      mermaid
        .render(`mermaid-${id}-${Date.now()}`, drawable)
        .then(({ svg }) => {
          if (cancelled || !ref.current) return;
          ref.current.innerHTML = svg;
          const svgEl = ref.current.querySelector("svg");
          if (!svgEl) return;
          const box = svgEl.viewBox?.baseVal;
          svgEl.style.maxWidth = "none";
          svgEl.style.display = "block";
          if (box && box.width > 0 && box.height > 0) {
            svgEl.style.width = `${Math.ceil(box.width)}px`;
            svgEl.style.height = `${Math.ceil(box.height)}px`;
          }
          if (!names.length) return;
          svgEl.querySelectorAll("g.node").forEach((node) => {
            const matched = matchClass(node.textContent || "", names);
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
