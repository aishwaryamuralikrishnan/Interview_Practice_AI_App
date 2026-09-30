/**
 * py.ts — the handful of Python behaviours the port depends on, reproduced
 * exactly.
 *
 * A line-by-line translation is not enough on its own, because several
 * everyday operations mean something slightly different in each language, and
 * the difference changes results:
 *
 *   round(2.5)          Python 2      JS Math.round  3     (banker's rounding)
 *   round(6.125, 2)     Python 6.12   JS toFixed     6.13
 *   " a\u0085b ".split()  Python splits on U+0085; JS \s does not match it
 *   "😀abc"[:2]         Python counts code points; JS counts UTF-16 units
 *   str(True)           Python "True";  JS String(true) "true"
 *   0 or ""             Python ""; a naive JS `value ?? ""` keeps the 0
 *
 * Every function here is checked against the real Python implementation by
 * tests/parity.test.ts, on inputs recorded in parity/golden.json.
 */

import { PY_DECIMAL_BLOCKS, PY_DIGIT, PY_SPACE } from "./pyUnicode";

// ---------------------------------------------------------------------------
// Character classes
// ---------------------------------------------------------------------------

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid];
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Python's str.isspace() for one character (a string of one code point). */
export function isPySpace(ch: string): boolean {
  const cp = ch.codePointAt(0);
  return cp !== undefined && inRanges(cp, PY_SPACE);
}

/** Python's str.isdigit() for one character. */
export function isPyDigit(ch: string): boolean {
  const cp = ch.codePointAt(0);
  return cp !== undefined && inRanges(cp, PY_DIGIT);
}

const UPPER = /^\p{Uppercase}$/u;

/**
 * Python's str.isupper() for one character. Both languages use the Unicode
 * "Uppercase" property; they can differ only on characters added between the
 * Unicode versions bundled with each runtime.
 */
export function isPyUpper(ch: string): boolean {
  return UPPER.test(ch);
}

/** A RegExp character-class body matching exactly Python's whitespace. */
export const PY_WS_CLASS = PY_SPACE.map(([a, b]) =>
  a === b ? `\\u{${a.toString(16)}}` : `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`,
).join("");

const WS_RUN = new RegExp(`[${PY_WS_CLASS}]+`, "gu");
const WS_LEAD = new RegExp(`^[${PY_WS_CLASS}]+`, "u");
const WS_TRAIL = new RegExp(`[${PY_WS_CLASS}]+$`, "u");

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

/** Python's str.split() with no arguments. */
export function pySplit(s: string): string[] {
  return s.split(WS_RUN).filter((part) => part !== "");
}

/** `" ".join(s.split())` — collapse every whitespace run to one space. */
export function pyCollapse(s: string): string {
  return pySplit(s).join(" ");
}

/** Python's str.strip() with no arguments. */
export function pyStrip(s: string): string {
  return s.replace(WS_LEAD, "").replace(WS_TRAIL, "");
}

/** Python's str.lstrip() with no arguments. */
export function pyLstrip(s: string): string {
  return s.replace(WS_LEAD, "");
}

/** Python's str.strip(chars) — strip any of `chars` from both ends. */
export function pyStripChars(s: string, chars: string): string {
  const set = new Set(Array.from(chars));
  const cps = Array.from(s);
  let start = 0;
  let end = cps.length;
  while (start < end && set.has(cps[start])) start++;
  while (end > start && set.has(cps[end - 1])) end--;
  return cps.slice(start, end).join("");
}

/** Python's str.rstrip(chars). */
export function pyRstripChars(s: string, chars: string): string {
  const set = new Set(Array.from(chars));
  const cps = Array.from(s);
  let end = cps.length;
  while (end > 0 && set.has(cps[end - 1])) end--;
  return cps.slice(0, end).join("");
}

const LINE_BREAKS = new Set(["\n", "\r", "\x0b", "\x0c", "\x1c", "\x1d", "\x1e", "\x85", " ", " "]);

/** Python's str.splitlines() — note the extra separators, and no trailing "". */
export function pySplitlines(s: string): string[] {
  const lines: string[] = [];
  let current = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (LINE_BREAKS.has(ch)) {
      lines.push(current);
      current = "";
      if (ch === "\r" && s[i + 1] === "\n") i++;
    } else {
      current += ch;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/** len(s) in Python — counts code points, not UTF-16 units. */
export function cpLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** s[:n] in Python — never splits a character in two. */
export function cpSlice(s: string, n: number): string {
  if (s.length <= n) return s; // every code point is at least one unit
  let out = "";
  let count = 0;
  for (const ch of s) {
    if (count >= n) break;
    out += ch;
    count++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Truthiness and str()
// ---------------------------------------------------------------------------

/** Python's bool(value) for JSON-shaped data. */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** `value or fallback`. */
export function pyOr<T>(value: unknown, fallback: T): unknown {
  return pyTruthy(value) ? value : fallback;
}

/**
 * Python's repr() of a float that is not an integer: shortest round-trip
 * digits, fixed notation between 1e-4 and 1e16, otherwise "1e-05" style.
 */
function pyFloatRepr(n: number): string {
  if (Number.isNaN(n)) return "nan";
  if (n === Infinity) return "inf";
  if (n === -Infinity) return "-inf";
  const [mantissa, expPart] = n.toExponential().split("e");
  const exp = Number(expPart);
  if (exp < -4 || exp >= 16) {
    const sign = exp < 0 ? "-" : "+";
    const digits = String(Math.abs(exp)).padStart(2, "0");
    return `${mantissa}e${sign}${digits}`;
  }
  return String(n);
}

/**
 * Python's str(value) for JSON-shaped data.
 *
 * One unavoidable gap: JSON.parse turns "7.0" into 7, so a JSON float with no
 * fractional part prints as "7" here and "7.0" in Python.
 */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : pyFloatRepr(value);
  }
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries.map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`).join(", ")}}`;
  }
  return String(value);
}

function pyRepr(value: unknown): string {
  if (typeof value === "string") {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    const body = value
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return quote + (quote === "'" ? body.replace(/'/g, "\\'") : body) + quote;
  }
  return pyStr(value);
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

function decimalDigitValue(ch: string): string | null {
  const cp = ch.codePointAt(0)!;
  if (cp >= 0x30 && cp <= 0x39) return ch;
  for (const [zero, nine] of PY_DECIMAL_BLOCKS) {
    if (cp >= zero && cp <= nine) return String(cp - zero);
  }
  return null;
}

const FLOAT_SYNTAX = /^[+-]?(?:(?:\d(?:_?\d)*)?\.\d(?:_?\d)*|\d(?:_?\d)*\.?)(?:[eE][+-]?\d(?:_?\d)*)?$/;

/**
 * Python's float(value), returning null wherever Python raises TypeError or
 * ValueError. Accepts numbers, booleans, and strings in Python's float syntax
 * (including non-ASCII decimal digits and "1_000"). "inf" and "nan" parse to
 * Infinity and NaN, as in Python.
 */
export function pyFloat(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;

  let ascii = "";
  for (const ch of value) {
    if (isPySpace(ch)) {
      ascii += " ";
      continue;
    }
    ascii += decimalDigitValue(ch) ?? ch;
  }
  // Not .trim(): that would also drop U+FEFF, which Python does not treat as
  // whitespace. Every Python space has already become " " above.
  const text = ascii.replace(/^ +| +$/g, "");
  const special = /^([+-]?)(inf|infinity|nan)$/i.exec(text);
  if (special) {
    if (special[2].toLowerCase() === "nan") return NaN;
    return special[1] === "-" ? -Infinity : Infinity;
  }
  if (!FLOAT_SYNTAX.test(text)) return null;
  return Number(text.replace(/_/g, ""));
}

/** Python's round(x) — to an integer, halves to even. */
export function pyRoundInt(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor; // exact for any double below 2**52
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Python's round(x, ndigits) for ndigits >= 1. Python rounds the exact binary
 * value, and only an exact tie goes to even — so round(2.675, 2) is 2.67
 * (the double is 2.67499…) while round(6.125, 2) is 6.12 (6.125 is exact).
 */
export function pyRound(x: number, ndigits: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x);
  // The exact decimal expansion of a double at or above 2**-8 has at most
  // ~60 fractional digits, so this is exact wherever a tie is possible.
  const exact = abs.toFixed(Math.min(100, ndigits + 60));
  const [whole, frac] = exact.split(".");
  const tail = frac.slice(ndigits);
  const isTie = tail[0] === "5" && /^50*$/.test(tail);
  if (!isTie) return sign * Number(abs.toFixed(ndigits));
  const kept = whole + frac.slice(0, ndigits);
  const lastDigit = Number(kept[kept.length - 1]);
  let scaled = BigInt(kept);
  if (lastDigit % 2 === 1) scaled += 1n;
  return (sign * Number(scaled)) / 10 ** ndigits;
}

/** statistics.mean for a non-empty list of numbers. */
export function pyMean(values: number[]): number {
  if (values.length === 0) throw new Error("mean requires at least one data point");
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ---------------------------------------------------------------------------
// str.format
// ---------------------------------------------------------------------------

/**
 * Python's str.format(**values) for the subset prompts.py uses: named fields,
 * and doubled braces for literal "{" and "}". A missing field throws, exactly
 * as Python's KeyError would — a prompt that silently kept "{job_description}"
 * would be far worse than a crash.
 */
export function pyFormat(template: string, values: Record<string, unknown>): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch === "{") {
      if (template[i + 1] === "{") {
        out += "{";
        i += 2;
        continue;
      }
      const close = template.indexOf("}", i);
      if (close === -1) throw new Error("Single '{' encountered in format string");
      const name = template.slice(i + 1, close);
      // Python takes everything up to "}" as the field name — "{ spaced }"
      // is legal — except that attribute access, indexing, conversions and
      // format specs change its meaning, and a bare number or "" is positional.
      if (/[.[!:{]/.test(name) || /^\d*$/.test(name)) {
        throw new Error(`Unsupported format field {${name}}`);
      }
      if (!Object.hasOwn(values, name)) throw new Error(`Missing format field: ${name}`);
      out += pyStr(values[name]);
      i = close + 1;
      continue;
    }
    if (ch === "}") {
      if (template[i + 1] === "}") {
        out += "}";
        i += 2;
        continue;
      }
      throw new Error("Single '}' encountered in format string");
    }
    out += ch;
    i++;
  }
  return out;
}
