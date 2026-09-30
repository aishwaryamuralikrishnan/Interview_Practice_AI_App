/**
 * Display formatting shared by the UI. Kept apart from lib/py.ts: these are
 * for people, not for reproducing Python output byte for byte.
 */

/** Like Python's `{score:g}` for the values this app produces: 7 → "7", 6.75 → "6.75". */
export function formatScore(score: number): string {
  return String(Math.round(score * 100) / 100);
}

/** One decimal, as the bar labels were: 7 → "7.0". */
export function formatScore1(score: number): string {
  return (Math.round(score * 10) / 10).toFixed(1);
}

export function formatUsd(amount: number): string {
  return amount < 0.01 ? "< $0.01" : `$${amount.toFixed(2)}`;
}

export function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}

/** "careers.example.com" from a full link, or the text itself if it isn't one. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Only http(s) links are ever rendered as links. */
export function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") + "…" : text;
}
