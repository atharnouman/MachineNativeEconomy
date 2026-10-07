import { createHmac } from "node:crypto";
import { z } from "zod";
import { canonicalize, hashJson } from "./canonical.js";
import { minBig, maxBig } from "./amount.js";

/**
 * Credentials are macaroon-style bearer tokens.
 *
 *   sig_0 = HMAC(rootKey, rootId)
 *   sig_i = HMAC(sig_{i-1}, canonical(caveat_i))
 *
 * Anyone holding a credential can append caveats (and recompute the signature) without contacting the gateway.
 * Appending can only *restrict*, because evaluation is the conjunction of every caveat in the chain. Removing a
 * caveat is impossible without the previous signature, which the holder never sees.
 *
 * A `delegate` caveat names a new agent; everything after it belongs to that sub-agent. The credential's id and
 * agentId are derived from the chain, so they are bound into the signature too.
 */

export const RailSchema = z.enum(["x402", "mpp"]);
export type Rail = z.infer<typeof RailSchema>;

export const CaveatSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delegate"), agentId: z.string().min(1), nonce: z.string().min(1) }),
  z.object({ type: z.literal("spend_cap"), value: z.string().regex(/^\d+$/) }), // base units, lineage total
  z.object({ type: z.literal("per_tx_max"), value: z.string().regex(/^\d+$/) }),
  z.object({ type: z.literal("expires_at"), value: z.string().datetime() }),
  z.object({ type: z.literal("not_before"), value: z.string().datetime() }),
  z.object({ type: z.literal("allowed_payees"), value: z.array(z.string().min(1)).min(1) }), // host or address
  z.object({ type: z.literal("allowed_rails"), value: z.array(RailSchema).min(1) }),
  z.object({ type: z.literal("purposes"), value: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal("chains"), value: z.array(z.string().regex(/^eip155:\d+$/)).min(1) }),
]);
export type Caveat = z.infer<typeof CaveatSchema>;

export const CredentialSchema = z.object({
  v: z.literal(1),
  rootId: z.string().min(1),
  principalId: z.string().min(1),
  caveats: z.array(CaveatSchema).min(1),
  sig: z.string().regex(/^[0-9a-f]{64}$/),
});
export type Credential = z.infer<typeof CredentialSchema>;

/** Public, non-bearer view of a credential for receipts and evidence bundles. */
export type CredentialPublic = Omit<Credential, "sig"> & { id: string; agentId: string; parentId: string | null };

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

export function computeSig(rootKey: string, rootId: string, caveats: Caveat[]): Buffer {
  let sig: Buffer = hmac(rootKey, rootId);
  for (const c of caveats) sig = hmac(sig, canonicalize(c));
  return sig;
}

export function issueRoot(args: {
  rootKey: string;
  rootId: string;
  principalId: string;
  agentId: string;
  nonce: string;
  caveats?: Exclude<Caveat, { type: "delegate" }>[];
}): Credential {
  const caveats: Caveat[] = [{ type: "delegate", agentId: args.agentId, nonce: args.nonce }, ...(args.caveats ?? [])];
  return {
    v: 1,
    rootId: args.rootId,
    principalId: args.principalId,
    caveats,
    sig: computeSig(args.rootKey, args.rootId, caveats).toString("hex"),
  };
}

/** Offline attenuation: append caveats (optionally delegating to a sub-agent). Never needs the root key. */
export function attenuate(
  parent: Credential,
  caveats: Caveat[],
  delegateTo?: { agentId: string; nonce: string },
): Credential {
  const added: Caveat[] = delegateTo ? [{ type: "delegate", ...delegateTo }, ...caveats] : caveats;
  let sig: Uint8Array = Buffer.from(parent.sig, "hex");
  for (const c of added) sig = hmac(sig, canonicalize(c));
  return { ...parent, caveats: [...parent.caveats, ...added], sig: Buffer.from(sig).toString("hex") };
}

export function verifyCredential(rootKey: string, c: Credential): { ok: true } | { ok: false; reason: string } {
  const parsed = CredentialSchema.safeParse(c);
  if (!parsed.success) return { ok: false, reason: `schema: ${parsed.error.issues[0]?.message}` };
  if (c.caveats[0]?.type !== "delegate") return { ok: false, reason: "first caveat must be delegate" };
  const expected = computeSig(rootKey, c.rootId, c.caveats).toString("hex");
  if (expected !== c.sig) return { ok: false, reason: "signature mismatch" };
  return { ok: true };
}

export function credentialId(c: Pick<Credential, "rootId" | "caveats">): string {
  return `${c.rootId}:${hashJson(c.caveats).slice(2, 18)}`;
}

export function agentIdOf(c: Pick<Credential, "caveats">): string {
  for (let i = c.caveats.length - 1; i >= 0; i--) {
    const cv = c.caveats[i]!;
    if (cv.type === "delegate") return cv.agentId;
  }
  throw new Error("credential has no delegate caveat");
}

/** Ancestry: the credential truncated at each delegate caveat, outermost first (root ... parent, self). */
export function lineage(c: Pick<Credential, "rootId" | "caveats">): Array<Pick<Credential, "rootId" | "caveats">> {
  const idx: number[] = [];
  c.caveats.forEach((cv, i) => cv.type === "delegate" && idx.push(i));
  const out: Array<Pick<Credential, "rootId" | "caveats">> = [];
  for (let k = 0; k < idx.length; k++) {
    const end = k + 1 < idx.length ? idx[k + 1]! : c.caveats.length;
    out.push({ rootId: c.rootId, caveats: c.caveats.slice(0, end) });
  }
  return out;
}

export function parentOf(c: Pick<Credential, "rootId" | "caveats">): Pick<Credential, "rootId" | "caveats"> | null {
  const l = lineage(c);
  return l.length >= 2 ? l[l.length - 2]! : null;
}

export function toPublic(c: Credential): CredentialPublic {
  const { sig: _sig, ...rest } = c;
  const p = parentOf(c);
  return { ...rest, id: credentialId(c), agentId: agentIdOf(c), parentId: p ? credentialId(p) : null };
}

/** The conjunction of every caveat in the chain. `null` means "unrestricted" for that dimension. */
export interface EffectiveLimits {
  spendCap: bigint | null;
  perTxMax: bigint | null;
  expiresAt: Date | null;
  notBefore: Date | null;
  allowedPayees: Set<string> | null;
  allowedRails: Set<Rail> | null;
  purposes: Set<string> | null;
  chains: Set<string> | null;
}

function intersect<T>(a: Set<T> | null, b: T[]): Set<T> {
  const s = new Set(b);
  if (a === null) return s;
  return new Set([...a].filter((x) => s.has(x)));
}

export function effectiveLimits(caveats: Caveat[]): EffectiveLimits {
  const e: EffectiveLimits = {
    spendCap: null,
    perTxMax: null,
    expiresAt: null,
    notBefore: null,
    allowedPayees: null,
    allowedRails: null,
    purposes: null,
    chains: null,
  };
  for (const c of caveats) {
    switch (c.type) {
      case "delegate":
        break;
      case "spend_cap":
        e.spendCap = e.spendCap === null ? BigInt(c.value) : minBig(e.spendCap, BigInt(c.value));
        break;
      case "per_tx_max":
        e.perTxMax = e.perTxMax === null ? BigInt(c.value) : minBig(e.perTxMax, BigInt(c.value));
        break;
      case "expires_at": {
        const d = new Date(c.value);
        e.expiresAt = e.expiresAt === null || d < e.expiresAt ? d : e.expiresAt;
        break;
      }
      case "not_before": {
        const d = new Date(c.value);
        e.notBefore = e.notBefore === null || d > e.notBefore ? d : e.notBefore;
        break;
      }
      case "allowed_payees":
        e.allowedPayees = intersect(e.allowedPayees, c.value.map((x) => x.toLowerCase()));
        break;
      case "allowed_rails":
        e.allowedRails = intersect(e.allowedRails, c.value);
        break;
      case "purposes":
        e.purposes = intersect(e.purposes, c.value);
        break;
      case "chains":
        e.chains = intersect(e.chains, c.value);
        break;
    }
  }
  return e;
}

/** True iff `child` is at least as restrictive as `parent` in every dimension. */
export function isSubsetOf(child: EffectiveLimits, parent: EffectiveLimits): { ok: boolean; violations: string[] } {
  const v: string[] = [];
  const leBig = (c: bigint | null, p: bigint | null) => p === null || (c !== null && c <= p);
  if (!leBig(child.spendCap, parent.spendCap)) v.push("spendCap");
  if (!leBig(child.perTxMax, parent.perTxMax)) v.push("perTxMax");
  if (parent.expiresAt !== null && (child.expiresAt === null || child.expiresAt > parent.expiresAt)) v.push("expiresAt");
  if (parent.notBefore !== null && (child.notBefore === null || child.notBefore < parent.notBefore)) v.push("notBefore");
  const sub = <T>(c: Set<T> | null, p: Set<T> | null) => p === null || (c !== null && [...c].every((x) => p.has(x)));
  if (!sub(child.allowedPayees, parent.allowedPayees)) v.push("allowedPayees");
  if (!sub(child.allowedRails, parent.allowedRails)) v.push("allowedRails");
  if (!sub(child.purposes, parent.purposes)) v.push("purposes");
  if (!sub(child.chains, parent.chains)) v.push("chains");
  return { ok: v.length === 0, violations: v };
}

export function encodeCredential(c: Credential): string {
  return Buffer.from(canonicalize(c), "utf8").toString("base64url");
}

export function decodeCredential(s: string): Credential {
  return CredentialSchema.parse(JSON.parse(Buffer.from(s, "base64url").toString("utf8")));
}

export { maxBig };
