import { z } from "zod";
import { recoverMessageAddress, type Hex } from "viem";
import { hashJson } from "./canonical.js";

/**
 * A receipt is the unit of evidence. Every decision (allow / deny / escalate), every settlement, every
 * credential event, every approval transition, every policy change and every kill-switch flip produces one.
 * Receipts for a principal form a hash chain (prev -> hash), each signed by the gateway key (EIP-191
 * personal_sign over the receipt hash), so a bundle can be verified offline with nothing but the gateway's
 * address.
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
  "policy.updated",
  "subscription.created",
  "subscription.charged",
  "subscription.refused", // a payee charge call refused (cadence, caps, status, policy)
  "subscription.cancelled",
  "killswitch",
  "evidence.anchored",
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

export async function verifyReceipt(
  r: Receipt,
  gatewayAddress: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parsed = ReceiptSchema.safeParse(r);
  if (!parsed.success) return { ok: false, reason: `schema: ${parsed.error.issues[0]?.message}` };
  const { hash, sig, ...body } = r;
  const expected = receiptHash(body);
  if (expected !== hash) return { ok: false, reason: `hash mismatch (expected ${expected})` };
  const signer = await recoverMessageAddress({ message: { raw: hash as Hex }, signature: sig as Hex });
  if (signer.toLowerCase() !== gatewayAddress.toLowerCase()) return { ok: false, reason: `signer ${signer} is not gateway` };
  return { ok: true };
}

/** Verifies hashes, signatures and chain links for an ordered list of receipts. */
export async function verifyChain(
  receipts: Receipt[],
  gatewayAddress: string,
): Promise<{ ok: boolean; problems: string[]; head: Hex | null }> {
  const problems: string[] = [];
  let prev: string | null = null;
  let seq = -1;
  for (const r of receipts) {
    const v = await verifyReceipt(r, gatewayAddress);
    if (!v.ok) problems.push(`${r.id}: ${v.reason}`);
    if (r.prev !== prev) problems.push(`${r.id}: prev link broken`);
    if (r.seq !== seq + 1) problems.push(`${r.id}: seq ${r.seq} expected ${seq + 1}`);
    prev = r.hash;
    seq = r.seq;
  }
  return { ok: problems.length === 0, problems, head: (prev as Hex | null) ?? null };
}
