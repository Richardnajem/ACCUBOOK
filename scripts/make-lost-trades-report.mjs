// Builds `docs/lost-trades-report.docx` — a real Word (OOXML) document with the
// measured diagnosis of the Mega Score rule's losing trades.
//
//   node scripts/make-lost-trades-report.mjs [out.docx]
//
// No dependency is installed for this: a .docx is a ZIP of XML parts, so the
// script writes a valid store-only ZIP and a WordprocessingML body. Every figure
// below comes from the harness runs recorded in `source` (see the report's
// "What was run" section) — nothing here is estimated.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.argv[2] ?? "docs/lost-trades-report.docx");

// ─── ZIP writer (store only; a .docx needs no compression) ─────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

function dosStamp(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  const stamp = dosStamp(new Date());
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(stamp.time, 10);
    lh.writeUInt16LE(stamp.date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(stamp.time, 12);
    ch.writeUInt16LE(stamp.date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

// ─── WordprocessingML helpers ──────────────────────────────────
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const run = (text, o = {}) =>
  `<w:r><w:rPr>${o.b ? "<w:b/>" : ""}${o.i ? "<w:i/>" : ""}${
    o.mono ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : ""
  }${o.size ? `<w:sz w:val="${o.size}"/><w:szCs w:val="${o.size}"/>` : ""}${
    o.color ? `<w:color w:val="${o.color}"/>` : ""
  }</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;

function para(text, o = {}) {
  const spacing = `<w:spacing w:before="${o.before ?? 0}" w:after="${o.after ?? 100}" w:line="${o.line ?? 264}" w:lineRule="auto"/>`;
  const ind = o.indent ? `<w:ind w:left="${o.indent}" w:hanging="${o.hanging ?? 0}"/>` : "";
  const keep = o.keepNext ? "<w:keepNext/>" : "";
  const shade = o.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${o.fill}"/>` : "";
  return `<w:p><w:pPr>${keep}${spacing}${ind}${shade}</w:pPr>${run(text, o)}</w:p>`;
}

const h1 = (t) =>
  `<w:p><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="140"/><w:outlineLvl w:val="0"/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="2" w:color="C7D2FE"/></w:pBdr></w:pPr>${run(t, {
    b: true,
    size: 30,
    color: "1E3A8A",
  })}</w:p>`;
const h2 = (t) =>
  `<w:p><w:pPr><w:keepNext/><w:spacing w:before="260" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr>${run(t, {
    b: true,
    size: 24,
    color: "111827",
  })}</w:p>`;
const bullet = (t, indent = 340) => para(`•  ${t}`, { indent, hanging: 220, after: 60 });

function table(headers, rows, widths) {
  const grid = `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>`;
  const border = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>`;
  const tblPr = `<w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${border("top")}${border("left")}${border("bottom")}${border("right")}${border("insideH")}${border("insideV")}</w:tblBorders><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>`;
  const cell = (text, w, opts = {}) =>
    `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${
      opts.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${opts.fill}"/>` : ""
    }</w:tcPr><w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>${run(String(text), {
      b: opts.b,
      size: opts.size ?? 18,
      color: opts.color,
    })}</w:p></w:tc>`;
  const row = (cells, opts = {}) =>
    `<w:tr>${opts.header ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${cells
      .map((c, i) => cell(c, widths[i], opts))
      .join("")}</w:tr>`;
  return `<w:tbl>${tblPr}${grid}${row(headers, { header: true, b: true, fill: "E0E7FF" })}${rows
    .map((r) => row(r))
    .join("")}</w:tbl>${para("", { after: 80 })}`;
}

// ─── The measured report ───────────────────────────────────────
const RUN_DATE = "30 October 2026";
const body = [];

body.push(
  para("Lost Trades in the Mega Score Rule", { b: true, size: 44, color: "111827", after: 60 }),
  para("A measured diagnosis: why the rule loses, what was tried, and what the evidence cannot tell us", {
    i: true,
    size: 22,
    color: "4B5563",
    after: 140,
  }),
  para(`Stockfolio (ACCUBOOK) · measurement run ${RUN_DATE} · prepared for Richard Najem`, {
    size: 18,
    color: "6B7280",
    after: 200,
  }),
  para(
    "Scope: the shipped Mega Score regime rule (buy at the composite, exit below it) on every ticker cached in this install, plus the weight-training, filter and stop-loss variants that could plausibly reduce losing trades. All figures are outputs of the harnesses named in section 1; none are estimates or hand-written.",
    { size: 20, after: 80 },
  ),
  para(
    "Short on time? Read \"The problems, in plain words\" first. The numbered sections after it hold the figures and the caveats behind each statement.",
    { i: true, size: 19, color: "4B5563", after: 140 },
  ),
  para("Bottom line: the losing trades are not an entry-quality problem, and no filter, stop, trailing stop or retrained weight map tested here reduces them without costing more than it saves.", {
    b: true,
    size: 21,
    color: "9A3412",
    fill: "FFF7ED",
    after: 200,
  }),

  h1("The problems, in plain words"),
  para(
    "This section explains what the measurements found without jargon. Each heading is one problem, in the order the evidence puts it.",
    { i: true, size: 18, color: "4B5563", after: 120 },
  ),

  h2("1. The rule almost never sells"),
  para(
    "The composite score is told to sell below 25. On these 26 stocks over twenty years it never got that low on 22 of them — its floor was 23 to 34. So the rule bought and then simply held, for years: 5 decisions in total. Its '60 % loss rate' is 3 losers out of 5 trades, which tells you nothing about skill. In practice this strategy is buy-and-hold with a fire alarm wired below the temperature the house ever reaches.",
    { after: 100 },
  ),
  h2("2. When it does sell, it sells late"),
  para(
    "The score is an average of 58 indicator readings, smoothed over five days. By the time that average has fallen under the exit line, most of the fall has already happened. The rule then waits for the score to climb back above the entry line before buying again, so it sells low, waits, and buys back higher. That is the single biggest source of 'lost' trades: winners were held 135 days on average, losers 31.",
    { after: 100 },
  ),
  h2("3. A stop-loss makes it worse, not better"),
  para(
    "A stop feels like protection, but this engine buys again as soon as the trend signal is still positive. At the shipped bands a 15 % stop turned 5 decisions into 133 trades, of which 130 lost. Waiting for a fresh buy signal after the stop produced 27 trades and all 27 lost. The stop did not avoid the fall; it paid for the fall several times over in commissions and badly timed re-entries.",
    { after: 100 },
  ),
  h2("4. The entry reading cannot tell a winner from a loser"),
  para(
    "If bad entries caused the losses, losing trades would start from visibly lower scores. They do not: winners started at 68.7 and losers at 67.7 — a one-point gap on a 100-point scale. A coin-flip test (the chance a random winner's entry reading beats a random loser's) lands between 0.44 and 0.56 depending on the weights; chance is 0.5. The score measures how healthy a stock looks today, not whether next month will be kind.",
    { after: 100 },
  ),
  h2("5. Retraining the weights does not fix it"),
  para(
    "Four weight maps were fitted, then judged only on sessions they had never seen. Every one did worse than the shipped default, and none cleared its own luck threshold. One map had the LOWEST loss rate while its coin-flip score was 0.44, below chance — it lost less by trading different stocks, not by choosing better ones. Training on 25 stocks and testing the 26th cold said the same: the fitted map beat the default on 3 of 8 names, weights alone on 0 of 8.",
    { after: 100 },
  ),
  h2("6. The data itself had a seam — now fixed"),
  para(
    "Price providers disagree about history: one adjusts past prices for dividends, another leaves them raw. The app is meant to REPLACE a symbol's history when the provider changes, never splice the two together. Two gaps allowed a splice: a cache with no recorded provider was extended instead of replaced, and a provider change re-stored only the requested window (so a 1-year request could shrink a 10-year cache). Both are fixed and covered by tests. A seam like that looks exactly like strategy behaviour, which is why it is called out here.",
    { after: 100 },
  ),
  h2("7. What this document can and cannot prove"),
  para(
    "It can show, on 26 mostly large US stocks over twenty years, that the losing trades are short whipsaws and that no stop, entry gate or reweighting tested recovers what they cost. It cannot show the same for other markets, delisted companies, or intraday trading. The cached universe contains only survivors, the period is mostly a bull market, and at the shipped bands there are too few trades to judge anything. Every figure is stated with its window so it can be re-checked, and none of it is investment advice.",
    { after: 160 },
  ),
);

body.push(h1("1. What was run"));
body.push(
  para("Universe: 26 instruments cached in portfolio.db — 8 index/large-cap ETFs and names (SPY, QQQ, IWM, DIA, AAPL, MSFT, AMZN, GOOGL, META, JNJ, JPM, KO, PG, WMT, XOM, BAC, NFLX, NVDA) and 8 high-volatility names (TSLA, AMD, MSTR, SMCI, COIN, FSLR, MU, GME). History 2006-10 to 2026-10 (5,029 daily bars per name; COIN only since 2021).", { after: 100 }),
  bullet("npm run test:filters — 10 entry-gate/risk-exit variants × 2 band pairs × 3 windows (full, last 40 %, last 30 %), plus a loss autopsy on the volatile block."),
  bullet("npm run test:trained — 4 weight maps trained by coordinate descent (built-in 70 %, catalogue 60/70/80 %), each scored on the SAME held-out last-40 % and last-20 % windows, with entry-reading separation and per-symbol AUC."),
  bullet("npm run test:leaveout — train on 25 names, test the excluded name cold on its last 30 %."),
  bullet("Indicator reconciliations against both reference workbooks (technicals richard.xlsx, Indicators project 181026.xlsx): 98 tests, 4 suites."),
  bullet("Price-basis audit of the cache loader, with a new regression suite (tests/basis-guard.test.ts)."),
  para("Costs in every backtest: 2 bps commission + 2 bps slippage each way, 100 % position size. Bands are shown as entry/exit on the 0-100 composite.", { i: true, size: 18, color: "4B5563", after: 160 }),
);

body.push(h1("2. The headline numbers"));
body.push(
  para("2.1 The shipped rule (70/25) barely trades", { b: true, size: 22, after: 80 }),
  para(
    "Across 26 instruments and twenty years the shipped rule made 5 decisions in total on the full window: 3 of them lost (60 %). That is not a strategy being measured, it is buy-and-hold with a guardrail that almost never fires. The composite's own floor on these names sat at 23-34 while the exit band is 25, so the exit condition is reached only in genuine breakdowns.",
    { after: 100 },
  ),
  table(
    ["Bands", "Trades", "Losers", "Loss rate", "Avg win", "Avg loss", "Avg trade", "Sharpe"],
    [
      ["70/25 (shipped)", "5", "3", "60.0%", "+1,310%", "-60.8%", "+487.7%", "0.64"],
      ["55/45 (measurable)", "1,359", "793", "58.4%", "+43.9%", "-9.2%", "+12.95%", "0.56"],
    ],
    [1500, 800, 800, 900, 1000, 1000, 1100, 900],
  ),
  para(
    "The 70/25 row's percentages are dominated by a handful of 15-year holds. Only the 55/45 row has enough completed trades to study losses, which is why every diagnosis below uses it.",
    { i: true, size: 18, color: "4B5563", after: 160 },
  ),
  para("2.2 The loss autopsy (volatile names, 55/45, full window)", { b: true, size: 22, after: 80 }),
  para("1,016 rule exits, 662 losers (65.2 %), average hold 67.6 days. The twelve worst decisions:", { after: 80 }),
  table(
    ["Ticker", "Entry → exit", "Return", "Days", "Entry score", "Exit score"],
    [
      ["SMCI", "2024-09-18 → 2024-11-04", "-44.0%", "33", "61.0", "23.6"],
      ["FSLR", "2012-04-18 → 2012-05-21", "-42.2%", "23", "65.4", "31.9"],
      ["MU", "2008-09-11 → 2008-11-17", "-40.8%", "47", "70.0", "33.2"],
      ["FSLR", "2011-10-31 → 2011-12-19", "-39.4%", "34", "66.7", "30.6"],
      ["MU", "2025-01-08 → 2025-04-07", "-37.8%", "60", "74.5", "23.1"],
      ["SMCI", "2025-12-05 → 2026-03-24", "-37.1%", "73", "64.7", "27.5"],
      ["COIN", "2021-12-28 → 2022-01-24", "-35.9%", "18", "81.5", "30.6"],
      ["NVDA", "2008-09-24 → 2008-10-08", "-34.9%", "10", "66.5", "27.6"],
    ],
    [1200, 3000, 900, 700, 1100, 1100],
  ),
  para(
    "The decisive row is not in this table: winners were entered at an average reading of 68.7 and losers at 67.7 — a gap of about one point on a 0-100 scale. Winners were held 135.3 days, losers 31.4 days.",
    { b: true, after: 120 },
  ),
);

body.push(h1("3. Root causes, in order of evidence"));
body.push(
  h2("3.1 The losses are short whipsaws, not weak entries"),
  para(
    "If entries were the problem, losers would cluster at visibly lower readings than winners. They do not: 67.7 versus 68.7, and the AUC (the chance a random winner's entry reading beats a random loser's) is 0.48-0.56 across maps and windows — a coin flip. What separates the two groups is time held: 31 days versus 135. A slow composite buys into a pullback inside an uptrend, the pullback continues past the exit band, and the rule sells into the hole.",
    { after: 100 },
  ),
  h2("3.2 The exit is a threshold on a smoothed blend"),
  para(
    "The signal is a weighted average of 58 indicator scores, smoothed over 5 bars. By the time it falls below 45 (or 25), most of the drawdown has already happened; the sale is late by construction. Re-entry then requires the score to climb back above the entry band, so the rule systematically sells low and re-buys higher. This is the mechanism behind the +1 point entry gap but the 4x difference in holding period.",
    { after: 100 },
  ),
  h2("3.3 Stops convert one hold into many losses"),
  para(
    "The engine re-enters while the regime is still long, so a stop-loss does not protect a position — it harvests its volatility. Measured at 70/25: the baseline's 5 decisions became 133 trades with 130 losses (97.7 %), return 12,510 % → 11,660 %, Sharpe 0.64 → 0.63. Waiting for a fresh signal after the stop made it worse: 27 trades, all 27 losers, Sharpe -0.01. ATR trailing stops cut the average win from +43.9 % to +14.2 % (3×ATR) or +28.0 % (4×ATR) at 55/45, with Sharpe 0.56 → 0.30 / 0.41.",
    { after: 100 },
  ),
  h2("3.4 No reweighting separates the losers"),
  para(
    "Four maps were trained and then scored on identical held-out sessions. Every trained map did worse than the shipped default out of sample, and none cleared its own luck bar:",
    { after: 80 },
  ),
  table(
    ["Map", "Bands chosen", "Test excess Sharpe", "Luck bar", "Clears?", "AUC (last 20 %)"],
    [
      ["shipped default", "70/25", "-0.02", "—", "—", "0.481"],
      ["built-in 70 %", "72.5/35", "-0.17", "0.59", "no", "0.534"],
      ["catalogue 60 %", "75/35", "-0.10", "0.69", "no", "0.495"],
      ["catalogue 70 %", "72.5/35", "-0.17", "0.60", "no", "0.534"],
      ["catalogue 80 %", "75/40", "-0.23", "0.53", "no", "0.440"],
    ],
    [1800, 1400, 1700, 1100, 900, 1400],
  ),
  para(
    "The catalogue-80 map shows the trap clearly: it had the LOWEST loss rate on the last 20 % (53.5 % vs 54.9 %) while its AUC was 0.440 — worse than chance. It lost fewer trades by trading a different set of names, not by recognising losers. Per-symbol AUC at the 0.55 cut was held by 6-11 of 26 names depending on the map, near the ~30 % a 0.55 cut gives by chance; only AMZN, MSTR, QQQ and WMT cleared it on every map that could judge them, and those maps are near-identical — one replicated measurement, not four independent ones.",
    { after: 100 },
  ),
  para("3.4b Leave one ticker out entirely (the hardest test)", { b: true, size: 22, after: 80 }),
  para(
    "Train on 25 names, then trade the excluded name cold on its last 30 %. Pooled over the 8 volatile names with a usable tail (COIN is skipped — 1,390 bars, shorter than the shared split):",
    { after: 80 },
  ),
  table(
    ["Map", "Names", "Trades", "Loss rate", "Excess Sharpe", "Entry gap", "AUC"],
    [
      ["prior (70/25)", "8", "5", "20.0%", "-0.05", "+2.47", "1.000"],
      ["weights-only", "8", "9", "44.4%", "-0.08", "+1.31", "0.600"],
      ["tuned", "8", "82", "68.3%", "-0.10", "+0.91", "0.652"],
      ["self-trained", "8", "88", "62.5%", "-0.13", "+1.75", "0.581"],
    ],
    [1700, 800, 800, 1000, 1500, 1100, 900],
  ),
  para(
    "Tuned weights beat the prior's excess Sharpe on 3 of 8 names (median -0.04); weights-only on 0 of 8; a map fitted to the excluded ticker's OWN first 70 % on only 1 of 8. The tuned maps' much higher loss rates arrive with 16x the trades — exposure again, not selection. The prior's AUC of 1.000 rests on 5 trades and proves nothing. Failure to generalise is the composite's, not the training protocol's.",
    { after: 100 },
  ),
  h2("3.5 Gates change how often the rule trades, not how often it loses"),
  para(
    "At 55/45, where losses are measurable: confirm-5 moved the loss rate 58.4 % → 58.5 % and trade count 1,359 → 1,276; the trend-200 gate produced 56.5 % (its best) with 36 % fewer trades and a LOWER Sharpe (0.54); confirm-5 + 3×ATR trail reached 55.9 % with 1,293 trades and Sharpe 0.30. At 70/25 there are too few decisions to distinguish any gate.",
    { after: 100 },
  ),
  h2("3.6 Measurement-side causes that also produce 'lost' trades"),
  bullet("Survivorship: the cached universe is names that still exist and were chosen with hindsight. Delisted losers are absent, so every loss rate here is optimistic, not pessimistic."),
  bullet("A single regime: 2006-2026 is mostly a bull market with two sharp drawdowns (2008, 2022). The rule's behaviour in a long bear is represented by a few dozen trades at most."),
  bullet("Price basis: until this pass, a cache written before price_meta.source existed (basis NULL) was extended with Yahoo's adjusted prices instead of replaced — a silent seam of mixed bases that every indicator would inherit. Fixed and covered by tests/basis-guard.test.ts."),
  bullet("Overlapping observations: per-symbol AUC pools overlapping 20-day forward windows, so its effective sample is far smaller than the trade count suggests."),
  bullet("Fills are modelled at the next bar's open with constant bps costs; no partial fills, no gap slippage beyond that, no borrow or tax."),
);

body.push(h1("3.7 The exit and the smoothing were swept too"));
body.push(
  para(
    "The earlier sweeps held two inputs fixed: the smoothing window and the exit band. A new harness (npm run test:exit) varied them over the same 26 names, costs and windows — five smoothing windows (1/3/5/10/20 days) × seven exit levels at entry 70, plus five exits at entry 55.",
    { after: 100 },
  ),
  table(
    ["At entry 70, exit 25", "1 day", "3 days", "5 days (shipped)", "10 days", "20 days"],
    [
      ["Sharpe, last 40 %", "0.75", "0.75", "0.76", "0.73", "0.72"],
      ["Sharpe, last 30 %", "0.74", "0.77", "0.78", "0.74", "0.73"],
      ["Trades, full history", "88", "23", "5", "0", "0"],
    ],
    [2100, 1100, 1100, 1500, 1200, 1200],
  ),
  table(
    ["At 5-day smoothing", "exit 25", "exit 30", "exit 35", "exit 40", "exit 45", "exit 50"],
    [
      ["Sharpe, last 40 %", "0.76", "0.74", "0.71", "0.67", "0.61", "0.60"],
      ["Sharpe, last 30 %", "0.78", "0.75", "0.71", "0.66", "0.58", "0.55"],
      ["Exit reached", "0.0%", "0.1%", "0.8%", "3.0%", "6.8%", "11.8%"],
    ],
    [1900, 1100, 1100, 1100, 1100, 1100, 1100],
  ),
  para(
    "Smoothing 5 wins on both tails, and every exit above 25 is worse on both. The last row is the important one: at the shipped settings the exit is reached on roughly one session in a thousand — that is the whipsaw problem in one number. With ten days of smoothing the exit became unreachable entirely (zero trades), which is why a run now warns when a band never fires instead of silently reporting buy & hold.",
    { after: 120 },
  ),
);

body.push(h1("4. What was changed in this pass"));
body.push(
  bullet("Price-basis guard: when the incoming provider differs from the cached one — or the cached basis is unknown (NULL) — the cache is replaced wholesale with the new source's own FULL history, not just the requested window. Previously a 1-year request could delete ten years, and an unknown basis was extended instead of replaced."),
  bullet("tests/basis-guard.test.ts: 5 tests pinning same-source extension, provider change, unknown-basis replacement and empty-cache behaviour."),
  bullet("Full-history Excel export (previous pass) re-verified over HTTP: AAPL, 7,548 sessions from 1996-10-29, all 58 indicators present in both score and raw form, blank warm-ups preserved."),
  bullet("Exit and smoothing were swept (section 3.7) and left at 5 days / 70-25: the shipped pair is the best on both held-out tails, and every stricter exit measured worse."),
  bullet("One smoothing predicate (smoothsScore) now decides which strategies read the smoothed composite. Previously the engine smoothed only mega_score while the exporter smoothed both mega strategies, so a mega_score_fast run logged the raw score on each trade beside a smoothed signal column for the same bar."),
  bullet("A dead exit is no longer silent: runStockBacktestDetailed warns when the exit band was never reached, naming the lowest smoothed score and the measured cost of raising it."),
  bullet("No indicator weights, bands or strategy defaults were changed: section 3.4 is the evidence for leaving them measured rather than hand-tuned."),
);

body.push(h1("5. Limitations of this diagnosis"));
body.push(
  bullet("Small samples where it matters most. At the shipped 70/25 there are 5 completed trades on the full window and 1 on the last 30 %. Any statement about that rule's loss rate is anecdote, and no filter can be distinguished there."),
  bullet("One universe, chosen with hindsight. 26 US-listed names, 8 of them deliberately volatile. Nothing here generalises to other markets, small caps, or delisted companies."),
  bullet("One cost model. 2 + 2 bps is a retail-broker assumption; higher costs hurt the high-turnover variants (stops, ATR trails) far more than the baseline, so the ranking is robust in direction but not in magnitude."),
  bullet("Score scale coupling. The bands are absolute values on a composite whose distribution differs by instrument (p10 ≈ 43-47, median ≈ 65-68 on this universe). The same 45 exit means different things on SPY and on MSTR."),
  bullet("Training objective limits. The trainer sees ~1.4 trades per symbol on the held-out tail; it cannot separate weight maps by more than noise, which is why no map clears its luck bar and why a 'trained' map is not evidence."),
  bullet("Daily bars only. Intraday path, overnight gaps and intraday stops are not modelled; the morning-after fills are approximations."),
  bullet("The report measures the rule, not the market. A losing trade here means the rule's own exit was below its entry; it does not mean the instrument was a bad holding over the same period."),
);

body.push(h1("6. What the evidence supports doing next"));
body.push(
  bullet("Treat 70/25 as buy-and-hold with a tail guardrail. Do not describe it as an active strategy, and do not judge it on its 5 decisions."),
  bullet("If fewer losing trades is the goal, the lever is trading less (longer holds, wider/no exit), not a better entry or a protective stop — both were measured and both cost more than they saved."),
  bullet("Re-run npm run test:leaveout and npm run test:trained only after enlarging the universe to include delisted names; a larger sample is the binding constraint, not another parameter."),
  bullet("Never adopt a weight map whose held-out excess Sharpe does not clear its own luck bar, and never adopt one because its loss rate fell — section 3.4 shows that can happen while separation stays below chance."),
  bullet("Keep the price-basis guard in place. Mixed adjusted/raw history is a silent corruption that looks like strategy behaviour."),
);

body.push(
  para("", { after: 160 }),
  para("Reproduce: npm run test:filters · npm run test:trained · npm run test:leaveout · npm test · node scripts/make-lost-trades-report.mjs", {
    size: 17,
    color: "6B7280",
    mono: true,
    after: 60,
  }),
  para("Generated from the harness output of 30 October 2026. Instrument counts, names and windows are stated so each figure can be re-derived; nothing in this document is investment advice.", {
    i: true,
    size: 17,
    color: "6B7280",
  }),
);

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${body.join("\n")}
<w:sectPr>
<w:pgSz w:w="11906" w:h="16838"/>
<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/>
</w:sectPr>
</w:body>
</w:document>`;

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`;

const buf = zip([
  { name: "[Content_Types].xml", data: contentTypes },
  { name: "_rels/.rels", data: rels },
  { name: "word/document.xml", data: documentXml },
  { name: "word/_rels/document.xml.rels", data: docRels },
]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, buf);
console.log(`wrote ${OUT} (${buf.length} bytes, ${documentXml.length} chars of WordprocessingML)`);
