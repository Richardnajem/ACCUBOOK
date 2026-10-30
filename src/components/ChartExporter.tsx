"use client";

import { useEffect } from "react";
import { chartLabelFromElement, downloadChartPng } from "@/lib/chart-export";

// ─── ChartExporter ──────────────────────────────────────────────────────
// Recharts renders every chart as `.recharts-wrapper > svg.recharts-surface`.
// Instead of adding an export button to each chart by hand (there are dozens
// across the dashboard, research, mega-indicator, backtest and strategy
// screens), this mounts once and decorates whichever charts are on screen —
// line, area, bar, scatter and the circular pie/donut allocation charts.
//
// The button lives in the chart wrapper, so a panel that is maximised into a
// portal gets its own button, and charts that mount later (a backtest run
// finishing) are picked up by the MutationObserver.

const DECORATED = "data-stockfolio-chart-export";
const SCAN_DELAY_MS = 250;

export function ChartExporter() {
  useEffect(() => {
    let timer: number | undefined;

    const exportChart = async (button: HTMLButtonElement, wrapper: HTMLElement) => {
      // Re-query: a re-render may have swapped the <svg> since decoration.
      const svg = wrapper.querySelector<SVGSVGElement>("svg.recharts-surface");
      if (!svg) return;
      const label = chartLabelFromElement(wrapper);
      const original = button.textContent ?? "PNG";
      button.disabled = true;
      button.textContent = "…";
      try {
        await downloadChartPng(svg, label);
        button.textContent = "Saved";
        window.setTimeout(() => { button.textContent = original; }, 1200);
      } catch (error) {
        // Visible failure beats a button that silently does nothing.
        console.error("Chart export failed", error);
        button.textContent = "Failed";
        window.setTimeout(() => { button.textContent = original; }, 1600);
      } finally {
        button.disabled = false;
      }
    };

    const decorate = () => {
      document.querySelectorAll<HTMLElement>(".recharts-wrapper").forEach((wrapper) => {
        if (wrapper.hasAttribute(DECORATED)) return;
        if (!wrapper.querySelector("svg.recharts-surface")) return;
        wrapper.setAttribute(DECORATED, "true");
        if (window.getComputedStyle(wrapper).position === "static") {
          wrapper.style.position = "relative";
        }

        const button = document.createElement("button");
        button.type = "button";
        button.className = "chart-export-btn no-print";
        button.title = "Download this chart as a PNG";
        button.setAttribute("aria-label", "Download this chart as a PNG");
        button.textContent = "PNG";
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          void exportChart(button, wrapper);
        });
        wrapper.appendChild(button);
      });
    };

    // Tooltips rewrite DOM on every pointer move; debounce the scan so seeing
    // the same chart never costs a querySelectorAll per frame.
    const schedule = () => {
      if (timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        decorate();
      }, SCAN_DELAY_MS);
    };

    decorate();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      if (timer !== undefined) window.clearTimeout(timer);
      document.querySelectorAll(".chart-export-btn").forEach((node) => node.remove());
      document.querySelectorAll(`[${DECORATED}]`).forEach((node) => node.removeAttribute(DECORATED));
    };
  }, []);

  return null;
}
