import type { FastifyRequest } from "fastify";
import { effectiveLimits, verifyMessage, publicKeyFromJwk, jwkThumbprint, contentDigestMatches, NonceWindow, HOLDER_TAG, type Credential } from "@spendmarshal/core";

const nonces = new NonceWindow();

export interface HolderCheck {
  ok: boolean;
  bound: boolean;
  keyid?: string;
  reason?: string;
}

/**
 * Inbound proof of possession. If the credential carries a `holder_key` caveat, the request must be signed with
 * that key (RFC 9421, tag spendmarshal-holder) over @method, @authority, @path and, for bodies, Content-Digest.
 */
export async function checkHolder(req: FastifyRequest, cred: Credential, rawBody: string | undefined): Promise<HolderCheck> {
  const holder = effectiveLimits(cred.caveats).holderKey;
  if (!holder) return { ok: true, bound: false };
  const keyid = jwkThumbprint(holder);
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v])) as Record<string, string | undefined>;
  const url = `${req.protocol}://${req.headers.host}${req.url}`;
  const required = ["@method", "@authority", "@path", ...(rawBody ? ["content-digest"] : [])];
  if (rawBody && !contentDigestMatches(headers, rawBody)) return { ok: false, bound: true, keyid, reason: "Content-Digest does not match body" };
  const res = await verifyMessage(
    { method: req.method, url, headers },
    { resolveKey: (id) => (id === keyid ? publicKeyFromJwk(holder) : undefined), requireTag: HOLDER_TAG, requireComponents: required, nonceSeen: (n, k) => nonces.seenBefore(n, k) },
  );
  return res.ok ? { ok: true, bound: true, keyid } : { ok: false, bound: true, keyid, reason: res.reason };
}
