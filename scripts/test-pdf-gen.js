// Generates a minimal but valid PDF bank statement for import testing.
const fs = require("fs");
const lines = [
  "Stockfolio Bank Statement",
  "",
  "Date        Description           Amount",
  "2026-09-01  Office rent received  12000.50",
  "2026-09-02  Repair invoice        450.25",
];
let content = "BT /F1 10 Tf 40 760 Td 14 TL\n";
for (const l of lines) {
  content += "(" + l.replace(/[\\()]/g, "") + ") Tj T*\n";
}
content += "ET";
const stream = Buffer.from(content);
const objs = [];
objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
objs[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>";
objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>";
objs[5] = "<< /Length " + stream.length + " >>\nstream\n" + content + "\nendstream";

let pdf = "%PDF-1.4\n";
const offsets = [0];
for (let i = 1; i <= 5; i++) {
  offsets[i] = Buffer.byteLength(pdf);
  pdf += i + " 0 obj\n" + objs[i] + "\nendobj\n";
}
const xref = Buffer.byteLength(pdf);
pdf += "xref\n0 6\n0000000000 65535 f \n";
for (let i = 1; i <= 5; i++) pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
pdf += "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF";
fs.writeFileSync("test-import.pdf", pdf, "binary");
console.log("pdf written");
