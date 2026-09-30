/**
 * A small in-memory rate limiter: a sliding window of timestamps per key.
 *
 * Best effort by design. The counts live in the memory of one server process,
 * so on a platform that runs several instances (Vercel), or after a cold
 * start, a determined caller gets more than the stated budget. It stops
 * casual abuse and runaway loops; the spending limit on the OpenRouter key is
 * the hard cap behind it.
 */

export interface Rule {
  /** Units allowed per window. */
  limit: number;
  windowMs: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly maxKeys = 10_000) {}

  /**
   * Spend `cost` units against `key`. Returns 0 if allowed, else the number of
   * seconds until enough units free up.
   */
  take(key: string, cost: number, rule: Rule, now = Date.now()): number {
    const since = now - rule.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (recent.length + cost > rule.limit) {
      this.hits.set(key, recent);
      // The oldest entries expire first; wait until enough of them have.
      const freeing = recent[recent.length + cost - rule.limit - 1] ?? recent[0] ?? now;
      return Math.max(1, Math.ceil((freeing + rule.windowMs - now) / 1000));
    }
    for (let i = 0; i < cost; i++) recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) this.prune(now, rule.windowMs);
    return 0;
  }

  /** Would `cost` units fit right now? (Checks without spending.) */
  wouldAllow(key: string, cost: number, rule: Rule, now = Date.now()): boolean {
    const since = now - rule.windowMs;
    return (this.hits.get(key) ?? []).filter((t) => t > since).length + cost <= rule.limit;
  }

  private prune(now: number, windowMs: number) {
    for (const [key, times] of this.hits) {
      if (!times.some((t) => t > now - windowMs)) this.hits.delete(key);
    }
  }
}
