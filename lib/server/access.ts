/**
 * Who may use the API, and how much.
 *
 * Two independent protections for a public deployment:
 *
 *  - An optional access code. Set APP_ACCESS_CODE and every API call needs a
 *    cookie that only POST /api/login hands out, after the right code. Leave
 *    it unset and the app is open, as it is locally.
 *  - Rate limits per visitor (by IP address), always on: how many model calls,
 *    posting fetches, PDFs and login attempts each may make per window, plus
 *    one budget shared by everybody.
 *
 * Each Route Handler starts with guardRequest(); nothing else changes.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { RateLimiter, type Rule } from "./ratelimit";

export const ACCESS_CODE_ENV = "APP_ACCESS_CODE";
export const ACCESS_COOKIE = "ipa_access";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

const HOUR = 60 * 60 * 1000;

/** The budgets. One full 20-question interview is 43 model calls. */
export const RULES = {
  modelCallsPerVisitor: { limit: 100, windowMs: HOUR },
  modelCallsForEveryone: { limit: 1000, windowMs: HOUR },
  postingsPerVisitor: { limit: 15, windowMs: HOUR },
  reportsPerVisitor: { limit: 30, windowMs: HOUR },
  loginAttemptsPerVisitor: { limit: 10, windowMs: 15 * 60 * 1000 },
} satisfies Record<string, Rule>;

/** What each endpoint spends. */
export const COSTS = {
  job: { modelCalls: 2, postings: 1 }, // extraction + plan, and a page fetch
  question: { modelCalls: 1 },
  evaluate: { modelCalls: 1 },
  summary: { modelCalls: 1 },
  report: { reports: 1 }, // no model call, but PDF rendering is not free
} as const;
export type Endpoint = keyof typeof COSTS;

const limiter = new RateLimiter();

// ---------------------------------------------------------------------------

function configuredCode(env: NodeJS.ProcessEnv = process.env): string {
  return (env[ACCESS_CODE_ENV] ?? "").trim();
}

export function accessRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return configuredCode(env) !== "";
}

/** The cookie value: derived from the code, so changing the code signs everyone out. */
function tokenFor(code: string): string {
  return createHmac("sha256", code).update("interview-practice-ai/access/v1").digest("hex");
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function isAuthorised(request: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  const code = configuredCode(env);
  if (!code) return true;
  const cookie = readCookie(request, ACCESS_COOKIE);
  return cookie !== null && sameSecret(cookie, tokenFor(code));
}

/**
 * The caller's address. On Vercel, x-real-ip / x-forwarded-for are set by the
 * platform itself. Locally they are absent and every caller is "local".
 */
export function visitorOf(request: Request): string {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "local";
}

// ---------------------------------------------------------------------------

function refuse(status: 401 | 429, stage: "auth" | "rate_limit", error: string, retryAfter?: number): Response {
  const headers: Record<string, string> = retryAfter ? { "Retry-After": String(retryAfter) } : {};
  return Response.json({ ok: false, stage, error }, { status, headers });
}

function wait(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  return minutes <= 1 ? "a minute" : `${minutes} minutes`;
}

/**
 * Run the access check and spend the endpoint's budget. Returns a Response to
 * send back instead of doing the work, or null to go ahead. Nothing is spent
 * unless every budget has room, so a refused request costs nothing.
 */
export function guardRequest(request: Request, endpoint: Endpoint, now = Date.now()): Response | null {
  if (!isAuthorised(request)) {
    return refuse(401, "auth", "This app needs an access code. Enter it to continue.");
  }

  const visitor = visitorOf(request);
  const cost = COSTS[endpoint] as { modelCalls?: number; postings?: number; reports?: number };
  const checks: [string, number, Rule, string][] = [];
  if (cost.modelCalls) {
    checks.push([`calls:${visitor}`, cost.modelCalls, RULES.modelCallsPerVisitor, "You've reached this hour's limit of model calls"]);
    checks.push(["calls:*", cost.modelCalls, RULES.modelCallsForEveryone, "The app is busy right now"]);
  }
  if (cost.postings) checks.push([`postings:${visitor}`, cost.postings, RULES.postingsPerVisitor, "You've read a lot of postings this hour"]);
  if (cost.reports) checks.push([`reports:${visitor}`, cost.reports, RULES.reportsPerVisitor, "You've downloaded a lot of reports this hour"]);

  for (const [key, n, rule, message] of checks) {
    if (!limiter.wouldAllow(key, n, rule, now)) {
      const retry = limiter.take(key, n, rule, now); // computes the wait; spends nothing when refused
      return refuse(429, "rate_limit", `${message}. Please try again in ${wait(retry)}.`, retry);
    }
  }
  for (const [key, n, rule] of checks) limiter.take(key, n, rule, now);
  return null;
}

/**
 * POST /api/login's logic. Checks the code (rate-limited, so it can't be
 * guessed by brute force) and returns the response, with the cookie on success.
 */
export async function handleLogin(request: Request, now = Date.now()): Promise<Response> {
  const code = configuredCode();
  if (!code) return Response.json({ ok: true, required: false });

  const visitor = visitorOf(request);
  const retry = limiter.take(`login:${visitor}`, 1, RULES.loginAttemptsPerVisitor, now);
  if (retry) return refuse(429, "rate_limit", `Too many attempts. Please try again in ${wait(retry)}.`, retry);

  let given = "";
  try {
    const body = (await request.json()) as { code?: unknown };
    given = typeof body.code === "string" ? body.code.trim() : "";
  } catch {
    // fall through to the refusal
  }
  if (!sameSecret(tokenFor(given), tokenFor(code))) {
    return refuse(401, "auth", "That access code isn't right.");
  }

  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return Response.json(
    { ok: true, required: true },
    {
      headers: {
        "Set-Cookie": `${ACCESS_COOKIE}=${tokenFor(code)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${secure}`,
      },
    },
  );
}

/** GET /api/session: whether a code is needed, and whether this browser has passed it. */
export function sessionStatus(request: Request): Response {
  return Response.json({ required: accessRequired(), authorised: isAuthorised(request) });
}
