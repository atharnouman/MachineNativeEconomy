import { z } from "zod";
import { getAddress, hashMessage, keccak256, recoverMessageAddress, type Address, type Hex } from "viem";
import { secp256k1 } from "@noble/curves/secp256k1";
import { hashJson } from "./canonical.js";

/**
 * A receipt is the unit of evidence. Every decision (allow / deny / escalate), every settlement, every
 * credential event, every approval transition, every policy change and every kill-switch flip produces one.
 * Receipts for a principal form a hash chain (prev -> hash), each signed by the gateway key (EIP-191
 * personal_sign over the receipt hash), so a bundle can be verified offline with nothing but the gateway's
 * address. When the gateway key changes, a `gateway.key.rotated` receipt records it in the chain, and each
 * receipt verifies against the key in force at its position (ADR-0020).
 */

export const ReceiptKindSchema = z.enum([
  "credential.issued",
  "credential.registered", // on-chain session compiled from caveats
  "decision", // policy decision (simulate, precheck, quote); effect inside data
  "payment.settled",
  "payment.denied", // gateway denial of a real payment attempt
  "onchain.denied", // the account contract rejected an authorization (independent of the gateway)
  "preapproval.reclaimed", // an expired, unused standard-x402 pre-approval had its charge restored on-chain
  "approval.requested",
  "approval.granted",
  "approval.rejected",
  "approval.expired",
  "approval.consumed",
  "approver.registered", // an approver's key comes into force in this chain (first key, or a rotation)
  "approver.removed", // the approver left the configuration: no key from here on
  "policy.updated",
  "subscription.created",
  "subscription.charged",
  "subscription.refused", // a payee charge call refused (cadence, caps, status, policy)
  "subscription.cancelled",
  "killswitch",
  "evidence.anchored",
  "gateway.key.rotated", // the receipt-signing key changed: this receipt and the ones after it are signed by data.address
  "external", // attached by an operator / demo with provenance in data.source
]);
export type ReceiptKind = z.infer<typeof ReceiptKindSchema>;

export const ReceiptSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  principalId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  prev: z.string().regex(/^0x[0-9a-f]{64}$/).nullable(),
  ts: z.string().datetime(),
  kind: ReceiptKindSchema,
  agentId: z.string().optional(),
  credentialId: z.string().optional(),
  intentId: z.string().optional(),
  intentHash: z.string().regex(/^0x[0-9a-f]{64}$/).optional(),
  approvalId: z.string().optional(),
  subscriptionId: z.string().optional(),
  rail: z.enum(["x402", "mpp", "l402"]).optional(),
  policyHash: z.string().regex(/^0x[0-9a-f]{64}$/).optional(),
  data: z.record(z.unknown()),
  hash: z.string().regex(/^0x[0-9a-f]{64}$/),
  sig: z.string().regex(/^0x[0-9a-f]+$/),
});
export type Receipt = z.infer<typeof ReceiptSchema>;
export type ReceiptBody = Omit<Receipt, "hash" | "sig">;

export function receiptHash(body: ReceiptBody): Hex {
  return hashJson(body);
}

/**
 * The address that signed a receipt (EIP-191 over its hash), recovered synchronously. In a valid chain this is the
 * gateway key in force at the receipt's position. Throws on a malformed signature.
 */
export function receiptSigner(r: Pick<Receipt, "hash" | "sig">): Address {
  if (!/^0x[0-9a-fA-F]{130}$/.test(r.sig)) throw new Error("receipt signature is not 65 bytes");
  const v = parseInt(r.sig.slice(130), 16);
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) throw new Error(`receipt signature has recovery id ${v}`);
  const point = secp256k1.Signature.fromCompact(r.sig.slice(2, 130)).addRecoveryBit(recovery).recoverPublicKey(hashMessage({ raw: r.hash as Hex }).slice(2));
  return getAddress(`0x${keccak256(point.toRawBytes(false).slice(1)).slice(-40)}`);
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Data of a `gateway.key.rotated` receipt (ADR-0020). The receipt is signed by `address`, the key it brings into force.
 * `handover` is `prevAddress`'s EIP-191 signature over `gatewayKeyHandoverMessage()` for this position, or null when the
 * gateway no longer held that key.
 */
export interface GatewayKeyRotatedData {
  prevAddress: Address;
  address: Address;
  handover: Hex | null;
}

/**
 * The exact text an earlier gateway key signs to hand a principal's chain over to a new key. `prev` is the hash of the
 * receipt before the rotation, so the handover holds for this chain at this position and nowhere else.
 */
export function gatewayKeyHandoverMessage(h: { principalId: string; seq: number; prev: string | null; prevAddress: string; address: string }): string {
  return ["spendmarshal-gateway-key-handover v1", `principal=${h.principalId}`, `seq=${h.seq}`, `prev=${h.prev}`, `from=${h.prevAddress.toLowerCase()}`, `to=${h.address.toLowerCase()}`].join("\n");
}

/** One change of the gateway key in a principal's chain (ADR-0020). */
export const GatewayKeyChangeSchema = z.object({
  address: z.string().regex(ADDRESS), // the key in force from this receipt on
  prevAddress: z.string().regex(ADDRESS), // the key it replaced
  seq: z.number().int().nonnegative(), // position of the rotation receipt, the first one the new key signs
  effectiveFrom: z.string().datetime(), // that receipt's timestamp
  receiptId: z.string().min(1),
  handedOver: z.boolean(), // the previous key signed a handover (verifyChain checks the signature)
});
export type GatewayKeyChange = z.infer<typeof GatewayKeyChangeSchema>;

/**
 * Every change of the gateway key in a chain, in order, read from its `gateway.key.rotated` receipts. The gateway exports
 * this as `gatewayKeyHistory`; the verifier recomputes it. Malformed rotations are left out here and reported by
 * `verifyChain`.
 */
export function gatewayKeyHistory(receipts: readonly Receipt[]): GatewayKeyChange[] {
  const out: GatewayKeyChange[] = [];
  for (const r of receipts) {
    const k = rotationOf(r);
    if (k) out.push({ address: k.address, prevAddress: k.prevAddress, seq: r.seq, effectiveFrom: r.ts, receiptId: r.id, handedOver: k.handover !== null });
  }
  return out;
}

/**
 * The gateway key that signed the receipt at `seq`, given the chain's rotations: the last rotation at or before it, else
 * the chain's first key (`gatewayAddress` when it has no rotation). An anchor that records no sender was sent by it.
 */
export function gatewayKeyAt(keys: readonly GatewayKeyChange[], gatewayAddress: string, seq: number): string {
  let key = keys[0]?.prevAddress ?? gatewayAddress;
  for (const k of keys) if (k.seq <= seq) key = k.address;
  return key;
}

function rotationOf(r: Receipt): GatewayKeyRotatedData | null {
  if (r.kind !== "gateway.key.rotated") return null;
  const d = r.data as { prevAddress?: unknown; address?: unknown; handover?: unknown };
  if (typeof d.prevAddress !== "string" || !ADDRESS.test(d.prevAddress) || typeof d.address !== "string" || !ADDRESS.test(d.address)) return null;
  if (d.handover !== null && !(typeof d.handover === "string" && /^0x[0-9a-fA-F]+$/.test(d.handover))) return null;
  return { prevAddress: d.prevAddress as Address, address: d.address as Address, handover: d.handover as Hex | null };
}

async function handoverSignedBy(r: Receipt, k: GatewayKeyRotatedData): Promise<boolean> {
  const message = gatewayKeyHandoverMessage({ principalId: r.principalId, seq: r.seq, prev: r.prev, prevAddress: k.prevAddress, address: k.address });
  const signer = await recoverMessageAddress({ message, signature: k.handover as Hex }).catch(() => null);
  return signer !== null && sameAddress(signer, k.prevAddress);
}

export async function verifyReceipt(
  r: Receipt,
  gatewayAddress: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // strict: every member of a receipt is covered by its hash, so one the schema does not know is refused, never dropped
  const parsed = ReceiptSchema.strict().safeParse(r);
  if (!parsed.success) return { ok: false, reason: `schema: ${parsed.error.issues[0]?.message}` };
  const { hash, sig, ...body } = r;
  const expected = receiptHash(body);
  if (expected !== hash) return { ok: false, reason: `hash mismatch (expected ${expected})` };
  let signer: string;
  try {
    signer = await recoverMessageAddress({ message: { raw: hash as Hex }, signature: sig as Hex });
  } catch {
    return { ok: false, reason: "signature is malformed" }; // reported as a failed check, never thrown at the caller
  }
  if (signer.toLowerCase() !== gatewayAddress.toLowerCase()) return { ok: false, reason: `signer ${signer} is not gateway` };
  return { ok: true };
}

/**
 * Verifies hashes, signatures and chain links for an ordered list of receipts. Each receipt must be signed by the gateway
 * key in force at its position (ADR-0020). Without `gateway.key.rotated` receipts that is `gatewayAddress` throughout,
 * exactly as before key history. With them, it is the key the first rotation replaces until then, and each rotation's
 * new key from that rotation on. A rotation must name the key it replaces, a handover must be that key's signature, and
 * the chain must end with `gatewayAddress`.
 */
export async function verifyChain(
  receipts: Receipt[],
  gatewayAddress: string,
): Promise<{ ok: boolean; problems: string[]; head: Hex | null; keys: GatewayKeyChange[] }> {
  const problems: string[] = [];
  const keys = gatewayKeyHistory(receipts);
  let inForce: string = keys[0]?.prevAddress ?? gatewayAddress;
  let prev: string | null = null;
  let seq = -1;
  for (const r of receipts) {
    if (r.kind === "gateway.key.rotated") {
      const k = rotationOf(r);
      if (!k) problems.push(`${r.id}: malformed gateway.key.rotated`);
      else {
        if (!sameAddress(k.prevAddress, inForce)) problems.push(`${r.id}: hands over from ${k.prevAddress}, but ${inForce} was in force`);
        else if (sameAddress(k.address, inForce)) problems.push(`${r.id}: rotates to the key already in force`);
        if (k.handover !== null && !(await handoverSignedBy(r, k))) problems.push(`${r.id}: handover is not signed by ${k.prevAddress}`);
        inForce = k.address;
      }
    }
    const v = await verifyReceipt(r, inForce);
    if (!v.ok) problems.push(`${r.id}: ${v.reason}`);
    if (r.prev !== prev) problems.push(`${r.id}: prev link broken`);
    if (r.seq !== seq + 1) problems.push(`${r.id}: seq ${r.seq} expected ${seq + 1}`);
    prev = r.hash;
    seq = r.seq;
  }
  if (keys.length > 0 && !sameAddress(inForce, gatewayAddress)) problems.push(`chain ends with gateway key ${inForce}, expected ${gatewayAddress}`);
  return { ok: problems.length === 0, problems, head: (prev as Hex | null) ?? null, keys };
}
