/**
 * Chart → PNG export.
 *
 * Every Recharts chart in the app is an inline `<svg>`, so one helper can save
 * ANY of them — line, area, bar, scatter and the circular pie/donut charts.
 * The SVG is cloned, the computed styles are baked in (Recharts draws with
 * theme CSS variables such as `var(--muted)`, which mean nothing in a
 * standalone file), an opaque background is added, and the result is drawn to
 * a 2× canvas so the PNG stays crisp on high-DPI screens.
 *
 * The filename comes from the nearest heading (`chartLabelFromElement`), so
 * "Allocation" exports as `stockfolio-allocation-YYYYMMDD-HHMM.png`.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** Presentation properties that must be inlined for the SVG to look right offline. */
const INLINE_PROPS = [
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "letter-spacing",
  "text-anchor",
  "dominant-baseline",
  "paint-order",
  "shape-rendering",
];

const pad = (n: number) => String(n).padStart(2, "0");

/** Filesystem-safe slug for a chart title ("Total Equity" → "total-equity"). */
export function chartSlug(label: string): string {
  return (
    (label || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "chart"
  );
}

/** `stockfolio-total-equity-20260105-0907.png` — timestamp keeps exports apart. */
export function chartFileName(label: string, now: Date = new Date()): string {
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `stockfolio-${chartSlug(label)}-${stamp}.png`;
}

/**
 * Best available name for a chart: an explicit `data-chart-title`, then the
 * nearest heading on the card, then the page title. Walks a few ancestors so a
 * chart nested in a panel body still finds the panel's `h3`.
 */
export function chartLabelFromElement(el: Element | null): string {
  let node: Element | null = el;
  for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
    const explicit = node.getAttribute("data-chart-title");
    if (explicit && explicit.trim()) return explicit.trim();
    const heading = node.querySelector("h2, h3, h4");
    const text = heading?.textContent?.trim();
    if (text) return text;
  }
  if (typeof document !== "undefined" && document.title) {
    return document.title.split("—")[0].trim() || "Stockfolio";
  }
  return "Stockfolio";
}

function alphaOf(color: string): number {
  if (!color || color === "transparent") return 0;
  const match = color.match(/rgba?\(([^)]+)\)/i);
  if (!match) return 1;
  const parts = match[1].split(",").map((p) => p.trim());
  return parts.length === 4 ? Number(parts[3]) : 1;
}

/** First opaque background above the chart, so the PNG is not transparent. */
function resolveBackground(el: Element): string {
  let node: Element | null = el;
  while (node) {
    const bg = window.getComputedStyle(node).backgroundColor;
    if (alphaOf(bg) >= 1) return bg;
    node = node.parentElement;
  }
  return "#0b1020";
}

/**
 * Clone the live chart SVG into a standalone document: explicit size, inlined
 * computed styles and an opaque background rect. Exported for reuse/tests that
 * run in a browser; the pure filename helpers above are the unit-tested ones.
 */
export function serializeChartSvg(
  svg: SVGSVGElement,
  width: number,
  height: number,
  background: string,
): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", SVG_NS);
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${width} ${height}`);

  // The clone has the same node order as the source, so styles can be matched
  // pairwise — attributes alone miss CSS-driven colours (e.g. `currentColor`).
  const sourceNodes = [svg, ...Array.from(svg.querySelectorAll<SVGElement>("*"))];
  const cloneNodes = [clone, ...Array.from(clone.querySelectorAll<SVGElement>("*"))];
  for (let i = 0; i < sourceNodes.length && i < cloneNodes.length; i += 1) {
    const computed = window.getComputedStyle(sourceNodes[i]);
    let declarations = cloneNodes[i].getAttribute("style") ?? "";
    for (const prop of INLINE_PROPS) {
      const value = computed.getPropertyValue(prop);
      if (value) declarations += `${prop}:${value};`;
    }
    cloneNodes[i].setAttribute("style", declarations);
  }

  const backdrop = document.createElementNS(SVG_NS, "rect");
  backdrop.setAttribute("x", "0");
  backdrop.setAttribute("y", "0");
  backdrop.setAttribute("width", String(width));
  backdrop.setAttribute("height", String(height));
  backdrop.setAttribute("fill", background);
  clone.insertBefore(backdrop, clone.firstChild);

  return new XMLSerializer().serializeToString(clone);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not rasterise the chart"));
    image.src = src;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Canvas produced no image"))),
      "image/png",
    );
  });
}

/** Start a download for a generated blob and clean the object URL afterwards. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can abort the save in some browsers/Electron.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Save any chart SVG as a PNG. Throws when the chart has no measurable size or
 * the browser refuses to rasterise it — callers surface that in the UI rather
 * than silently doing nothing.
 */
export async function downloadChartPng(
  svg: SVGSVGElement,
  label: string,
  options: { scale?: number; background?: string } = {},
): Promise<void> {
  const rect = svg.getBoundingClientRect();
  const width = Math.round(rect.width || svg.clientWidth || 0);
  const height = Math.round(rect.height || svg.clientHeight || 0);
  if (!width || !height) throw new Error("Chart has no size to export");

  const scale = options.scale ?? 2;
  const background = options.background ?? resolveBackground(svg);

  // Web fonts must be ready, or the PNG falls back to a different typeface.
  try {
    await document.fonts.ready;
  } catch {
    /* no font API — the export still works with system fonts */
  }

  const markup = serializeChartSvg(svg, width, height, background);
  const svgUrl = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = await loadImage(svgUrl);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is unavailable");
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    saveBlob(await canvasToBlob(canvas), chartFileName(label));
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}
