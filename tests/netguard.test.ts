/**
 * The SSRF guard: which addresses are refused, the connection-level check,
 * redirects, and what the user is told.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

import { Agent } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertFetchable,
  BlockedAddressError,
  guardedAgent,
  guardedLookup,
  isPublicAddress,
  makeGuardedFetch,
  MAX_REDIRECTS,
  undiciTransport,
} from "@/lib/server/netguard";
import { fetchPostingText } from "@/lib/scraper";

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1", "127.8.9.10", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::10.0.0.1", "2002:0a00:0001::1",
    "[::1]", "fe80::1%eth0", "not-an-ip", "",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "192.169.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2002:0808:0808::1"])(
    "allows %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
});

describe("assertFetchable", () => {
  it.each([
    "http://127.0.0.1/admin",
    "http://[::1]:8080/",
    "http://169.254.169.254/latest/meta-data/",
    "http://0x7f000001/", // WHATWG URL normalises this to 127.0.0.1
    "http://2130706433/", // …and this one
    "http://localhost:3000/",
    "http://api.localhost/",
    "file:///etc/passwd",
    "ftp://example.com/",
  ])("refuses %s", (url) => {
    expect(() => assertFetchable(url)).toThrow(BlockedAddressError);
  });

  it("allows a public name — its address is checked at connection time", () => {
    expect(assertFetchable("https://careers.example.com/jobs/1").hostname).toBe("careers.example.com");
  });
});

describe("guardedLookup", () => {
  const fakeDns =
    (answers: Record<string, string[]>) =>
    (host: string, _o: object, cb: (e: NodeJS.ErrnoException | null, a: { address: string; family: number }[]) => void) =>
      cb(null, (answers[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));

  const lookup = guardedLookup(
    fakeDns({ "good.test": ["93.184.216.34"], "evil.test": ["10.0.0.5"], "mixed.test": ["93.184.216.34", "127.0.0.1"] }) as never,
  );
  const run = (host: string) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: unknown }>((resolve) =>
      lookup(host, {}, (err, address) => resolve({ err, address })),
    );

  it("passes a public answer through", async () => {
    expect(await run("good.test")).toEqual({ err: null, address: "93.184.216.34" });
  });

  it("refuses a name that resolves to a private address — or to any private address", async () => {
    for (const host of ["evil.test", "mixed.test", "nothing.test"]) {
      const { err } = await run(host);
      expect(err, host).toBeInstanceOf(BlockedAddressError);
      expect(err?.code).toBe("EBLOCKED");
    }
  });
});

// A real server on 127.0.0.1, reached through a name that "resolves" to it.
describe("the guarded connection, end to end", () => {
  let server: http.Server;
  let port = 0;
  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end("internal secrets"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("never connects when the name resolves inward, even though the server is listening", async () => {
    const toLoopback = ((_h: string, _o: object, cb: (e: null, a: { address: string; family: number }[]) => void) =>
      cb(null, [{ address: "127.0.0.1", family: 4 }])) as never;
    const guarded = makeGuardedFetch(undiciTransport(guardedAgent(toLoopback)));
    const err = await guarded(`http://rebind.test:${port}/`, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError); // fetch's "fetch failed"…
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(BlockedAddressError); // …because of the guard

    // Control: the same transport reaches the same server when the lookup is
    // not the guarded one — so it was the guard that stopped it, and the
    // transport's responses are ones the scraper can read.
    const open = await undiciTransport(new Agent())(`http://127.0.0.1:${port}/`, {});
    expect(open.status).toBe(200);
    expect(new TextDecoder().decode(await open.arrayBuffer())).toBe("internal secrets");
  });
});

describe("redirects", () => {
  const scripted = (hops: Record<string, [number, string?]>) => {
    const seen: string[] = [];
    const transport = async (url: string) => {
      seen.push(url);
      const [status, location] = hops[url] ?? [200];
      return new Response(status === 200 ? "ok" : null, { status, headers: location ? { location } : {} });
    };
    return { seen, fetch: makeGuardedFetch(transport) };
  };

  it("follows public redirects, resolving relative ones", async () => {
    const { seen, fetch } = scripted({
      "https://a.example.com/": [301, "https://b.example.com/x"],
      "https://b.example.com/x": [302, "/final"],
    });
    const res = await fetch("https://a.example.com/", { redirect: "follow" });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["https://a.example.com/", "https://b.example.com/x", "https://b.example.com/final"]);
  });

  it("refuses a redirect that points inward", async () => {
    const { seen, fetch } = scripted({ "https://a.example.com/": [302, "http://169.254.169.254/latest/meta-data/"] });
    await expect(fetch("https://a.example.com/", { redirect: "follow" })).rejects.toThrow(BlockedAddressError);
    expect(seen).toEqual(["https://a.example.com/"]); // the inward hop was never requested
  });

  it(`stops after ${MAX_REDIRECTS} redirects`, async () => {
    const hops: Record<string, [number, string]> = {};
    for (let i = 0; i < 10; i++) hops[`https://a.example.com/${i}`] = [302, `https://a.example.com/${i + 1}`];
    await expect(scripted(hops).fetch("https://a.example.com/0", { redirect: "follow" })).rejects.toThrow(/redirects/);
  });
});

describe("what the user is told", () => {
  it.each(["http://127.0.0.1/jobs", "http://192.168.0.10/jobs/1", "http://10.0.0.1:8080/admin"])("%s is refused before anything is fetched", async (url) => {
    const result = await fetchPostingText(url);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("That link points to a private or local network address, so it can't be fetched.");
    expect(result.hint).toContain("paste its text");
  });
});
