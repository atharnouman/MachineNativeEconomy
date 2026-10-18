import type { Address, Hex } from "viem";
import { randomId, nowIso, intentHash, verifyApprovalSignature, type Approval, type Approver, type ApprovalVerdict, type Decision, type PaymentIntent } from "@spendmarshal/core";
import { approverKeyFor, type GatewayConfig } from "./config.js";
import type { Store } from "./store.js";
import type { ReceiptLog } from "./receipts.js";
import type { Metrics } from "./metrics.js";
import type { ApproverKeys } from "./approvers.js";

/**
 * Human-in-the-loop approvals. An escalated intent becomes a pending approval; an operator resolves it with
 * the admin token or, when the gateway is configured with approver keys, with an EIP-191 signature from one of
 * the approval's principal (its own approvers, or the gateway-wide ones, ADR-0024). Every transition is a receipt, and
 * signed resolutions verify offline in the evidence bundle against the key the approver held at that point in the
 * principal's chain.
 *
 * Every status change is a `transitionApproval` in the store, which writes only while the status is still the one this
 * change starts from: of two resolutions at once (in one gateway or two), one wins and the other gets 409, and only the
 * winner writes a receipt (ADR-0025).
 */
export class ApprovalService {
  constructor(
    private readonly cfg: GatewayConfig,
    private readonly store: Store,
    private readonly receipts: ReceiptLog,
    private readonly metrics?: Metrics,
    private readonly approverKeys?: ApproverKeys,
  ) {}

  async request(args: {
    intent: PaymentIntent;
    decision: Decision;
    amount: bigint;
    rail: "x402" | "mpp" | "l402";
    request: { method: "GET" | "POST"; body?: unknown };
  }): Promise<Approval> {
    const { intent } = args;
    const a: Approval = {
      v: 1,
      id: randomId("apr"),
      principalId: intent.principalId,
      intentId: intent.id,
      intentHash: intentHash(intent),
      credentialId: intent.credentialId,
      agentId: intent.agentId,
      amount: args.amount.toString(),
      token: intent.quotedAmount?.token ?? intent.maxAmount.token,
      chain: intent.quotedAmount?.chain ?? intent.maxAmount.chain,
      payee: { host: intent.payee.host, address: intent.payee.address, url: intent.payee.url },
      resource: intent.resource,
      purpose: intent.purpose,
      rail: args.rail,
      reasons: args.decision.reasons,
      status: "pending",
      requestedAt: nowIso(),
      expiresAt: new Date(Date.now() + (this.cfg.approvalTtlSeconds ?? 3600) * 1000).toISOString(),
      request: args.request,
    };
    await this.store.putApproval(a);
    this.metrics?.approvals.inc({ event: "requested" });
    this.metrics?.pendingApprovals.inc();
    await this.receipts.append(
      intent.principalId,
      "approval.requested",
      { approval: this.publicView(a), decision: { effect: args.decision.effect, reasons: args.decision.reasons, matchedRules: args.decision.matchedRules } },
      { agentId: intent.agentId, credentialId: intent.credentialId, intentId: intent.id, intentHash: a.intentHash, approvalId: a.id, rail: args.rail, policyHash: args.decision.policyHash },
    );
    return a;
  }

  /** Reads an approval, lazily expiring it (with a receipt) if its window has passed. */
  async get(id: string): Promise<Approval | undefined> {
    const a = await this.store.getApproval(id);
    if (!a) return undefined;
    if (a.status === "pending" && new Date(a.expiresAt).getTime() < Date.now()) {
      const expired: Approval = { ...a, status: "expired", resolvedAt: nowIso() };
      if (!(await this.store.transitionApproval(expired, ["pending"]))) return this.store.getApproval(id); // changed meanwhile
      this.metrics?.approvals.inc({ event: "expired" });
      this.metrics?.pendingApprovals.dec();
      await this.receipts.append(a.principalId, "approval.expired", { approval: this.publicView(expired) }, { agentId: a.agentId, credentialId: a.credentialId, intentId: a.intentId, intentHash: a.intentHash, approvalId: a.id });
      return expired;
    }
    return a;
  }

  list(principalId: string, status?: Approval["status"]): Promise<Approval[]> {
    return this.store.approvalsFor(principalId, status);
  }

  async resolve(id: string, verdict: ApprovalVerdict, approver: { id: string; signature?: Hex }, note?: string): Promise<Approval> {
    const a = await this.get(id);
    if (!a) throw Object.assign(new Error("approval not found"), { statusCode: 404 });
    if (a.status !== "pending") throw Object.assign(new Error(`approval is ${a.status}`), { statusCode: 409 });

    let resolved: Approver;
    const registered = approverKeyFor(this.cfg, a.principalId, approver.id);
    if (approver.signature) {
      if (!registered) throw Object.assign(new Error(`approver ${approver.id} has no registered key for ${a.principalId}`), { statusCode: 403 });
      const ok = await verifyApprovalSignature(a, verdict, approver.signature, registered as Address);
      if (!ok) throw Object.assign(new Error("approver signature invalid"), { statusCode: 403 });
      resolved = { id: approver.id, method: "signature", address: registered, signature: approver.signature };
      // the key is registered in this principal's chain before the resolution it signs (ADR-0019)
      await this.approverKeys?.sync(a.principalId);
    } else {
      if (this.cfg.requireSignedApprovals) throw Object.assign(new Error("signed approvals are required"), { statusCode: 403 });
      resolved = { id: approver.id, method: "admin-token" };
    }

    const next: Approval = { ...a, status: verdict === "approve" ? "approved" : "rejected", resolvedAt: nowIso(), approver: resolved, ...(note ? { note } : {}) };
    if (!(await this.store.transitionApproval(next, ["pending"]))) {
      // resolved (or expired) by someone else since it was read: theirs stands
      const now = await this.store.getApproval(id);
      throw Object.assign(new Error(`approval is ${now?.status ?? "gone"}`), { statusCode: 409 });
    }
    this.metrics?.approvals.inc({ event: verdict === "approve" ? "granted" : "rejected" });
    this.metrics?.pendingApprovals.dec();
    await this.receipts.append(
      next.principalId,
      verdict === "approve" ? "approval.granted" : "approval.rejected",
      { approval: this.publicView(next), approver: resolved, note: note ?? null },
      { agentId: next.agentId, credentialId: next.credentialId, intentId: next.intentId, intentHash: next.intentHash, approvalId: next.id, rail: next.rail },
    );
    return next;
  }

  /** Marks a granted approval used by the payment that settled under it; false if it was not (or no longer) granted. */
  async consume(id: string, byIntentId: string, txHash: Hex): Promise<boolean> {
    const a = await this.store.getApproval(id);
    if (!a) return false;
    const next: Approval = { ...a, status: "consumed", consumedAt: nowIso(), consumedByIntentId: byIntentId };
    if (!(await this.store.transitionApproval(next, ["approved"]))) return false;
    this.metrics?.approvals.inc({ event: "consumed" });
    await this.receipts.append(next.principalId, "approval.consumed", { approval: this.publicView(next), txHash }, { agentId: next.agentId, credentialId: next.credentialId, intentId: byIntentId, intentHash: next.intentHash, approvalId: next.id, rail: next.rail });
    return true;
  }

  /** What goes into receipts: the signed fields plus context, never the request body. */
  publicView(a: Approval) {
    const { request: _r, ...rest } = a;
    return rest;
  }
}
