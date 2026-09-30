/**
 * Fetching a user-supplied link without letting it reach private networks
 * (server-side request forgery).
 *
 * The app fetches whatever link it is given. On a laptop that is harmless; on
 * a server, a link like http://169.254.169.254/ or http://10.0.0.5/admin
 * would make the server fetch its own cloud metadata or internal services and
 * hand back the result. Three checks close that:
 *
 *  1. The address every connection actually uses is checked, inside the
 *     socket's DNS lookup. Checking a name and then letting fetch resolve it
 *     again would leave a gap: a hostile DNS server can answer "public" to the
 *     check and "private" to the connection (DNS rebinding).
 *  2. A link written as an IP address never goes through DNS, so it is checked
 *     directly.
 *  3. Redirects are followed by hand, and every hop is checked the same way —
 *     a public page must not be able to bounce the request inward.
 */

import dns from "node:dns";
import net from "node:net";

import { Agent, fetch as undiciFetch } from "undici";

export class BlockedAddressError extends Error {
  constructor(readonly target: string) {
    super(`${target} is a private or local network address`);
    this.name = "BlockedAddressError";
  }
}

// ---------------------------------------------------------------------------
// Which addresses are off-limits
// ---------------------------------------------------------------------------

const BLOCKED = new net.BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata at 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. broadcast
] as const) {
  BLOCKED.addSubnet(prefix, bits, "ipv4");
}
for (const [prefix, bits] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  BLOCKED.addSubnet(prefix, bits, "ipv6");
}

/** The IPv4 address hidden inside an IPv6 one, for the forms that carry one. */
function embeddedIPv4(address: string): string | null {
  const lower = address.toLowerCase();
  // ::ffff:10.0.0.1, ::ffff:a00:1, 64:ff9b::10.0.0.1 (NAT64), ::10.0.0.1 (deprecated compatible)
  const dotted = /^(?:::ffff:|64:ff9b::|::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  // 6to4: 2002:AABB:CCDD::/48 carries AA.BB.CC.DD
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/.exec(lower);
  if (sixToFour) {
    const hi = parseInt(sixToFour[1], 16);
    const lo = parseInt(sixToFour[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** True for an address on the public internet; false for anything private, local or reserved. */
export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").split("%")[0]; // brackets, zone id
  const family = net.isIP(bare);
  if (family === 4) return !BLOCKED.check(bare, "ipv4");
  if (family === 6) {
    const inner = embeddedIPv4(bare);
    if (inner !== null) return isPublicAddress(inner);
    return !BLOCKED.check(bare, "ipv6");
  }
  return false; // not an address at all
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// The connection-level check
// ---------------------------------------------------------------------------

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;
type Lookup = (hostname: string, options: dns.LookupOptions, callback: LookupCallback) => void;

/**
 * A drop-in for dns.lookup that refuses to hand a private address to the
 * socket. Every connection the guarded fetch makes resolves through this, so
 * the address checked is the address connected to.
 */
export function guardedLookup(resolve: Lookup = dns.lookup as unknown as Lookup): Lookup {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const list = (addresses as dns.LookupAddress[]).filter(Boolean);
      const bad = list.find((a) => !isPublicAddress(a.address));
      if (bad || list.length === 0) {
        return callback(Object.assign(new BlockedAddressError(hostname), { code: "EBLOCKED" }), []);
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

/** An HTTP agent whose every connection resolves through guardedLookup. */
export function guardedAgent(resolve?: Lookup): Agent {
  return new Agent({ connect: { lookup: guardedLookup(resolve) } });
}

/** undici's fetch, sending every request through `agent`. */
export function undiciTransport(agent: Agent): FetchLike {
  return (url, init) =>
    undiciFetch(url, { ...(init as object), dispatcher: agent } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}

// ---------------------------------------------------------------------------
// The guarded fetch
// ---------------------------------------------------------------------------

export const MAX_REDIRECTS = 5;

/** Throw unless the URL is http(s) and, if its host is written as an IP, a public one. */
export function assertFetchable(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new BlockedAddressError(parsed.protocol);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && !isPublicAddress(host)) throw new BlockedAddressError(host);
  if (host === "localhost" || host.endsWith(".localhost")) throw new BlockedAddressError(host);
  return parsed;
}

/**
 * fetch(), for links typed by users: every hop is checked, redirects are
 * followed by hand (at most MAX_REDIRECTS), and connections go through
 * guardedLookup. Throws BlockedAddressError when a hop is off-limits.
 *
 * `transport` is injectable so the redirect handling can be tested without a
 * network; it defaults to undici's fetch through the guarded agent.
 */
export function makeGuardedFetch(transport: FetchLike = undiciTransport(guardedAgent())): FetchLike {
  return async (url, init) => {
    let current = url;
    for (let hop = 0; ; hop++) {
      assertFetchable(current);
      const response = await transport(current, { ...init, redirect: "manual" });
      const location = response.headers.get("location");
      if (response.status < 300 || response.status > 399 || !location) return response;
      if (init.redirect === "error") throw new TypeError("unexpected redirect");
      if (init.redirect === "manual") return response;
      if (hop >= MAX_REDIRECTS) throw new TypeError(`more than ${MAX_REDIRECTS} redirects`);
      await response.body?.cancel();
      current = new URL(location, current).href;
    }
  };
}

export const guardedFetch = makeGuardedFetch();
