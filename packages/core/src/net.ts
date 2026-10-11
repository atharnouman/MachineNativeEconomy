import { isIP } from "node:net";

/**
 * Outbound-request hygiene shared by the gateway (payee URLs supplied by agents) and the payee (Signature-Agent
 * origins supplied by callers). Both are untrusted input that turns into a server-side fetch.
 */

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
];

export type HostClass = "loopback" | "private" | "public";

/** loopback = this machine; private = RFC 1918, link-local (cloud metadata), CGNAT, ULA, local names; public = everything else. */
export function classifyHost(hostname: string): HostClass {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return "loopback";
  if (h.endsWith(".local") || h.endsWith(".internal")) return "private";
  const v = isIP(h);
  if (v === 4) {
    if (/^127\./.test(h) || /^0\./.test(h)) return "loopback";
    return PRIVATE_V4.some((re) => re.test(h)) ? "private" : "public";
  }
  if (v === 6) {
    if (h === "::1" || h === "::") return "loopback";
    if (h.startsWith("::ffff:")) return classifyHost(h.slice(7));
    return h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") ? "private" : "public";
  }
  return "public";
}

/** True for loopback and private/link-local hosts alike. */
export function isPrivateHost(hostname: string): boolean {
  return classifyHost(hostname) !== "public";
}

export interface OutboundPolicy {
  /** Allow loopback destinations (a payee on this machine: local demos). Default false. */
  allowLoopback?: boolean;
  /** Allow private, link-local and CGNAT destinations as well (in-cluster payees). Implies `allowLoopback`. Default false. */
  allowPrivate?: boolean;
  /** If set, only these hostnames (exact, lowercase) or `*.suffix` patterns may be contacted. */
  allowedHosts?: string[];
}

/** Returns the parsed URL if it may be fetched, or a reason string. */
export function checkOutboundUrl(raw: string, policy: OutboundPolicy = {}): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "malformed URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: `scheme ${url.protocol} not allowed` };
  if (url.username || url.password) return { ok: false, reason: "credentials in URL not allowed" };
  const host = url.hostname.toLowerCase();
  if (policy.allowedHosts && !policy.allowedHosts.some((p) => (p.startsWith("*.") ? host.endsWith(p.slice(1)) || host === p.slice(2) : host === p.toLowerCase()))) {
    return { ok: false, reason: `host ${host} is not in the outbound allowlist` };
  }
  const cls = classifyHost(host);
  if (cls === "loopback" && !policy.allowLoopback && !policy.allowPrivate) return { ok: false, reason: `host ${host} is loopback` };
  if (cls === "private" && !policy.allowPrivate) return { ok: false, reason: `host ${host} is private or link-local` };
  return { ok: true, url };
}
