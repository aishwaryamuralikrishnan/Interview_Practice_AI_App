/** The access code and the rate limits (lib/server/access.ts, lib/server/ratelimit.ts). */

import { afterEach, describe, expect, it } from "vitest";

import { ACCESS_CODE_ENV, ACCESS_COOKIE, guardRequest, handleLogin, RULES, sessionStatus } from "@/lib/server/access";
import { RateLimiter } from "@/lib/server/ratelimit";

let n = 0;
/** A fresh visitor address for each test, so budgets don't leak between them. */
const visitor = () => `203.0.113.${++n}`;
const req = (ip: string, init: RequestInit = {}, path = "/api/question") =>
  new Request(`https://app.example.com${path}`, { method: "POST", ...init, headers: { "x-real-ip": ip, ...(init.headers as object) } });

afterEach(() => {
  delete process.env[ACCESS_CODE_ENV];
});

describe("RateLimiter", () => {
  const rule = { limit: 3, windowMs: 60_000 };

  it("allows up to the limit, then says how long to wait", () => {
    const l = new RateLimiter();
    expect([l.take("k", 1, rule, 0), l.take("k", 1, rule, 10_000), l.take("k", 1, rule, 20_000)]).toEqual([0, 0, 0]);
    expect(l.take("k", 1, rule, 30_000)).toBe(30); // the first hit expires at 60s
    expect(l.take("k", 1, rule, 60_001)).toBe(0); // …and then there is room again
  });

  it("charges multi-unit requests, and refuses one that doesn't fit whole", () => {
    const l = new RateLimiter();
    expect(l.take("k", 2, rule, 0)).toBe(0);
    expect(l.take("k", 2, rule, 1_000)).toBeGreaterThan(0);
    expect(l.take("k", 1, rule, 1_000)).toBe(0); // the refused request spent nothing
  });

  it("keeps keys apart", () => {
    const l = new RateLimiter();
    for (let i = 0; i < 3; i++) l.take("a", 1, rule, 0);
    expect(l.take("a", 1, rule, 0)).toBeGreaterThan(0);
    expect(l.take("b", 1, rule, 0)).toBe(0);
  });
});

describe("rate limits on the API", () => {
  it(`allows ${RULES.modelCallsPerVisitor.limit} model calls an hour per visitor, then refuses with Retry-After`, async () => {
    const ip = visitor();
    const t = 1_000_000;
    for (let i = 0; i < RULES.modelCallsPerVisitor.limit; i++) expect(guardRequest(req(ip), "question", t)).toBeNull();
    const refused = guardRequest(req(ip), "question", t)!;
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await refused.json()).toMatchObject({ ok: false, stage: "rate_limit", error: expect.stringContaining("try again in") });
    // A different visitor is unaffected; the first one recovers after the window.
    expect(guardRequest(req(visitor()), "question", t)).toBeNull();
    expect(guardRequest(req(ip), "question", t + RULES.modelCallsPerVisitor.windowMs + 1)).toBeNull();
  });

  it("counts reading a posting as two model calls and one page fetch", () => {
    const ip = visitor();
    const t = 2_000_000;
    for (let i = 0; i < RULES.postingsPerVisitor.limit; i++) expect(guardRequest(req(ip, {}, "/api/job"), "job", t)).toBeNull();
    expect(guardRequest(req(ip, {}, "/api/job"), "job", t)?.status).toBe(429);
  });

  it("limits PDFs separately, and they don't use up model calls", () => {
    const ip = visitor();
    const t = 3_000_000;
    for (let i = 0; i < RULES.reportsPerVisitor.limit; i++) expect(guardRequest(req(ip), "report", t)).toBeNull();
    expect(guardRequest(req(ip), "report", t)?.status).toBe(429);
    expect(guardRequest(req(ip), "question", t)).toBeNull();
  });
});

describe("the access code", () => {
  it("is off unless APP_ACCESS_CODE is set", async () => {
    expect(guardRequest(req(visitor()), "summary")).toBeNull();
    expect(await sessionStatus(req(visitor())).json()).toEqual({ required: false, authorised: true });
    expect(await (await handleLogin(req(visitor(), { body: "{}" }))).json()).toEqual({ ok: true, required: false });
  });

  it("when set, refuses the API until the right code is entered", async () => {
    process.env[ACCESS_CODE_ENV] = "open-sesame";
    const ip = visitor();

    const refused = guardRequest(req(ip), "question")!;
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ ok: false, stage: "auth" });
    expect(await sessionStatus(req(ip)).json()).toEqual({ required: true, authorised: false });

    const wrong = await handleLogin(req(ip, { body: JSON.stringify({ code: "sesame" }) }, "/api/login"));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();

    const right = await handleLogin(req(ip, { body: JSON.stringify({ code: " open-sesame " }) }, "/api/login"));
    expect(right.status).toBe(200);
    const cookie = right.headers.get("set-cookie")!;
    expect(cookie).toMatch(new RegExp(`^${ACCESS_COOKIE}=[0-9a-f]{64}; Path=/; HttpOnly; SameSite=Lax; Max-Age=\\d+; Secure$`));
    expect(cookie).not.toContain("open-sesame"); // the cookie never contains the code itself

    const withCookie = { headers: { cookie: cookie.split(";")[0] } };
    expect(guardRequest(req(ip, withCookie), "question")).toBeNull();
    expect(await sessionStatus(req(ip, withCookie)).json()).toEqual({ required: true, authorised: true });

    // Changing the code signs everyone out.
    process.env[ACCESS_CODE_ENV] = "new-code";
    expect(guardRequest(req(ip, withCookie), "question")?.status).toBe(401);
  });

  it("can't be guessed by brute force", async () => {
    process.env[ACCESS_CODE_ENV] = "open-sesame";
    const ip = visitor();
    const t = 4_000_000;
    for (let i = 0; i < RULES.loginAttemptsPerVisitor.limit; i++) {
      expect((await handleLogin(req(ip, { body: JSON.stringify({ code: `guess-${i}` }) }, "/api/login"), t)).status).toBe(401);
    }
    const blocked = await handleLogin(req(ip, { body: JSON.stringify({ code: "open-sesame" }) }, "/api/login"), t);
    expect(blocked.status).toBe(429); // even the right code waits out the lockout
  });
});
