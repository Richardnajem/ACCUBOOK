// Custom (user-defined) indicators for the Mega Indicator.
//
// A custom indicator is a formula over daily OHLCV, e.g.
//     (close - sma(close, 20)) / sma(close, 20) * 100
// compiled by a small expression evaluator. There is no eval() and no access
// to globals: only a fixed whitelist of variables and functions, hard limits on
// source length / node count / nesting depth, and integer-only lookback periods
// capped at MAX_PERIOD. The same code path runs in the browser (parse + validate
// so the UI can report errors instantly) and on the server (parse + evaluate
// against the bar history), so what you preview is what you get.

import { customSpec, type Direction, type IndicatorSpec } from "./mega-indicator";
import { atr as atrSeries, rsi as rsiSeries, stdev as stdevSeries, windowMean } from "./ta";

// ─── Limits (surfaced in the UI so errors are explainable) ──────

export const MAX_CUSTOM = 16;
export const MAX_FORMULA_LEN = 400;
export const MAX_NAME_LEN = 40;
export const MAX_DESC_LEN = 160;
export const MAX_PERIOD = 500;
export const MAX_NODES = 80;
export const MAX_DEPTH = 20;
export const LS_MEGA_CUSTOM = "mega-indicator:custom:v1";

export interface CustomIndicatorDef {
  id: string;
  name: string;
  formula: string;
  direction: Direction;
  thresholds: [number, number];
  unit: string;
  description: string;
}

// ─── Variables and functions available to a formula ─────────────

export const VARS: Record<string, string> = {
  open: "Open price",
  high: "Day's high",
  low: "Day's low",
  close: "Close price",
  volume: "Volume",
  hl2: "(High + Low) / 2",
  hlc3: "(High + Low + Close) / 3  — typical price",
  ohlc4: "(Open + High + Low + Close) / 4",
};

interface FnDef {
  minArgs: number;
  maxArgs: number;
  /** 0-based argument positions that must be an integer literal period. */
  intArgs: number[];
  /** Exact accepted argument counts, when "min-max" is too permissive. */
  arities?: number[];
  help: string;
}

export const FUNCS: Record<string, FnDef> = {
  sma: { minArgs: 2, maxArgs: 2, intArgs: [1], help: "sma(x, n) — n-period simple average of x" },
  ema: { minArgs: 2, maxArgs: 2, intArgs: [1], help: "ema(x, n) — n-period exponential average of x" },
  stdev: { minArgs: 2, maxArgs: 2, intArgs: [1], help: "stdev(x, n) — n-period sample standard deviation of x" },
  rollingMax: { minArgs: 2, maxArgs: 2, intArgs: [1], help: "rollingMax(x, n) — highest x over n bars" },
  rollingMin: { minArgs: 2, maxArgs: 2, intArgs: [1], help: "rollingMin(x, n) — lowest x over n bars" },
  rsi: { minArgs: 2, maxArgs: 2, intArgs: [1], help: "rsi(x, n) — Wilder RSI of x (use rsi(close, 14))" },
  atr: { minArgs: 1, maxArgs: 4, intArgs: [-1], arities: [1, 4], help: "atr(14) or atr(high, low, close, 14) — average true range" },
  prev: { minArgs: 2, maxArgs: 2, intArgs: [1], help: "prev(x, n) — x from n bars ago" },
  change: { minArgs: 2, maxArgs: 2, intArgs: [1], help: "change(x, n) — x minus x from n bars ago" },
  roc: { minArgs: 2, maxArgs: 2, intArgs: [1], help: "roc(x, n) — % change of x over n bars" },
  abs: { minArgs: 1, maxArgs: 1, intArgs: [], help: "abs(x)" },
  sqrt: { minArgs: 1, maxArgs: 1, intArgs: [], help: "sqrt(x)" },
  log: { minArgs: 1, maxArgs: 1, intArgs: [], help: "log(x) — natural log" },
  exp: { minArgs: 1, maxArgs: 1, intArgs: [], help: "exp(x)" },
  sign: { minArgs: 1, maxArgs: 1, intArgs: [], help: "sign(x) — -1, 0 or 1" },
  pow: { minArgs: 2, maxArgs: 2, intArgs: [], help: "pow(x, y) — x raised to y" },
  min: { minArgs: 2, maxArgs: 8, intArgs: [], help: "min(a, b, …) — smallest, bar by bar" },
  max: { minArgs: 2, maxArgs: 8, intArgs: [], help: "max(a, b, …) — largest, bar by bar" },
  avg: { minArgs: 2, maxArgs: 8, intArgs: [], help: "avg(a, b, …) — mean of the arguments, bar by bar" },
};

export const FORMULA_HELP: string[] = [
  "Variables: " + Object.keys(VARS).join(", "),
  ...Object.values(FUNCS).map((f) => f.help),
  "Operators: + − × ÷ % ^ and comparisons > < >= <= == !=",
];

// ─── Tokenizer ──────────────────────────────────────────────────

type Tok =
  | { k: "num"; v: number; pos: number }
  | { k: "id"; v: string; pos: number }
  | { k: "op"; v: string; pos: number };

const OPS3 = [">=", "<=", "==", "!="];
const OPS1 = ["+", "-", "*", "/", "%", "^", "(", ")", ",", ">", "<"];

function tokenize(src: string): { ok: true; toks: Tok[] } | { ok: false; error: string } {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (!m) return { ok: false, error: `Malformed number at position ${i}.` };
      toks.push({ k: "num", v: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      toks.push({ k: "id", v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const three = src.slice(i, i + 2);
    if (OPS3.includes(three)) { toks.push({ k: "op", v: three, pos: i }); i += 2; continue; }
    if (OPS1.includes(c)) { toks.push({ k: "op", v: c, pos: i }); i += 1; continue; }
    return { ok: false, error: `Unexpected character "${c}" at position ${i}.` };
  }
  toks.push({ k: "op", v: "eof", pos: src.length });
  return { ok: true, toks };
}

// ─── AST ────────────────────────────────────────────────────────

export type Ast =
  | { t: "num"; v: number }
  | { t: "var"; name: string }
  | { t: "call"; name: string; args: Ast[] }
  | { t: "bin"; op: string; l: Ast; r: Ast }
  | { t: "cmp"; op: string; l: Ast; r: Ast }
  | { t: "neg"; x: Ast };

export type ParseResult = { ok: true; ast: Ast } | { ok: false; error: string };

class ParseError extends Error {}

/** Parse + fully validate a formula. Never throws; returns a readable error. */
export function parseFormula(src: string): ParseResult {
  try {
    const trimmed = (src || "").trim();
    if (!trimmed) return { ok: false, error: "Enter a formula." };
    if (trimmed.length > MAX_FORMULA_LEN) {
      return { ok: false, error: `Formula too long (max ${MAX_FORMULA_LEN} characters).` };
    }
    const t = tokenize(trimmed);
    if (!t.ok) return { ok: false, error: t.error };
    const p = new Parser(t.toks, trimmed);
    const ast = p.parseExpr();
    p.expect("eof");
    const stats = { nodes: 0 };
    check(ast, 0, stats);
    return { ok: true, ast };
  } catch (e) {
    return { ok: false, error: e instanceof ParseError ? e.message : "Invalid formula." };
  }
}

class Parser {
  private i = 0;
  constructor(private toks: Tok[], private src: string) {}
  private peek(): Tok { return this.toks[this.i]; }
  private at(op: string): boolean {
    const t = this.peek();
    return t.k === "op" && t.v === op;
  }
  private eat(op: string): boolean { if (this.at(op)) { this.i++; return true; } return false; }
  expect(op: string): void {
    if (!this.eat(op)) {
      const t = this.peek();
      const got = t.k === "num" ? String(t.v) : t.k === "id" ? t.v : `"${t.v}"`;
      throw new ParseError(`Expected "${op}" but found ${got}.`);
    }
  }
  private err(msg: string): never { throw new ParseError(msg); }

  parseExpr(): Ast { return this.parseCmp(); }

  private parseCmp(): Ast {
    const l = this.parseAdd();
    const t = this.peek();
    if (t.k === "op" && [">", "<", ">=", "<=", "==", "!="].includes(t.v)) {
      this.i++;
      return { t: "cmp", op: t.v, l, r: this.parseAdd() };
    }
    return l;
  }

  private parseAdd(): Ast {
    let l = this.parseMul();
    for (;;) {
      if (this.eat("+")) l = { t: "bin", op: "+", l, r: this.parseMul() };
      else if (this.eat("-")) l = { t: "bin", op: "-", l, r: this.parseMul() };
      else return l;
    }
  }

  private parseMul(): Ast {
    let l = this.parseUnary();
    for (;;) {
      if (this.eat("*")) l = { t: "bin", op: "*", l, r: this.parseUnary() };
      else if (this.eat("/")) l = { t: "bin", op: "/", l, r: this.parseUnary() };
      else if (this.eat("%")) l = { t: "bin", op: "%", l, r: this.parseUnary() };
      else return l;
    }
  }

  private parseUnary(): Ast {
    if (this.eat("-")) return { t: "neg", x: this.parseUnary() };
    if (this.eat("+")) return this.parseUnary();
    return this.parsePow();
  }

  private parsePow(): Ast {
    const base = this.parsePrimary();
    if (this.eat("^")) return { t: "bin", op: "^", l: base, r: this.parseUnary() };
    return base;
  }

  private parsePrimary(): Ast {
    const t = this.peek();
    if (t.k === "num") { this.i++; return { t: "num", v: t.v }; }
    if (t.k === "id") {
      this.i++;
      if (this.eat("(")) {
        const args: Ast[] = [];
        if (!this.at(")")) {
          args.push(this.parseExpr());
          while (this.eat(",")) args.push(this.parseExpr());
        }
        this.expect(")");
        return { t: "call", name: t.v, args };
      }
      return { t: "var", name: t.v };
    }
    if (this.at("(")) {
      this.i++;
      const e = this.parseExpr();
      this.expect(")");
      return e;
    }
    // Token kinds "num" and "id" were both handled above — only an operator
    // (or eof) can reach here.
    this.err(`Unexpected "${t.v}" at position ${t.pos}.`);
  }
}

/** Own-property test that ignores Object.prototype ("constructor", "__proto__"…). */
function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Static checks: known names, arity, integer periods, size and depth caps. */
function check(node: Ast, depth: number, stats: { nodes: number }): void {
  if (++stats.nodes > MAX_NODES) throw new ParseError(`Formula too complex (max ${MAX_NODES} terms).`);
  if (depth > MAX_DEPTH) throw new ParseError(`Formula nested too deeply (max ${MAX_DEPTH}).`);
  switch (node.t) {
    case "num":
      if (!Number.isFinite(node.v)) throw new ParseError("Invalid number.");
      return;
    case "var":
      // hasOwnProperty, not `in` — otherwise "constructor", "toString" and
      // friends resolve through Object.prototype and escape the whitelist.
      if (!hasOwn(VARS, node.name)) throw new ParseError(`Unknown variable "${node.name}". Available: ${Object.keys(VARS).join(", ")}.`);
      return;
    case "neg":
      check(node.x, depth + 1, stats);
      return;
    case "bin":
    case "cmp":
      check(node.l, depth + 1, stats);
      check(node.r, depth + 1, stats);
      return;
    case "call": {
      if (!hasOwn(FUNCS, node.name)) throw new ParseError(`Unknown function "${node.name}()".`);
      const fn = FUNCS[node.name];
      const arityOk = fn.arities
        ? fn.arities.includes(node.args.length)
        : node.args.length >= fn.minArgs && node.args.length <= fn.maxArgs;
      if (!arityOk) {
        const want = fn.arities
          ? fn.arities.join(" or ")
          : fn.minArgs === fn.maxArgs ? String(fn.minArgs) : `${fn.minArgs}-${fn.maxArgs}`;
        throw new ParseError(`${node.name}() takes ${want} argument(s), got ${node.args.length}.`);
      }
      for (const a of node.args) check(a, depth + 1, stats);
      // Periods must be literal integers — a dynamic period would make the
      // lookback unpredictable (and unbounded) at evaluation time.
      const intPositions = fn.intArgs[0] === -1
        ? [node.args.length - 1] // atr(...): the period is always the last arg
        : fn.intArgs;
      for (const p of intPositions) {
        const a = node.args[p];
        if (!a || a.t !== "num" || !Number.isInteger(a.v) || a.v < 1 || a.v > MAX_PERIOD) {
          throw new ParseError(`${node.name}(): argument ${p + 1} must be a whole number between 1 and ${MAX_PERIOD}.`);
        }
      }
      return;
    }
  }
}

// ─── Evaluation ─────────────────────────────────────────────────

interface Ctx {
  n: number;
  vars: Record<string, number[]>;
}

/** NaN-aware n-period EMA that reseeds if the input has a gap. */
function emaSeries(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(NaN);
  if (period <= 0) return out;
  const k = 2 / (period + 1);
  let run = 0;
  let sumRun = 0;
  let seeded = false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) { run = 0; sumRun = 0; seeded = false; continue; }
    run++;
    sumRun += v;
    if (run > period) sumRun -= values[i - period];
    if (run === period) { out[i] = sumRun / period; seeded = true; }
    else if (run > period && seeded) out[i] = v * k + out[i - 1] * (1 - k);
  }
  return out;
}

/** NaN-aware rolling extremes (a window containing a gap is undefined). */
function extremum(values: number[], period: number, pick: (a: number, b: number) => number): number[] {
  const out = new Array(values.length).fill(NaN);
  if (period <= 0) return out;
  for (let i = period - 1; i < values.length; i++) {
    let acc = values[i - period + 1];
    let ok = Number.isFinite(acc);
    if (ok) {
      for (let j = i - period + 2; j <= i; j++) {
        const v = values[j];
        if (!Number.isFinite(v)) { ok = false; break; }
        acc = pick(acc, v);
      }
    }
    if (ok) out[i] = acc;
  }
  return out;
}

/** RSI over a series that may start with a warm-up of NaNs. */
function rsiSafe(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(NaN);
  let s = 0;
  while (s < values.length && !Number.isFinite(values[s])) s++;
  if (s >= values.length) return out;
  for (let i = s; i < values.length; i++) {
    if (!Number.isFinite(values[i])) return out; // gap mid-series → undefined
  }
  const sub = rsiSeries(values.slice(s), period);
  for (let i = 0; i < sub.length; i++) out[s + i] = sub[i];
  return out;
}

const binOp = (op: string, a: number, b: number): number => {
  switch (op) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    case "/": return b === 0 ? NaN : a / b;
    case "%": return b === 0 ? NaN : a % b;
    case "^": return Math.pow(a, b);
    case ">": return a > b ? 1 : 0;
    case "<": return a < b ? 1 : 0;
    case ">=": return a >= b ? 1 : 0;
    case "<=": return a <= b ? 1 : 0;
    case "==": return a === b ? 1 : 0;
    case "!=": return a !== b ? 1 : 0;
    default: return NaN;
  }
};

function evalNode(node: Ast, ctx: Ctx): number[] {
  const n = ctx.n;
  switch (node.t) {
    case "num":
      return new Array(n).fill(node.v);
    case "var":
      return hasOwn(ctx.vars, node.name) ? ctx.vars[node.name] : new Array(ctx.n).fill(NaN);
    case "neg":
      return evalNode(node.x, ctx).map((v) => (Number.isFinite(v) ? -v : NaN));
    case "bin":
    case "cmp": {
      const l = evalNode(node.l, ctx);
      const r = evalNode(node.r, ctx);
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = binOp(node.op, l[i], r[i]);
      return out;
    }
    case "call": {
      const name = node.name;
      const a = node.args;
      const arg = (i: number) => evalNode(a[i], ctx);
      const periodAt = (i: number) => (a[i] as { t: "num"; v: number }).v;
      switch (name) {
        case "sma": return windowMean(arg(0), periodAt(1));
        case "ema": return emaSeries(arg(0), periodAt(1));
        case "stdev": return stdevSeries(arg(0), periodAt(1));
        case "rollingMax": return extremum(arg(0), periodAt(1), Math.max);
        case "rollingMin": return extremum(arg(0), periodAt(1), Math.min);
        case "rsi": return rsiSafe(arg(0), periodAt(1));
        case "atr": return a.length === 1
          ? atrSeries(ctx.vars.high, ctx.vars.low, ctx.vars.close, periodAt(0))
          : atrSeries(arg(0), arg(1), arg(2), periodAt(3));
        case "prev": {
          const x = arg(0);
          const lag = periodAt(1);
          return x.map((_, i) => (i >= lag ? x[i - lag] : NaN));
        }
        case "change": {
          const x = arg(0);
          const lag = periodAt(1);
          return x.map((_, i) => (i >= lag ? x[i] - x[i - lag] : NaN));
        }
        case "roc": {
          const x = arg(0);
          const lag = periodAt(1);
          return x.map((_, i) => (i >= lag && x[i - lag] !== 0 ? (x[i] / x[i - lag] - 1) * 100 : NaN));
        }
        case "abs": return arg(0).map(Math.abs);
        case "sqrt": return arg(0).map((v) => (v < 0 ? NaN : Math.sqrt(v)));
        case "log": return arg(0).map((v) => (v <= 0 ? NaN : Math.log(v)));
        case "exp": return arg(0).map(Math.exp);
        case "sign": return arg(0).map(Math.sign);
        case "pow": {
          const x = arg(0);
          const y = arg(1);
          return x.map((v, i) => Math.pow(v, y[i]));
        }
        case "min":
        case "max":
        case "avg": {
          const series = a.map((_, i) => arg(i));
          const out = new Array(n);
          for (let i = 0; i < n; i++) {
            let acc = series[0][i];
            if (name === "avg") {
              let s = 0;
              for (const ser of series) s += ser[i];
              acc = s / series.length;
            } else {
              for (let k = 1; k < series.length; k++) {
                acc = name === "min" ? Math.min(acc, series[k][i]) : Math.max(acc, series[k][i]);
              }
            }
            out[i] = acc;
          }
          return out;
        }
        default:
          return new Array(n).fill(NaN);
      }
    }
  }
}

// ─── Public evaluation API ──────────────────────────────────────

export interface EvalBars {
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}

/**
 * Evaluate a formula over daily bars, returning the raw series (one value per
 * bar, NaN during warm-up). Throws a readable Error on a bad formula.
 */
export function evalFormula(src: string, bars: EvalBars): number[] {
  const parsed = parseFormula(src);
  if (!parsed.ok) throw new Error(parsed.error);
  const n = bars.close.length;
  if (n === 0) throw new Error("No price history available.");
  const hl2 = bars.high.map((h, i) => (h + bars.low[i]) / 2);
  const hlc3 = bars.high.map((h, i) => (h + bars.low[i] + bars.close[i]) / 3);
  const ohlc4 = bars.high.map((h, i) => (bars.open[i] + h + bars.low[i] + bars.close[i]) / 4);
  const ctx: Ctx = {
    n,
    vars: {
      open: bars.open, high: bars.high, low: bars.low,
      close: bars.close, volume: bars.volume, hl2, hlc3, ohlc4,
    },
  };
  return evalNode(parsed.ast, ctx);
}

/** The most recent value of a formula; throws on a bad formula. */
export function evalFormulaLast(src: string, bars: EvalBars): number {
  const series = evalFormula(src, bars);
  for (let i = series.length - 1; i >= 0; i--) {
    if (Number.isFinite(series[i])) return series[i];
  }
  throw new Error("The formula produced no value for this ticker — try a shorter lookback period.");
}

// ─── Definitions: validation, storage, specs ────────────────────

function isDirection(v: unknown): v is Direction {
  return v === "higher" || v === "lower" || v === "band";
}

/** Drop/repair anything malformed so bad storage can never break the page. */
export function sanitizeCustomList(raw: unknown): CustomIndicatorDef[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomIndicatorDef[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : "";
    const name = typeof r.name === "string" ? r.name.trim().slice(0, MAX_NAME_LEN) : "";
    const formula = typeof r.formula === "string" ? r.formula.slice(0, MAX_FORMULA_LEN) : "";
    // Ids become object keys and URL parameters — keep them strictly shaped so
    // nothing like "__proto__" can slip through from storage.
    if (!/^custom-[A-Za-z0-9-]{1,48}$/.test(id)) continue;
    if (!name || !formula || seen.has(id)) continue;
    if (!parseFormula(formula).ok) continue;
    const t = Array.isArray(r.thresholds) ? r.thresholds : null;
    const th0 = t ? Number(t[0]) : NaN;
    const th1 = t ? Number(t[1]) : NaN;
    // Thresholds must not be reversed — a descending pair would let
    // normalizeScore() report scores above 100. Equal is allowed: it makes a
    // clean step function (e.g. bullish → 100, bearish → 0).
    if (!Number.isFinite(th0) || !Number.isFinite(th1) || th0 > th1) continue;
    seen.add(id);
    out.push({
      id,
      name,
      formula,
      direction: isDirection(r.direction) ? r.direction : "higher",
      thresholds: [th0, th1],
      unit: typeof r.unit === "string" ? r.unit.slice(0, 8) : "",
      description: typeof r.description === "string" ? r.description.slice(0, MAX_DESC_LEN) : "",
    });
    if (out.length >= MAX_CUSTOM) break;
  }
  return out;
}

export function loadCustom(): CustomIndicatorDef[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LS_MEGA_CUSTOM);
    return raw ? sanitizeCustomList(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function saveCustom(list: CustomIndicatorDef[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_MEGA_CUSTOM, JSON.stringify(sanitizeCustomList(list)));
  } catch { /* storage unavailable — ignore */ }
}

export function newCustomId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** The IndicatorSpec a custom definition contributes to the composite. */
export function specForCustom(def: CustomIndicatorDef): IndicatorSpec {
  return customSpec({
    id: def.id,
    name: def.name,
    category: "Custom",
    unit: def.unit,
    direction: def.direction,
    thresholds: def.thresholds,
    description: def.description || `Your own indicator — evaluated on the same daily bars as the built-ins.`,
    formula: def.formula,
  });
}

export interface CustomEvalResult {
  /** id → raw value for the definitions that evaluated successfully. */
  values: Record<string, number>;
  /** Specs for the definitions that evaluated successfully. */
  specs: IndicatorSpec[];
  /** Human-readable failures (one per bad definition). */
  errors: string[];
}

/** Evaluate a batch of definitions against bars, isolating failures. */
export function evaluateCustom(defs: CustomIndicatorDef[], bars: EvalBars): CustomEvalResult {
  const values: Record<string, number> = {};
  const specs: IndicatorSpec[] = [];
  const errors: string[] = [];
  for (const def of defs) {
    try {
      const v = evalFormulaLast(def.formula, bars);
      if (!Number.isFinite(v)) throw new Error("the formula produced no value");
      values[def.id] = v;
      specs.push(specForCustom(def));
    } catch (e) {
      errors.push(`${def.name}: ${e instanceof Error ? e.message : "failed to evaluate"}`);
    }
  }
  return { values, specs, errors };
}

/** Same as evaluateCustom but returns the full per-bar series (for history). */
export function evaluateCustomSeries(defs: CustomIndicatorDef[], bars: EvalBars): {
  series: Record<string, number[]>;
  specs: IndicatorSpec[];
  errors: string[];
} {
  const series: Record<string, number[]> = {};
  const specs: IndicatorSpec[] = [];
  const errors: string[] = [];
  for (const def of defs) {
    try {
      const s = evalFormula(def.formula, bars);
      if (!s.some((v) => Number.isFinite(v))) throw new Error("the formula produced no value");
      series[def.id] = s;
      specs.push(specForCustom(def));
    } catch (e) {
      errors.push(`${def.name}: ${e instanceof Error ? e.message : "failed to evaluate"}`);
    }
  }
  return { series, specs, errors };
}
