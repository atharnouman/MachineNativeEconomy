import { z } from "zod";
import { verifyMessage, type Address, type Hex } from "viem";

/**
 * Human-in-the-loop approvals. An `escalate` decision creates an approval request; an approver resolves it,
 * optionally with an EIP-191 signature over `approvalMessage()` so the resolution is verifiable offline by
 * anyone who knows the approver's address (the evidence bundle lists registered approvers).
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

/** The exact text an approver signs. Binding the intent hash and amount prevents reuse for another purchase. */
export function approvalMessage(a: Pick<Approval, "id" | "principalId" | "intentHash" | "amount">, verdict: ApprovalVerdict): string {
  return ["apgw-approval v1", `id=${a.id}`, `principal=${a.principalId}`, `intentHash=${a.intentHash}`, `amount=${a.amount}`, `verdict=${verdict}`].join("\n");
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
