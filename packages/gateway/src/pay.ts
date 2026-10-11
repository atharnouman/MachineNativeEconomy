import { keccak256, toHex, type Address, type Hex } from "viem";
import { createHash, randomBytes } from "node:crypto";
import {
  evaluate,
  credentialId,
  agentIdOf,
  lineage,
  budgetPathFor,
  rootAgentOf,
  intentHash,
  randomId,
  nowIso,
  amount as mkAmount,
  toBase,
  toWireAuthorization,
  signAsAgent,
  checkOutboundUrl,
  parseDuration,
  preimageMatches,
  subscriptionPublic,
  X402_HEADERS,
  MPP_HEADERS,
  X402RequiredSchema,
  X402ResponseSchema,
  decodeX402,
  encodeX402,
  decodeMppChallengeHeader,
  encodeMppCredentialHeader,
  decodeMppReceipt,
  decodeL402ChallengeHeader,
  encodeL402AuthorizationHeader,
  type Credential,
  type PaymentIntent,
  type Decision,
  type Rail,
  type Receipt,
  type Approval,
  type PaymentAuthorizationStruct,
  type TokenAuthorizationStruct,
  type AuthorizationPayload,
  type X402StandardPayload,
  type Subscription,
  type SubscriptionTerms,
  type SubscribeRequest,
  type ChargeRequest,
  type MppCredential,
} from "@apgw/core";
import type { GatewayConfig } from "./config.js";
import type { Store } from "./store.js";
import type { Signer } from "./signer.js";
import type { ChainClient } from "./chain.js";
import type { ReceiptLog } from "./receipts.js";
import type { PolicyService } from "./policies.js";
import type { ApprovalService } from "./approvals.js";
import type { Metrics } from "./metrics.js";

export interface PayRequest {
  url: string;
  method?: "GET" | "POST";
  body?: unknown;
  maxAmount: string; // human units, e.g. "0.05"
  purpose: string;
  rail?: Rail | "auto";
  /** Resume an escalated intent under a granted approval. */
  approvalId?: string;
  /** Override the gateway's x402 payload mode for this payment (see GatewayConfig.x402Mode). */
  x402Mode?: "agent-account" | "standard";
}

export interface PayResult {
  ok: boolean;
  status: number;
  rail?: Rail;
  /** Which x402 payload shape was used (MPP always uses agent-account). */
  payloadKind?: "agent-account" | "standard";
  intent: PaymentIntent;
  decision?: Decision;
  onchain?: { ok: boolean; reason: string | null };
  settlement?: {
    txHash: Hex;
    blockNumber: string;
    amount: string;
    payee: Address;
    approvalTxHash?: Hex;
    /** L402: the proof of payment and the native amount */
    lightning?: { preimage: string; paymentHash: string; amountSats: string; satsPerUsdc: number; delivered: boolean };
  };
  pending?: { approvalId: string; expiresAt: string; reasons: string[] };
  receipts: Receipt[];
  body?: unknown;
  error?: string;
  /** internal: the decoded MPP receipt (carries the payee-side subscription id) */
  mppReceipt?: { subscriptionId?: string };
}

export interface SubscribeResult {
  ok: boolean;
  status: number;
  subscription?: ReturnType<typeof subscriptionPublic>;
  firstCharge?: PayResult;
  error?: string;
}

export interface ChargeResult {
  ok: boolean;
  status: number;
  subscriptionId: string;
  subscriptionStatus: Subscription["status"];
  amount?: string;
  txHash?: Hex;
  charges?: number;
  totalCharged?: string;
  nextAllowedAt?: string;
  reasons?: string[];
  error?: string;
}

interface Quote {
  rail: Rail;
  amount: bigint; // reference units (USDC base)
  token: Address;
  chain: string;
  payTo: Address;
  timeoutSeconds: number;
  x402?: { network: string; accept: unknown };
  mpp?: { challengeId: string; subscriptionOffer?: NonNullable<ReturnType<typeof decodeMppChallengeHeader>>["methods"][number]["subscription"] };
  l402?: { macaroon: string; invoice: string; paymentHash: string; amountSats: bigint; satsPerUsdc: number };
}

const ZERO: Address = "0x0000000000000000000000000000000000000000";

/**
 * The pay-side flow, rail-agnostic:
 *   intent -> structural pre-check -> fetch -> 402 quote -> binding decision (quoted amount)
 *   -> [escalate: approval request, 202] -> on-chain simulate -> reserve -> sign -> retry with rail headers
 *   -> confirm (on-chain, or preimage for Lightning) -> commit. Every arrow produces a receipt.
 *
 * Subscriptions reuse the same flow for their first charge, then the payee charges the gateway directly
 * (`charge()`), which runs policy and settles on-chain without a 402 round trip.
 */
export class PaymentService {
  constructor(
    private readonly cfg: GatewayConfig,
    private readonly store: Store,
    private readonly signer: Signer,
    private readonly chain: ChainClient,
    private readonly receipts: ReceiptLog,
    private readonly policies: PolicyService,
    private readonly approvals: ApprovalService,
    private readonly extras: { metrics?: Metrics; publicUrl: string } = { publicUrl: "http://127.0.0.1:4402" },
  ) {}

  /**
   * Every request to a payee is signed as a Web Bot Auth agent (RFC 9421, Ed25519) unless disabled, so a payee
   * can distinguish a governed agent behind this gateway from an anonymous bot, and look the key up at
   * `${publicUrl}/.well-known/http-message-signatures-directory`.
   */
  private payeeFetch(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<Response> {
    // never an open proxy: scheme, credentials, private ranges and the optional allowlist are checked first
    const check = checkOutboundUrl(url, this.cfg.outbound ?? {});
    if (!check.ok) return Promise.reject(Object.assign(new Error(`outbound blocked: ${check.reason}`), { statusCode: 403 }));
    const headers = this.cfg.signOutbound === false ? init.headers : { ...init.headers, ...signAsAgent({ method: init.method, url, headers: init.headers }, this.signer.agentKey, this.extras.publicUrl, init.body) };
    // never follow redirects: a paid retry carries payment headers that must not travel to a third host
    return fetch(url, { method: init.method, headers, body: init.body, redirect: "manual" });
  }

  buildIntent(cred: Credential, req: { url: string; maxAmount: string; purpose: string; rail?: Rail | "auto" }): PaymentIntent {
    // the request -> intent boundary: a URL the gateway may never fetch is refused before policy, receipts or any fetch
    const check = checkOutboundUrl(req.url, this.cfg.outbound ?? {});
    if (!check.ok) throw Object.assign(new Error(`outbound blocked: ${check.reason}`), { statusCode: check.reason === "malformed URL" ? 400 : 403 });
    const u = check.url;
    return {
      v: 1,
      id: randomId("int"),
      principalId: cred.principalId,
      agentId: agentIdOf(cred),
      credentialId: credentialId(cred),
      payee: { url: req.url, host: u.host.toLowerCase() },
      resource: u.pathname + u.search,
      maxAmount: mkAmount({ asset: this.cfg.asset.symbol, chain: `eip155:${this.cfg.chainId}`, token: this.cfg.contracts.usdc, human: req.maxAmount, decimals: this.cfg.asset.decimals }),
      purpose: req.purpose,
      rail: req.rail ?? "auto",
      createdAt: nowIso(),
    };
  }

  private decide(intent: PaymentIntent, cred: Credential, amountBase: bigint, rail: Rail | "auto", approval?: Approval, stage: "structural" | "binding" = "binding"): Decision {
    return evaluate({
      policy: this.policies.active(cred.principalId),
      intent,
      credential: cred,
      amountBase,
      rail,
      ledger: this.store.ledgerView(),
      killSwitch: this.store.killSwitch(cred.principalId),
      approval: approval ? { id: approval.id } : undefined,
      stage,
    });
  }

  /** Simulation: fetch the payee's 402 quote (free), decide on the real quoted price, ask the account contract. Nothing is paid. */
  async simulate(cred: Credential, req: PayRequest): Promise<PayResult> {
    const intent = this.buildIntent(cred, req);
    let amountBase = BigInt(intent.maxAmount.value);
    let to: Address = this.cfg.contracts.usdc; // placeholder when the payee is free or unreachable
    let rail: Rail | "auto" = intent.rail;
    let quoteInfo: Record<string, unknown> = { quoted: false };
    try {
      const first = await this.payeeFetch(req.url, { method: req.method ?? "GET", headers: { accept: "application/json" } });
      if (first.status === 402) {
        const q = this.parseQuote(first, intent.rail);
        if (!("error" in q)) {
          amountBase = q.amount;
          to = q.payTo;
          rail = q.rail;
          intent.quotedAmount = mkAmount({ asset: this.cfg.asset.symbol, chain: q.chain, token: q.token, base: q.amount, decimals: this.cfg.asset.decimals });
          if (q.rail !== "l402") intent.payee.address = q.payTo;
          intent.rail = q.rail;
          quoteInfo = { quoted: true, amount: q.amount, payTo: q.payTo, rail: q.rail, exceedsMax: q.amount > BigInt(intent.maxAmount.value), ...(q.l402 ? { amountSats: q.l402.amountSats, satsPerUsdc: q.l402.satsPerUsdc } : {}) };
        } else quoteInfo = { quoted: false, error: q.error };
      } else quoteInfo = { quoted: false, status: first.status, note: "resource is not paywalled" };
    } catch (err) {
      quoteInfo = { quoted: false, error: `payee unreachable: ${String(err)}` };
    }
    const decision = this.decide(intent, cred, amountBase, rail);
    const onchain = rail === "l402" ? { ok: true, reason: "not applicable (lightning)" } : await this.simulateOnChain(cred, intent, amountBase, to);
    const r = await this.receipts.append(
      cred.principalId,
      "decision",
      { stage: "simulate", effect: decision.effect, reasons: decision.reasons, checks: decision.checks, matchedRules: decision.matchedRules, amount: amountBase, onchain, quote: quoteInfo },
      { agentId: intent.agentId, credentialId: intent.credentialId, intentId: intent.id, intentHash: intentHash(intent), policyHash: decision.policyHash, rail: rail === "auto" ? undefined : rail },
    );
    return { ok: decision.effect === "allow" && onchain.ok && !quoteInfo.exceedsMax, status: 200, rail: rail === "auto" ? undefined : rail, intent, decision, onchain, receipts: [r] };
  }

  private async simulateOnChain(cred: Credential, intent: PaymentIntent, amountBase: bigint, to: Address) {
    const reg = this.store.getCredential(credentialId(cred));
    if (!reg) return { ok: false, reason: "credential not registered on-chain" };
    const account = this.cfg.principals[cred.principalId]!.account;
    const auth = this.authorizationFor(intent, amountBase, to);
    return this.chain.simulate(account, auth, reg.sessionKey as Address);
  }

  private authorizationFor(intent: PaymentIntent, amountBase: bigint, to: Address): PaymentAuthorizationStruct {
    const now = Math.floor(Date.now() / 1000);
    return {
      token: this.cfg.contracts.usdc,
      to,
      amount: amountBase,
      intentHash: intentHash(intent),
      validAfter: 0n,
      validBefore: BigInt(now + this.cfg.authorizationTtlSeconds),
      nonce: keccak256(toHex(`${intent.id}:${to}:${amountBase}`)),
    };
  }

  /** Resume an escalated intent under a granted approval: re-runs the full dance with the approval attached. */
  async resume(cred: Credential, approvalId: string): Promise<PayResult> {
    const a = await this.approvals.get(approvalId);
    if (!a) throw Object.assign(new Error("approval not found"), { statusCode: 404 });
    if (a.credentialId !== credentialId(cred)) throw Object.assign(new Error("approval belongs to another credential"), { statusCode: 403 });
    const req: PayRequest = {
      url: a.payee.url,
      method: a.request?.method ?? "GET",
      body: a.request?.body,
      maxAmount: (Number(a.amount) / 10 ** this.cfg.asset.decimals).toFixed(this.cfg.asset.decimals),
      purpose: a.purpose,
      rail: a.rail,
      approvalId,
    };
    return this.pay(cred, req);
  }

  async pay(cred: Credential, req: PayRequest): Promise<PayResult> {
    const t0 = Date.now();
    const r = await this.payInner(cred, req);
    const outcome = r.ok ? "settled" : r.status === 202 ? "pending" : r.decision && r.decision.effect !== "allow" ? "denied" : "failed";
    this.extras.metrics?.payment(r.rail ?? "none", outcome, r.payloadKind ?? "-", (Date.now() - t0) / 1000);
    if (outcome === "denied" && r.decision?.reasons[0]) this.extras.metrics?.denials.inc({ reason: r.decision.reasons[0].split(":").slice(0, 2).join(":") });
    return r;
  }

  private async payInner(cred: Credential, req: PayRequest, internal: { subscription?: NonNullable<MppCredential["subscription"]> } = {}): Promise<PayResult> {
    const receipts: Receipt[] = [];
    const intent = this.buildIntent(cred, req);
    const meta = { agentId: intent.agentId, credentialId: intent.credentialId, intentId: intent.id };
    const reg = this.store.getCredential(intent.credentialId);
    if (!reg) {
      const r = await this.receipts.append(cred.principalId, "payment.denied", { reason: "credential not registered" }, meta);
      return { ok: false, status: 403, intent, receipts: [r], error: "credential not registered" };
    }

    // 0. an approval, if one is presented, must be granted, unexpired, and for this credential
    let approval: Approval | undefined;
    if (req.approvalId) {
      approval = await this.approvals.get(req.approvalId);
      if (!approval || approval.credentialId !== intent.credentialId || approval.status !== "approved") {
        const r = await this.receipts.append(cred.principalId, "payment.denied", { stage: "approval", reason: `approval ${req.approvalId} is ${approval?.status ?? "unknown"}` }, { ...meta, approvalId: req.approvalId });
        return { ok: false, status: 403, intent, receipts: [r], error: `approval ${req.approvalId} is ${approval?.status ?? "unknown"}` };
      }
    }
    const metaA = approval ? { ...meta, approvalId: approval.id } : meta;

    // 1. structural pre-check: could this ever be allowed? amount predicates and amount checks wait for the quote
    const pre = this.decide(intent, cred, 0n, intent.rail, approval, "structural");
    receipts.push(await this.receipts.append(cred.principalId, "decision", { stage: "precheck", effect: pre.effect, reasons: pre.reasons, checks: pre.checks, matchedRules: pre.matchedRules, amount: "0", ceiling: intent.maxAmount.value }, { ...metaA, policyHash: pre.policyHash }));
    if (pre.effect === "deny") {
      receipts.push(await this.receipts.append(cred.principalId, "payment.denied", { stage: "precheck", effect: pre.effect, reasons: pre.reasons }, { ...metaA, policyHash: pre.policyHash }));
      return { ok: false, status: 403, intent, decision: pre, receipts, error: `denied: ${pre.reasons.join(", ")}` };
    }

    // 2. first request, unpaid (signed as an agent so the payee can tell who is asking)
    const bodyText = req.body !== undefined ? JSON.stringify(req.body) : undefined;
    const baseHeaders: Record<string, string> = { accept: "application/json", ...(bodyText !== undefined ? { "content-type": "application/json" } : {}) };
    const first = await this.payeeFetch(req.url, { method: req.method ?? "GET", headers: baseHeaders, body: bodyText });
    if (first.status !== 402) {
      const body = await readBody(first);
      return { ok: first.ok, status: first.status, intent, decision: pre, receipts, body };
    }

    // 3. parse the quote(s)
    const quote = this.parseQuote(first, intent.rail);
    if ("error" in quote) {
      receipts.push(await this.receipts.append(cred.principalId, "payment.denied", { stage: "quote", reason: quote.error }, metaA));
      return { ok: false, status: 502, intent, decision: pre, receipts, error: quote.error };
    }
    intent.quotedAmount = mkAmount({ asset: this.cfg.asset.symbol, chain: quote.chain, token: quote.token, base: quote.amount, decimals: this.cfg.asset.decimals });
    if (quote.rail !== "l402") intent.payee.address = quote.payTo;
    intent.rail = quote.rail;
    const ih = intentHash(intent);
    const metaQ = { ...metaA, intentHash: ih, rail: quote.rail };

    if (quote.amount > BigInt(intent.maxAmount.value)) {
      receipts.push(await this.receipts.append(cred.principalId, "payment.denied", { stage: "quote", reason: "quoted price exceeds agent ceiling", quoted: quote.amount, max: intent.maxAmount.value }, metaQ));
      return { ok: false, status: 402, intent, decision: pre, receipts, error: "quoted price exceeds maxAmount" };
    }
    if (approval && (quote.amount.toString() !== approval.amount || (quote.rail !== "l402" && quote.payTo.toLowerCase() !== approval.payee.address?.toLowerCase()) || quote.rail !== approval.rail)) {
      receipts.push(await this.receipts.append(cred.principalId, "payment.denied", { stage: "quote", reason: "quote differs from the approved one", quoted: { amount: quote.amount, payTo: quote.payTo, rail: quote.rail }, approved: { amount: approval.amount, payTo: approval.payee.address, rail: approval.rail } }, metaQ));
      return { ok: false, status: 409, intent, decision: pre, receipts, error: "quote differs from the approved one; request a new approval" };
    }
    if (internal.subscription && quote.rail !== "mpp") {
      receipts.push(await this.receipts.append(cred.principalId, "payment.denied", { stage: "quote", reason: "subscriptions need the MPP rail" }, metaQ));
      return { ok: false, status: 502, intent, decision: pre, receipts, error: "subscriptions need the MPP rail" };
    }

    // 4. binding decision on the quoted price
    const decision = this.decide(intent, cred, quote.amount, quote.rail, approval);
    const onchain = quote.rail === "l402" ? { ok: true, reason: "not applicable (lightning)" } : await this.simulateOnChain(cred, intent, quote.amount, quote.payTo);
    this.store.putIntent({ intent, amount: quote.amount.toString(), effect: decision.effect, ts: nowIso() });
    receipts.push(await this.receipts.append(cred.principalId, "decision", { stage: "quote", effect: decision.effect, reasons: decision.reasons, checks: decision.checks, matchedRules: decision.matchedRules, amount: quote.amount, onchain, quote: { payTo: quote.payTo, token: quote.token, chain: quote.chain, ...(quote.l402 ? { amountSats: quote.l402.amountSats, satsPerUsdc: quote.l402.satsPerUsdc } : {}) } }, { ...metaQ, policyHash: decision.policyHash }));
    if (decision.effect === "escalate") {
      const a = await this.approvals.request({ intent, decision, amount: quote.amount, rail: quote.rail, request: { method: req.method ?? "GET", body: req.body } });
      return { ok: false, status: 202, rail: quote.rail, intent, decision, onchain, pending: { approvalId: a.id, expiresAt: a.expiresAt, reasons: decision.reasons }, receipts, error: "approval required" };
    }
    if (decision.effect !== "allow") {
      receipts.push(await this.receipts.append(cred.principalId, "payment.denied", { stage: "quote", effect: decision.effect, reasons: decision.reasons, amount: quote.amount, onchain }, { ...metaQ, policyHash: decision.policyHash }));
      return { ok: false, status: 403, intent, decision, onchain, receipts, error: `denied: ${decision.reasons.join(", ")}` };
    }
    if (!onchain.ok) {
      receipts.push(await this.receipts.append(cred.principalId, "onchain.denied", { stage: "quote", reason: onchain.reason, amount: quote.amount }, metaQ));
      return { ok: false, status: 403, intent, decision, onchain, receipts, error: `on-chain would reject: ${onchain.reason}` };
    }

    // 5. reserve
    const entry = this.store.reserve({
      id: randomId("led"),
      ts: nowIso(),
      principalId: cred.principalId,
      intentId: intent.id,
      agentId: intent.agentId,
      rootAgentId: rootAgentOf(cred),
      credentialIds: lineage(cred).map(credentialId),
      budgetIds: budgetPathFor(this.policies.active(cred.principalId), rootAgentOf(cred)),
      amount: quote.amount.toString(),
    });

    // ── L402: pay the invoice through the Lightning backend; the preimage is the proof ──
    if (quote.rail === "l402") return this.settleLightning(cred, req, intent, decision, onchain, quote, entry.id, receipts, metaQ, bodyText, baseHeaders);

    // 6. sign, retry with payment
    const account = this.cfg.principals[cred.principalId]!.account;
    const auth = this.authorizationFor(intent, quote.amount, quote.payTo);
    const payloadKind: "agent-account" | "standard" = quote.rail === "x402" && (req.x402Mode ?? this.cfg.x402Mode ?? "agent-account") === "standard" ? "standard" : "agent-account";
    let approvalTxHash: Hex | undefined;
    let payload: AuthorizationPayload | X402StandardPayload;
    if (payloadKind === "standard") {
      // Interop path: the account pre-approves the EIP-3009 digest under its caveats (one tx, gas paid by the
      // gateway); the facilitator then settles with plain transferWithAuthorization and ERC-1271.
      const tauth: TokenAuthorizationStruct = { token: auth.token, to: auth.to, value: auth.amount, validAfter: auth.validAfter, validBefore: auth.validBefore, nonce: auth.nonce, intentHash: auth.intentHash };
      const tsig = await this.signer.signTokenAuthorization(intent.credentialId, account, this.cfg.chainId, tauth);
      const appr = await this.chain.approveAuthorization(account, tauth, tsig);
      if (!appr.ok) {
        this.store.release(entry.id);
        receipts.push(await this.receipts.append(cred.principalId, "onchain.denied", { stage: "approve", reason: appr.reason, amount: quote.amount }, metaQ));
        return { ok: false, status: 403, intent, decision, onchain, receipts, error: `on-chain pre-approval rejected: ${appr.reason}` };
      }
      approvalTxHash = appr.txHash;
      this.store.putPreApproval({ digest: appr.digest, principalId: cred.principalId, account, credentialId: intent.credentialId, intentId: intent.id, value: quote.amount.toString(), validBefore: auth.validBefore.toString(), approvalTxHash: appr.txHash, createdAt: nowIso(), state: "pending" });
      payload = {
        signature: `0x${"00".repeat(65)}`, // ignored by the account; ERC-1271 answers from the approved digest
        authorization: { from: account, to: auth.to, value: auth.amount.toString(), validAfter: auth.validAfter.toString(), validBefore: auth.validBefore.toString(), nonce: auth.nonce },
      };
    } else {
      const signature = await this.signer.signAuthorization(intent.credentialId, account, this.cfg.chainId, auth);
      payload = { kind: "agent-account", account, authorization: toWireAuthorization(auth), signature };
    }

    const headers: Record<string, string> = { ...baseHeaders };
    if (quote.rail === "x402") headers[X402_HEADERS.signature] = encodeX402({ x402Version: 2, scheme: "exact", network: quote.x402!.network, payload });
    else headers[MPP_HEADERS.credential] = encodeMppCredentialHeader({ challengeId: quote.mpp!.challengeId, method: "evm-agent-account", payload: payload as AuthorizationPayload, ...(internal.subscription ? { subscription: internal.subscription } : {}) });

    // Note for the standard path: the on-chain pre-approval already charged the session's spend. If the payee or
    // facilitator then fails to settle, the funds have not moved but the charge stands until the authorization
    // expires; the denial receipt records the approval tx so an operator can see it.
    const orphan = approvalTxHash ? { approvalTxHash, note: "on-chain pre-approval charged the session; funds did not move" } : {};

    let second: Response;
    try {
      second = await this.payeeFetch(req.url, { method: req.method ?? "GET", headers, body: bodyText });
    } catch (err) {
      this.store.release(entry.id);
      receipts.push(await this.receipts.append(cred.principalId, "payment.denied", { stage: "settle", reason: `payee unreachable: ${String(err)}`, ...orphan }, metaQ));
      return { ok: false, status: 502, intent, decision, receipts, error: "payee unreachable" };
    }

    // 7. confirm settlement on-chain: never trust the payee's word
    const txHash = this.settlementTx(second, quote.rail);
    const mppReceipt = quote.rail === "mpp" ? decodeMppReceipt(second.headers.get(MPP_HEADERS.receipt) ?? undefined) : null;
    const body = await readBody(second);
    if (!second.ok || !txHash) {
      this.store.release(entry.id);
      receipts.push(await this.receipts.append(cred.principalId, "payment.denied", { stage: "settle", reason: `payee rejected payment (status ${second.status})`, body, ...orphan }, metaQ));
      return { ok: false, status: second.status, intent, decision, receipts, error: "payee rejected payment", body };
    }
    const confirm =
      payloadKind === "standard"
        ? await this.chain.confirmStandardPayment(txHash, quote.token, account, quote.payTo, quote.amount, auth.nonce)
        : await this.chain.confirmPayment(txHash, account, ih, quote.amount, quote.payTo);
    if (!confirm.ok) {
      this.store.release(entry.id);
      receipts.push(await this.receipts.append(cred.principalId, "payment.denied", { stage: "confirm", reason: confirm.reason, txHash, ...orphan }, metaQ));
      return { ok: false, status: 502, intent, decision, receipts, error: `settlement not confirmed: ${confirm.reason}` };
    }
    const settledAt = nowIso();
    this.store.settle(entry.id, txHash, settledAt);
    if (payloadKind === "standard") {
      const pre = this.store.pendingPreApprovals(cred.principalId).find((p) => p.intentId === intent.id);
      if (pre) this.store.putPreApproval({ ...pre, state: "settled", settledTxHash: txHash });
    }
    const settlement = { txHash, blockNumber: confirm.blockNumber!.toString(), amount: quote.amount.toString(), payee: quote.payTo, ...(approvalTxHash ? { approvalTxHash } : {}) };
    receipts.push(
      await this.receipts.append(
        cred.principalId,
        "payment.settled",
        { ...settlement, payloadKind, account, token: quote.token, chain: quote.chain, resource: intent.resource, nonce: auth.nonce, budgets: entry.budgetIds, lineage: entry.credentialIds, ledgerEntryId: entry.id, approvalId: approval?.id ?? null, subscriptionId: internal.subscription?.id ?? null },
        { ...metaQ, policyHash: decision.policyHash, ...(internal.subscription ? { subscriptionId: internal.subscription.id } : {}) },
      ),
    );
    if (approval) await this.approvals.consume(approval.id, intent.id, txHash);
    return { ok: true, status: 200, rail: quote.rail, payloadKind, intent, decision, onchain, settlement, receipts, body, mppReceipt: mppReceipt ? { subscriptionId: mppReceipt.subscriptionId } : undefined };
  }

  /** L402 settlement: pay the invoice, verify the preimage ourselves, present it. Lightning is final: a payee that refuses after payment is recorded as such. */
  private async settleLightning(
    cred: Credential,
    req: PayRequest,
    intent: PaymentIntent,
    decision: Decision,
    onchain: { ok: boolean; reason: string | null },
    quote: Quote,
    entryId: string,
    receipts: Receipt[],
    metaQ: Record<string, unknown>,
    bodyText: string | undefined,
    baseHeaders: Record<string, string>,
  ): Promise<PayResult> {
    const ln = quote.l402!;
    let paid: { preimage: string; paymentHash: string; amountSats: bigint };
    try {
      paid = await this.cfg.lightning!.payInvoice(ln.invoice);
    } catch (err) {
      this.store.release(entryId);
      receipts.push(await this.receipts.append(cred.principalId, "payment.denied", { stage: "settle", reason: `lightning payment failed: ${(err as Error).message}` }, metaQ));
      return { ok: false, status: 502, intent, decision, onchain, receipts, error: `lightning payment failed: ${(err as Error).message}` };
    }
    if (!preimageMatches(paid.preimage, ln.paymentHash)) {
      // money may have moved for a hash we did not ask for: keep the charge, flag it loudly
      this.store.settle(entryId, `0x${paid.paymentHash}` as Hex, nowIso());
      receipts.push(await this.receipts.append(cred.principalId, "payment.denied", { stage: "confirm", reason: "preimage does not match the invoice payment hash", preimage: paid.preimage, paymentHash: paid.paymentHash, expected: ln.paymentHash }, metaQ));
      return { ok: false, status: 502, intent, decision, onchain, receipts, error: "preimage does not match the invoice" };
    }
    const headers = { ...baseHeaders, authorization: encodeL402AuthorizationHeader(ln.macaroon, paid.preimage) };
    let second: Response | undefined;
    try {
      second = await this.payeeFetch(req.url, { method: req.method ?? "GET", headers, body: bodyText });
    } catch {
      second = undefined;
    }
    const delivered = !!second && second.ok;
    const body = second ? await readBody(second) : undefined;
    const settledAt = nowIso();
    this.store.settle(entryId, `0x${paid.paymentHash}` as Hex, settledAt); // sats left the wallet either way
    const lightning = { preimage: paid.preimage, paymentHash: paid.paymentHash, amountSats: paid.amountSats.toString(), satsPerUsdc: ln.satsPerUsdc, delivered };
    const settlement = { txHash: `0x${paid.paymentHash}` as Hex, blockNumber: "0", amount: quote.amount.toString(), payee: ZERO, lightning };
    receipts.push(
      await this.receipts.append(
        cred.principalId,
        "payment.settled",
        { ...settlement, payloadKind: "l402", resource: intent.resource, ledgerEntryId: entryId, delivered, payeeStatus: second?.status ?? null },
        { ...metaQ, policyHash: decision.policyHash },
      ),
    );
    if (!delivered) return { ok: false, status: second?.status ?? 502, rail: "l402", intent, decision, onchain, settlement, receipts, body, error: "paid, but the payee did not deliver (preimage retained as proof)" };
    return { ok: true, status: 200, rail: "l402", intent, decision, onchain, settlement, receipts, body };
  }

  // ───────────────────────────── subscriptions ─────────────────────────────

  async subscribe(cred: Credential, req: SubscribeRequest): Promise<SubscribeResult> {
    const dec = this.cfg.asset.decimals;
    const maxPerCharge = toBase(req.maxAmountPerCharge, dec);
    // learn the payee's offer from its 402 (signed, unpaid)
    const probe = await this.payeeFetch(req.url, { method: "GET", headers: { accept: "application/json" } });
    if (probe.status !== 402) return { ok: false, status: 502, error: `payee did not return 402 (got ${probe.status})` };
    const q = this.parseQuote(probe, "mpp");
    if ("error" in q) return { ok: false, status: 502, error: q.error };
    const offer = q.mpp?.subscriptionOffer;
    if (!offer) return { ok: false, status: 409, error: "payee does not offer a subscription on this resource" };
    if (BigInt(offer.amountPerCharge) > maxPerCharge) return { ok: false, status: 402, error: `offer charges ${offer.amountPerCharge} per cycle, above the cap ${maxPerCharge}` };
    const terms: SubscriptionTerms = {
      kind: offer.kind,
      amountPerCharge: offer.amountPerCharge,
      interval: offer.interval,
      ...(req.maxCharges !== undefined || offer.maxCharges !== undefined ? { maxCharges: Math.min(req.maxCharges ?? Number.MAX_SAFE_INTEGER, offer.maxCharges ?? Number.MAX_SAFE_INTEGER) } : {}),
      ...(req.maxTotal ? { maxTotal: toBase(req.maxTotal, dec).toString() } : {}),
      expiresAt: req.expiresAt ?? new Date(Date.now() + 30 * 86_400_000).toISOString(),
      ...(offer.unit ? { unit: offer.unit } : {}),
      ...(offer.unitPrice ? { unitPrice: offer.unitPrice } : {}),
    };
    const token = randomBytes(32).toString("hex");
    const u = new URL(req.url);
    const id = randomId("sub");
    const sub: Subscription = {
      v: 1,
      id,
      principalId: cred.principalId,
      agentId: agentIdOf(cred),
      credentialId: credentialId(cred),
      payee: { url: req.url, host: u.host.toLowerCase(), address: q.payTo },
      resource: u.pathname + u.search,
      purpose: req.purpose,
      token: q.token,
      chain: q.chain,
      terms,
      chargeTokenHash: createHash("sha256").update(token).digest("hex"),
      chargeUrl: `${this.extras.publicUrl}/v1/subscriptions/${id}/charges`,
      status: "active",
      createdAt: nowIso(),
      charges: 0,
      totalCharged: "0",
    };
    // the first charge opens the subscription at the payee (policy, settlement, receipts as for any payment)
    const first = await this.payInner(cred, { url: req.url, maxAmount: req.maxAmountPerCharge, purpose: req.purpose, rail: "mpp" }, { subscription: { id, chargeUrl: sub.chargeUrl, token, terms } });
    if (!first.ok) return { ok: false, status: first.status, firstCharge: first, error: first.error ?? "first charge failed" };
    sub.charges = 1;
    sub.totalCharged = first.settlement!.amount;
    sub.lastChargedAt = nowIso();
    sub.payeeSubscriptionId = first.mppReceipt?.subscriptionId;
    this.store.putSubscription(sub);
    await this.receipts.append(cred.principalId, "subscription.created", { subscription: subscriptionPublic(sub), firstChargeTx: first.settlement!.txHash }, { agentId: sub.agentId, credentialId: sub.credentialId, intentId: first.intent.id, subscriptionId: id, rail: "mpp" });
    return { ok: true, status: 200, subscription: subscriptionPublic(sub), firstCharge: first };
  }

  /** A credential may see and manage its own subscriptions and those of its descendants (an ancestor governs its subtree). */
  private managesSubscription(cred: Credential, sub: Subscription): boolean {
    const callerId = credentialId(cred);
    const reg = this.store.getCredential(sub.credentialId);
    if (!reg) return false;
    return lineage({ rootId: reg.rootId, caveats: reg.caveats }).map(credentialId).includes(callerId);
  }

  async cancelSubscription(cred: Credential | { admin: true; principalId: string }, id: string): Promise<ReturnType<typeof subscriptionPublic>> {
    const sub = this.store.getSubscription(id);
    const allowed = !!sub && sub.principalId === cred.principalId && ("admin" in cred || this.managesSubscription(cred, sub));
    if (!sub || !allowed) throw Object.assign(new Error("subscription not found"), { statusCode: 404 });
    if (sub.status === "active") {
      sub.status = "cancelled";
      sub.cancelledAt = nowIso();
      this.store.putSubscription(sub);
      await this.receipts.append(cred.principalId, "subscription.cancelled", { subscription: subscriptionPublic(sub) }, { agentId: sub.agentId, credentialId: sub.credentialId, subscriptionId: id });
    }
    return subscriptionPublic(sub);
  }

  listSubscriptions(cred: Credential | { admin: true; principalId: string }) {
    const all = this.store.subscriptionsFor(cred.principalId);
    return ("admin" in cred ? all : all.filter((s) => this.managesSubscription(cred, s))).map(subscriptionPublic);
  }

  /** The payee charges a subscription. Policy runs on every charge; settlement is relayed on-chain by the gateway. */
  async charge(id: string, bearerToken: string | undefined, body: ChargeRequest): Promise<ChargeResult> {
    const sub = this.store.getSubscription(id);
    if (!sub) return { ok: false, status: 404, subscriptionId: id, subscriptionStatus: "cancelled", error: "subscription not found" };
    if (!bearerToken || createHash("sha256").update(bearerToken).digest("hex") !== sub.chargeTokenHash) return { ok: false, status: 401, subscriptionId: id, subscriptionStatus: sub.status, error: "invalid charge token" };
    const refuse = async (status: number, reason: string, extra: Record<string, unknown> = {}): Promise<ChargeResult> => {
      // Receipts for refusals are throttled to one per interval per subscription, with a count of the ones in
      // between, so a payee hammering the charge URL cannot grow the receipt chain without bound.
      const nowIsoStr = nowIso();
      const sinceLast = sub.lastRefusedAt ? Date.now() - new Date(sub.lastRefusedAt).getTime() : Infinity;
      sub.refusals = (sub.refusals ?? 0) + 1;
      if (sinceLast >= parseDuration(sub.terms.interval)) {
        await this.receipts.append(sub.principalId, "subscription.refused", { subscriptionId: id, reason, ...extra, status: sub.status, refusalsSinceLastReceipt: sub.refusals }, { agentId: sub.agentId, credentialId: sub.credentialId, subscriptionId: id, rail: "mpp" });
        sub.lastRefusedAt = nowIsoStr;
        sub.refusals = 0;
      }
      this.store.putSubscription(sub);
      this.extras.metrics?.denials.inc({ reason: `SUBSCRIPTION:${reason.split(" ")[0]}` });
      return { ok: false, status, subscriptionId: id, subscriptionStatus: sub.status, error: reason, ...(extra as Partial<ChargeResult>) };
    };
    const now = Date.now();
    if (sub.status !== "active") return refuse(410, `subscription is ${sub.status}`);
    if (new Date(sub.terms.expiresAt).getTime() < now) {
      sub.status = "expired";
      this.store.putSubscription(sub);
      return refuse(410, "subscription is expired");
    }
    if (sub.lastChargedAt) {
      const nextAllowed = new Date(sub.lastChargedAt).getTime() + parseDuration(sub.terms.interval);
      if (now < nextAllowed) return refuse(429, "too early", { nextAllowedAt: new Date(nextAllowed).toISOString() });
    }
    if (sub.terms.maxCharges !== undefined && sub.charges >= sub.terms.maxCharges) {
      sub.status = "exhausted";
      this.store.putSubscription(sub);
      return refuse(410, "subscription is exhausted");
    }
    // amount
    let amount: bigint;
    if (sub.terms.kind === "fixed") {
      if (body.amount !== undefined && body.amount !== sub.terms.amountPerCharge) return refuse(400, "fixed subscription: amount must equal amountPerCharge");
      amount = BigInt(sub.terms.amountPerCharge);
    } else {
      if (body.units !== undefined && sub.terms.unitPrice) amount = BigInt(body.units) * BigInt(sub.terms.unitPrice);
      else if (body.amount !== undefined) amount = BigInt(body.amount);
      else return refuse(400, "metered subscription: units or amount required");
      if (amount <= 0n) return refuse(400, "amount must be positive");
      if (amount > BigInt(sub.terms.amountPerCharge)) return refuse(403, "charge exceeds amountPerCharge", { amount: amount.toString() });
    }
    if (sub.terms.maxTotal !== undefined && BigInt(sub.totalCharged) + amount > BigInt(sub.terms.maxTotal)) return refuse(403, "charge exceeds maxTotal", { amount: amount.toString() });

    // policy on this charge, with the stored credential
    const reg = this.store.getCredential(sub.credentialId);
    if (!reg) return refuse(410, "credential no longer registered");
    const cred: Credential = { v: 1, rootId: reg.rootId, principalId: reg.principalId, caveats: reg.caveats, sig: "" };
    const intent: PaymentIntent = {
      v: 1,
      id: randomId("int"),
      principalId: sub.principalId,
      agentId: sub.agentId,
      credentialId: sub.credentialId,
      payee: { url: sub.payee.url, host: sub.payee.host, address: sub.payee.address },
      resource: sub.resource,
      maxAmount: mkAmount({ asset: this.cfg.asset.symbol, chain: sub.chain, token: sub.token as Address, base: amount, decimals: this.cfg.asset.decimals }),
      quotedAmount: mkAmount({ asset: this.cfg.asset.symbol, chain: sub.chain, token: sub.token as Address, base: amount, decimals: this.cfg.asset.decimals }),
      purpose: sub.purpose,
      rail: "mpp",
      createdAt: nowIso(),
    };
    const meta = { agentId: sub.agentId, credentialId: sub.credentialId, intentId: intent.id, intentHash: intentHash(intent), subscriptionId: id, rail: "mpp" as const };
    const decision = this.decide(intent, cred, amount, "mpp");
    const account = this.cfg.principals[sub.principalId]!.account;
    const auth = this.authorizationFor(intent, amount, sub.payee.address as Address);
    const onchain = await this.chain.simulate(account, auth, reg.sessionKey as Address);
    this.store.putIntent({ intent, amount: amount.toString(), effect: decision.effect, ts: nowIso() });
    await this.receipts.append(sub.principalId, "decision", { stage: "charge", effect: decision.effect, reasons: decision.reasons, checks: decision.checks, matchedRules: decision.matchedRules, amount, onchain, reference: body.reference ?? null, units: body.units ?? null }, { ...meta, policyHash: decision.policyHash });
    if (decision.effect !== "allow") {
      await this.receipts.append(sub.principalId, "payment.denied", { stage: "charge", effect: decision.effect, reasons: decision.reasons, amount }, { ...meta, policyHash: decision.policyHash });
      return refuse(403, `denied by policy: ${decision.reasons.join(", ")}`, { reasons: decision.reasons, amount: amount.toString() });
    }
    if (!onchain.ok) {
      await this.receipts.append(sub.principalId, "onchain.denied", { stage: "charge", reason: onchain.reason, amount }, meta);
      return refuse(403, `on-chain would reject: ${onchain.reason}`, { amount: amount.toString() });
    }
    const entry = this.store.reserve({
      id: randomId("led"),
      ts: nowIso(),
      principalId: sub.principalId,
      intentId: intent.id,
      agentId: sub.agentId,
      rootAgentId: rootAgentOf(cred),
      credentialIds: lineage(cred).map(credentialId),
      budgetIds: budgetPathFor(this.policies.active(sub.principalId), rootAgentOf(cred)),
      amount: amount.toString(),
    });
    const sig = await this.signer.signAuthorization(sub.credentialId, account, this.cfg.chainId, auth);
    const settled = await this.chain.payWithAuthorization(account, auth, sig);
    if (!settled.ok) {
      this.store.release(entry.id);
      await this.receipts.append(sub.principalId, "payment.denied", { stage: "settle", reason: settled.reason, amount }, meta);
      return refuse(502, `settlement failed: ${settled.reason}`, { amount: amount.toString() });
    }
    this.store.settle(entry.id, settled.txHash, nowIso());
    sub.charges += 1;
    sub.totalCharged = (BigInt(sub.totalCharged) + amount).toString();
    sub.lastChargedAt = nowIso();
    if (sub.terms.maxCharges !== undefined && sub.charges >= sub.terms.maxCharges) sub.status = "exhausted";
    this.store.putSubscription(sub);
    await this.receipts.append(
      sub.principalId,
      "payment.settled",
      { txHash: settled.txHash, blockNumber: settled.blockNumber.toString(), amount: amount.toString(), payee: sub.payee.address, payloadKind: "agent-account", account, token: sub.token, chain: sub.chain, resource: sub.resource, nonce: auth.nonce, budgets: entry.budgetIds, lineage: entry.credentialIds, ledgerEntryId: entry.id, subscriptionId: id, viaCharge: true, reference: body.reference ?? null, units: body.units ?? null },
      { ...meta, policyHash: decision.policyHash },
    );
    await this.receipts.append(sub.principalId, "subscription.charged", { subscriptionId: id, charges: sub.charges, totalCharged: sub.totalCharged, amount: amount.toString(), txHash: settled.txHash, status: sub.status }, meta);
    this.extras.metrics?.payment("mpp", "settled", "subscription", 0);
    return { ok: true, status: 200, subscriptionId: id, subscriptionStatus: sub.status, amount: amount.toString(), txHash: settled.txHash, charges: sub.charges, totalCharged: sub.totalCharged };
  }

  // ───────────────────────────── maintenance ─────────────────────────────

  /**
   * Reclaim the on-chain charge of every pending standard-x402 pre-approval whose authorization window has
   * passed without the token using it (a facilitator that never settled). Safe to run on a schedule.
   */
  async reclaimExpiredPreApprovals(principalId?: string): Promise<Array<{ digest: string; ok: boolean; txHash?: Hex; reason?: string; value: string }>> {
    const now = await this.chain.now(); // chain time: a dev chain under load runs ahead of the wall clock
    const out: Array<{ digest: string; ok: boolean; txHash?: Hex; reason?: string; value: string }> = [];
    for (const p of this.store.pendingPreApprovals(principalId)) {
      if (BigInt(p.validBefore) >= now) continue;
      const r = await this.chain.reclaimApproval(p.account as Address, p.digest as Hex);
      if (r.ok) {
        this.store.putPreApproval({ ...p, state: "reclaimed", reclaimTxHash: r.txHash });
        await this.receipts.append(p.principalId, "preapproval.reclaimed", { digest: p.digest, value: p.value, approvalTxHash: p.approvalTxHash, reclaimTxHash: r.txHash, validBefore: p.validBefore }, { credentialId: p.credentialId, intentId: p.intentId, rail: "x402" });
      } else if (/ApprovalAlreadyUsed/.test(r.reason)) {
        // settled after all (confirmation we never saw): close the record without a receipt of our own
        this.store.putPreApproval({ ...p, state: "settled" });
      }
      out.push({ digest: p.digest, ok: r.ok, ...(r.ok ? { txHash: r.txHash } : { reason: r.reason }), value: p.value });
    }
    return out;
  }

  // ───────────────────────────── quotes ─────────────────────────────

  private parseQuote(res: Response, want: Rail | "auto"): Quote | { error: string } {
    const x = decodeX402(X402RequiredSchema, res.headers.get(X402_HEADERS.required) ?? undefined);
    const wwwAuth = res.headers.get(MPP_HEADERS.challenge) ?? undefined;
    const m = decodeMppChallengeHeader(wwwAuth);
    const l = decodeL402ChallengeHeader(wwwAuth);
    const net = `eip155:${this.cfg.chainId}`;
    const fromX402 = (): Quote | { error: string } => {
      const a = x?.accepts.find((a) => a.network === net && a.scheme === "exact");
      if (!a) return { error: "x402: no acceptable scheme/network" };
      if (a.asset.toLowerCase() !== this.cfg.contracts.usdc.toLowerCase()) return { error: "x402: asset is not the configured stablecoin" };
      return { rail: "x402", amount: BigInt(a.amount), token: a.asset as Address, chain: a.network, payTo: a.payTo as Address, timeoutSeconds: a.maxTimeoutSeconds, x402: { network: a.network, accept: a } };
    };
    const fromMpp = (): Quote | { error: string } => {
      const meth = m?.methods.find((mm) => mm.chain === net && mm.method === "evm-agent-account");
      if (!m || !meth) return { error: "mpp: no acceptable method/chain" };
      if (meth.token.toLowerCase() !== this.cfg.contracts.usdc.toLowerCase()) return { error: "mpp: token is not the configured stablecoin" };
      return { rail: "mpp", amount: BigInt(meth.amount), token: meth.token as Address, chain: meth.chain, payTo: meth.payTo as Address, timeoutSeconds: Math.max(1, Math.floor((new Date(m.expiresAt).getTime() - Date.now()) / 1000)), mpp: { challengeId: m.id, subscriptionOffer: meth.subscription } };
    };
    const fromL402 = (): Quote | { error: string } => {
      if (!l) return { error: "payee does not offer L402" };
      if (!this.cfg.lightning) return { error: "l402: no Lightning backend configured on this gateway" };
      if (!this.cfg.fx?.satsPerUsdc) return { error: "l402: no sats-per-USDC rate configured" };
      let inv;
      try {
        inv = this.cfg.lightning.decodeInvoice(l.invoice);
      } catch (e) {
        return { error: `l402: ${(e as Error).message}` };
      }
      const unit = 10n ** BigInt(this.cfg.asset.decimals);
      const rate = BigInt(Math.round(this.cfg.fx.satsPerUsdc));
      const reference = (inv.amountSats * unit + rate - 1n) / rate; // ceil
      return { rail: "l402", amount: reference, token: this.cfg.contracts.usdc, chain: "lightning", payTo: ZERO, timeoutSeconds: 120, l402: { macaroon: l.macaroon, invoice: l.invoice, paymentHash: inv.paymentHash, amountSats: inv.amountSats, satsPerUsdc: this.cfg.fx.satsPerUsdc } };
    };
    if (want === "x402") return x ? fromX402() : { error: "payee does not offer x402" };
    if (want === "mpp") return m ? fromMpp() : { error: "payee does not offer MPP" };
    if (want === "l402") return fromL402();
    if (x) return fromX402();
    if (m) return fromMpp();
    if (l) return fromL402();
    return { error: "402 without a recognised payment challenge" };
  }

  private settlementTx(res: Response, rail: Rail): Hex | null {
    if (rail === "x402") {
      const pr = decodeX402(X402ResponseSchema, res.headers.get(X402_HEADERS.response) ?? undefined);
      return pr?.success && pr.transaction ? (pr.transaction as Hex) : null;
    }
    const r = decodeMppReceipt(res.headers.get(MPP_HEADERS.receipt) ?? undefined);
    return r ? (r.txHash as Hex) : null;
  }
}

async function readBody(res: Response): Promise<unknown> {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
