// ─── CSV Export ─────────────────────────────────────────────────
export function downloadCSV(filename: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  const csvContent = [
    headers.join(","),
    ...rows.map((row) =>
      row.map((cell) => {
        const str = String(cell);
        // Escape commas, quotes, and newlines
        if (str.includes(",") || str.includes('"') || str.includes("\n")) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      }).join(",")
    ),
  ].join("\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

// ─── Print / PDF Export ─────────────────────────────────────────
export function printReport(title: string, content: string) {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title} - Stockfolio</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 40px; color: #1a1a2e; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; padding-bottom: 15px; border-bottom: 2px solid #e2e8f0; }
    .header h1 { font-size: 22px; font-weight: 700; }
    .header .meta { text-align: right; font-size: 12px; color: #64748b; }
    .header .brand { font-size: 14px; font-weight: 600; color: #6366f1; }
    table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 13px; }
    th { background: #f1f5f9; text-align: left; padding: 10px 12px; font-weight: 600; border-bottom: 2px solid #e2e8f0; }
    th.right, td.right { text-align: right; }
    td { padding: 8px 12px; border-bottom: 1px solid #e2e8f0; }
    tr:hover td { background: #f8fafc; }
    .total-row { font-weight: 700; border-top: 2px solid #1a1a2e; }
    .total-row td { padding-top: 12px; }
    .positive { color: #16a34a; }
    .negative { color: #dc2626; }
    .section-title { font-size: 15px; font-weight: 600; margin: 25px 0 10px; color: #334155; }
    .summary-box { display: flex; gap: 20px; margin: 20px 0; }
    .summary-item { flex: 1; padding: 15px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0; }
    .summary-item .label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; }
    .summary-item .value { font-size: 20px; font-weight: 700; margin-top: 4px; }
    .footer { margin-top: 40px; padding-top: 15px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; display: flex; justify-content: space-between; }
    @media print { body { padding: 20px; } }
  </style>
</head>
<body>
  ${content}
  <div class="footer">
    <span>Stockfolio — Local Portfolio Manager by Richard Najem</span>
    <span>Generated: ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}</span>
  </div>
</body>
</html>`;

  // Hidden-iframe printing: works in browsers AND Electron, where
  // window.open("_blank") is blocked by setWindowOpenHandler({ action: "deny" }).
  const existing = document.getElementById("stockfolio-print-frame");
  if (existing) existing.remove();

  const iframe = document.createElement("iframe");
  iframe.id = "stockfolio-print-frame";
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow?.document;
  if (!doc) return;
  doc.open();
  doc.write(html);
  doc.close();

  const doPrint = () => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } catch {
      // Last-resort fallback (browsers that block programmatic iframe print)
      const w = window.open("", "_blank");
      if (w) {
        w.document.write(html);
        w.document.close();
        w.focus();
        setTimeout(() => w.print(), 300);
      }
    }
    // Give the print dialog time to spin up before tearing down the frame
    setTimeout(() => iframe.remove(), 60000);
  };

  if (doc.readyState === "complete") {
    setTimeout(doPrint, 100);
  } else {
    iframe.onload = () => setTimeout(doPrint, 100);
    // Safety net in case onload never fires
    setTimeout(() => { if (document.getElementById("stockfolio-print-frame")) doPrint(); }, 1500);
  }
}
