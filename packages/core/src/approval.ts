import { z } from "zod";
import { verifyMessage, type Address, type Hex } from "viem";

/**
 * Human-in-the-loop approvals. An `escalate` decision creates an approval request; an approver resolves it,
 * optionally with an EIP-191 signature over `approvalMessage()` so the resolution is verifiable offline by
 * anyone who knows the approver's address. Approver keys change, so each principal's receipt chain records them
 * (`approver.registered`, `approver.removed`) and the evidence verifier checks a signature against the key in force
 * at the resolution's position in the chain (ADR-0019).
 */

export const ApprovalStatusSchema = z.enum(["pending", "approved", "rejected", "expired", "consumed"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApproverSchema = z.object({
  id: z.string().min(1),
  method: z.enum(["admin-token", "signature"]),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  signature: z.string().regex(/^0x[0-9a-f]+$/).optional(),
});
export type Approver = z.infer<typeof ApproverSchema>;

export const ApprovalSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  principalId: z.string().min(1),
  intentId: z.string().min(1),
  intentHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  credentialId: z.string().min(1),
  agentId: z.string().min(1),
  amount: z.string().regex(/^\d+$/), // base units, the quoted price
  token: z.string(),
  chain: z.string(),
  payee: z.object({ host: z.string(), address: z.string().optional(), url: z.string() }),
  resource: z.string(),
  purpose: z.string(),
  rail: z.enum(["x402", "mpp", "l402"]),
  reasons: z.array(z.string()),
  status: ApprovalStatusSchema,
  requestedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  resolvedAt: z.string().datetime().optional(),
  approver: ApproverSchema.optional(),
  note: z.string().optional(),
  consumedAt: z.string().datetime().optional(),
  consumedByIntentId: z.string().optional(),
  /** How to replay the request on resume. Kept out of receipts (may hold a body). */
  request: z.object({ method: z.enum(["GET", "POST"]), body: z.unknown().optional() }).optional(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export type ApprovalVerdict = "approve" | "reject";

/** Data of an `approver.registered` receipt: from this position in the chain, `address` signs for `approverId`. */
export interface ApproverRegisteredData {
  approverId: string;
  address: Address;
  /** the key this one replaces in the same chain; null for the approver's first key */
  prevAddress: Address | null;
}

/** Data of an `approver.removed` receipt: from this position in the chain, `approverId` has no key. */
export interface ApproverRemovedData {
  approverId: string;
  prevAddress: Address;
}

/** The exact text an approver signs. Binding the intent hash and amount prevents reuse for another purchase. */
export function approvalMessage(a: Pick<Approval, "id" | "principalId" | "intentHash" | "amount">, verdict: ApprovalVerdict): string {
  return ["spendmarshal-approval v1", `id=${a.id}`, `principal=${a.principalId}`, `intentHash=${a.intentHash}`, `amount=${a.amount}`, `verdict=${verdict}`].join("\n");
}

export async function verifyApprovalSignature(
  a: Pick<Approval, "id" | "principalId" | "intentHash" | "amount">,
  verdict: ApprovalVerdict,
  signature: Hex,
  address: Address,
): Promise<boolean> {
  try {
    return await verifyMessage({ address, message: approvalMessage(a, verdict), signature });
  } catch {
    return false;
  }
}
