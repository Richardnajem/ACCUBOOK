// Generates public/icon.png (256px) and public/icon.ico (PNG-compressed entry).
// Pure Node: draws the Stockfolio mark (indigo rounded square + trend line) into
// an RGBA buffer and hand-encodes PNG, then wraps the PNG in an ICO container.
// Run: node scripts/gen-icon.js
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const S = 256; // canvas size
const px = Buffer.alloc(S * S * 4); // RGBA

function setPixel(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

// Filled rounded rectangle with 2x2 supersampling for smooth edges
function fillRoundRect(x0, y0, x1, y1, radius, cr, cg, cb) {
  for (let y = Math.floor(y0); y < y1; y++) {
    for (let x = Math.floor(x0); x < x1; x++) {
      let inside = 0;
      for (const sy of [y + 0.25, y + 0.75]) {
        for (const sx of [x + 0.25, x + 0.75]) {
          let dx = 0, dy = 0;
          if (sx < x0 + radius) dx = x0 + radius - sx;
          else if (sx > x1 - radius) dx = sx - (x1 - radius);
          if (sy < y0 + radius) dy = y0 + radius - sy;
          else if (sy > y1 - radius) dy = sy - (y1 - radius);
          if (dx * dx + dy * dy <= radius * radius) inside++;
        }
      }
      if (inside > 0) {
        const a = (inside / 4) * 255;
        setPixel(x, y, cr, cg, cb, a);
      }
    }
  }
}

// Background: indigo rounded square (like the sidebar logo)
fillRoundRect(16, 16, 240, 240, 48, 79, 70, 229); // #4f46e5

// Bar chart bars (lighter indigo + white)
function bar(x0, y0, x1, y1, r, g, b) {
  fillRoundRect(x0, y0, x1, y1, 6, r, g, b);
}
bar(64, 150, 92, 200, 255, 255, 255);          // short
bar(114, 110, 142, 200, 165, 180, 252);        // medium (indigo-300)
bar(164, 64, 192, 200, 255, 255, 255);         // tall

// ─── PNG encoding ───────────────────────────────────────────────
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  // Raw scanlines with filter byte 0
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0;
    px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ─── ICO container (PNG-compressed entry, valid for sizes <= 256) ───
function wrapICO(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);     // reserved
  header.writeUInt16LE(1, 2);     // type: icon
  header.writeUInt16LE(1, 4);     // count
  const entry = Buffer.alloc(16);
  entry[0] = 0;                   // width 256 => 0
  entry[1] = 0;                   // height 256 => 0
  entry[2] = 0;                   // colors
  entry[3] = 0;                   // reserved
  entry.writeUInt16LE(1, 4);      // planes
  entry.writeUInt16LE(32, 6);     // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);    // offset: 6 + 16
  return Buffer.concat([header, entry, png]);
}

const outDir = path.join(__dirname, "..", "public");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "icon.png"), encodePNG());
fs.writeFileSync(path.join(outDir, "icon.ico"), wrapICO(encodePNG()));
console.log("Wrote public/icon.png and public/icon.ico");
