import { keccak256, toHex, type Address, type Hex } from "viem";
import {
  evaluate,
  parsePolicyYaml,
  policyHash,
  credentialId,
  agentIdOf,
  lineage,
  budgetPathFor,
  rootAgentOf,
  intentHash,
  randomId,
  nowIso,
  amount as mkAmount,
  toWireAuthorization,
  X402_HEADERS,
  MPP_HEADERS,
  X402RequiredSchema,
  X402ResponseSchema,
  decodeX402,
  encodeX402,
  decodeMppChallengeHeader,
  encodeMppCredentialHeader,
  decodeMppReceipt,
  type Credential,
  type PaymentIntent,
  type Policy,
  type Decision,
  type Rail,
  type Receipt,
  type PaymentAuthorizationStruct,
  type AuthorizationPayload,
} from "@apgw/core";
import type { GatewayConfig } from "./config.js";
import type { Store } from "./store.js";
import type { Signer } from "./signer.js";
import type { ChainClient } from "./chain.js";
import type { ReceiptLog } from "./receipts.js";

export interface PayRequest {
  url: string;
  method?: "GET" | "POST";
  body?: unknown;
  maxAmount: string; // human units, e.g. "0.05"
  purpose: string;
  rail?: Rail | "auto";
}

export interface PayResult {
  ok: boolean;
  status: number;
  rail?: Rail;
  intent: PaymentIntent;
  decision?: Decision;
  onchain?: { ok: boolean; reason: string | null };
  settlement?: { txHash: Hex; blockNumber: string; amount: string; payee: Address };
  receipts: Receipt[];
  body?: unknown;
  error?: string;
}

interface Quote {
  rail: Rail;
  amount: bigint;
  token: Address;
  chain: string;
  payTo: Address;
  timeoutSeconds: number;
  x402?: { network: string; accept: unknown };
  mpp?: { challengeId: string };
}

/**
 * The pay-side flow, rail-agnostic:
 *   intent -> pre-check (maxAmount) -> fetch -> 402 quote -> binding decision (quoted amount)
 *   -> on-chain simulate -> reserve -> sign authorization -> retry with rail headers -> confirm on-chain -> commit
 * Every arrow produces a receipt.
 */
export class PaymentService {
  readonly policy: Policy;

  constructor(
    private readonly cfg: GatewayConfig,
    private readonly store: Store,
    private readonly signer: Signer,
    private readonly chain: ChainClient,
    private readonly receipts: ReceiptLog,
  ) {
    this.policy = parsePolicyYaml(cfg.policyYaml);
  }

  buildIntent(cred: Credential, req: PayRequest): PaymentIntent {
    const u = new URL(req.url);
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

  private decide(intent: PaymentIntent, cred: Credential, amountBase: bigint, rail: Rail | "auto"): Decision {
    return evaluate({
      policy: this.policy,
      intent,
      credential: cred,
      amountBase,
      rail,
      ledger: this.store.ledgerView(),
      killSwitch: this.store.killSwitch(cred.principalId),
    });
  }

  /**
   * Simulation: fetch the payee's 402 quote (free, nothing is signed), decide on the real quoted price and
   * payee address, and ask the account contract for its own dry-run. Records a receipt. Nothing is paid.
   */
  async simulate(cred: Credential, req: PayRequest): Promise<PayResult> {
    const intent = this.buildIntent(cred, req);
    let amountBase = BigInt(intent.maxAmount.value);
    let to: Address = this.cfg.contracts.usdc; // placeholder when the payee is free or unreachable
    let rail: Rail | "auto" = intent.rail;
    let quoteInfo: Record<string, unknown> = { quoted: false };
    try {
      const first = await fetch(req.url, { method: req.method ?? "GET", headers: { accept: "application/json" } });
      if (first.status === 402) {
        const q = this.parseQuote(first, intent.rail);
        if (!("error" in q)) {
          amountBase = q.amount;
          to = q.payTo;
          rail = q.rail;
          intent.quotedAmount = mkAmount({ asset: this.cfg.asset.symbol, chain: q.chain, token: q.token, base: q.amount, decimals: this.cfg.asset.decimals });
          intent.payee.address = q.payTo;
          intent.rail = q.rail;
          quoteInfo = { quoted: true, amount: q.amount, payTo: q.payTo, rail: q.rail, exceedsMax: q.amount > BigInt(intent.maxAmount.value) };
        } else quoteInfo = { quoted: false, error: q.error };
      } else quoteInfo = { quoted: false, status: first.status, note: "resource is not paywalled" };
    } catch (err) {
      quoteInfo = { quoted: false, error: `payee unreachable: ${String(err)}` };
    }
    const decision = this.decide(intent, cred, amountBase, rail);
    const onchain = await this.simulateOnChain(cred, intent, amountBase, to);
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

  async pay(cred: Credential, req: PayRequest): Promise<PayResult> {
    const receipts: Receipt[] = [];
    const intent = this.buildIntent(cred, req);
    const meta = { agentId: intent.agentId, credentialId: intent.credentialId, intentId: intent.id };
    const reg = this.store.getCredential(intent.credentialId);
    if (!reg) {
      const r = await this.receipts.append(cred.principalId, "payment.denied", { reason: "credential not registered" }, meta);
      return { ok: false, status: 403, intent, receipts: [r], error: "credential not registered" };
    }

    // 1. pre-check on the agent's ceiling
    const pre = this.decide(intent, cred, BigInt(intent.maxAmount.value), intent.rail);
    receipts.push(await this.receipts.append(cred.principalId, "decision", { stage: "precheck", effect: pre.effect, reasons: pre.reasons, checks: pre.checks, matchedRules: pre.matchedRules, amount: intent.maxAmount.value }, { ...meta, policyHash: pre.policyHash }));
    if (pre.effect !== "allow") {
      receipts.push(await this.receipts.append(cred.principalId, "payment.denied", { stage: "precheck", effect: pre.effect, reasons: pre.reasons }, { ...meta, policyHash: pre.policyHash }));
      return { ok: false, status: 403, intent, decision: pre, receipts, error: `denied: ${pre.reasons.join(", ")}` };
    }

    // 2. first request, unpaid
    const init: RequestInit = { method: req.method ?? "GET", headers: { accept: "application/json" } };
    if (req.body !== undefined) {
      init.body = JSON.stringify(req.body);
      (init.headers as Record<string, string>)["content-type"] = "application/json";
    }
    const first = await fetch(req.url, init);
    if (first.status !== 402) {
      const body = await readBody(first);
      return { ok: first.ok, status: first.status, intent, decision: pre, receipts, body };
    }

    // 3. parse the quote(s)
    const quote = this.parseQuote(first, intent.rail);
    if ("error" in quote) {
      receipts.push(await this.receipts.append(cred.principalId, "payment.denied", { stage: "quote", reason: quote.error }, meta));
      return { ok: false, status: 502, intent, decision: pre, receipts, error: quote.error };
    }
    intent.quotedAmount = mkAmount({ asset: this.cfg.asset.symbol, chain: quote.chain, token: quote.token, base: quote.amount, decimals: this.cfg.asset.decimals });
    intent.payee.address = quote.payTo;
    intent.rail = quote.rail;
    const ih = intentHash(intent);
    const metaQ = { ...meta, intentHash: ih, rail: quote.rail };

    if (quote.amount > BigInt(intent.maxAmount.value)) {
      receipts.push(await this.receipts.append(cred.principalId, "payment.denied", { stage: "quote", reason: "quoted price exceeds agent ceiling", quoted: quote.amount, max: intent.maxAmount.value }, metaQ));
      return { ok: false, status: 402, intent, decision: pre, receipts, error: "quoted price exceeds maxAmount" };
    }

    // 4. binding decision on the quoted price
    const decision = this.decide(intent, cred, quote.amount, quote.rail);
    const onchain = await this.simulateOnChain(cred, intent, quote.amount, quote.payTo);
    receipts.push(await this.receipts.append(cred.principalId, "decision", { stage: "quote", effect: decision.effect, reasons: decision.reasons, checks: decision.checks, matchedRules: decision.matchedRules, amount: quote.amount, onchain, quote: { payTo: quote.payTo, token: quote.token, chain: quote.chain } }, { ...metaQ, policyHash: decision.policyHash }));
    if (decision.effect !== "allow") {
      receipts.push(await this.receipts.append(cred.principalId, "payment.denied", { stage: "quote", effect: decision.effect, reasons: decision.reasons, amount: quote.amount, onchain }, { ...metaQ, policyHash: decision.policyHash }));
      return { ok: false, status: 403, intent, decision, onchain, receipts, error: `denied: ${decision.reasons.join(", ")}` };
    }
    if (!onchain.ok) {
      // policy said yes but the chain would say no: fail closed and record the disagreement
      receipts.push(await this.receipts.append(cred.principalId, "onchain.denied", { stage: "quote", reason: onchain.reason, amount: quote.amount }, metaQ));
      return { ok: false, status: 403, intent, decision, onchain, receipts, error: `on-chain would reject: ${onchain.reason}` };
    }

    // 5. reserve, sign, retry with payment
    const lineageIds = lineage(cred).map(credentialId);
    const budgetIds = budgetPathFor(this.policy, rootAgentOf(cred));
    this.store.reserve(lineageIds, budgetIds, quote.amount);
    const account = this.cfg.principals[cred.principalId]!.account;
    const auth = this.authorizationFor(intent, quote.amount, quote.payTo);
    const signature = await this.signer.signAuthorization(intent.credentialId, account, this.cfg.chainId, auth);
    const payload: AuthorizationPayload = { kind: "agent-account", account, authorization: toWireAuthorization(auth), signature };

    const headers: Record<string, string> = { accept: "application/json" };
    if (quote.rail === "x402") headers[X402_HEADERS.signature] = encodeX402({ x402Version: 2, scheme: "exact", network: quote.x402!.network, payload });
    else headers[MPP_HEADERS.credential] = encodeMppCredentialHeader({ challengeId: quote.mpp!.challengeId, method: "evm-agent-account", payload });
    if (req.body !== undefined) headers["content-type"] = "application/json";

    let second: Response;
    try {
      second = await fetch(req.url, { method: req.method ?? "GET", headers, body: req.body !== undefined ? JSON.stringify(req.body) : undefined });
    } catch (err) {
      this.store.release(lineageIds, budgetIds, quote.amount);
      receipts.push(await this.receipts.append(cred.principalId, "payment.denied", { stage: "settle", reason: `payee unreachable: ${String(err)}` }, metaQ));
      return { ok: false, status: 502, intent, decision, receipts, error: "payee unreachable" };
    }

    // 6. confirm settlement on-chain: never trust the payee's word
    const txHash = this.settlementTx(second, quote.rail);
    const body = await readBody(second);
    if (!second.ok || !txHash) {
      this.store.release(lineageIds, budgetIds, quote.amount);
      receipts.push(await this.receipts.append(cred.principalId, "payment.denied", { stage: "settle", reason: `payee rejected payment (status ${second.status})`, body }, metaQ));
      return { ok: false, status: second.status, intent, decision, receipts, error: "payee rejected payment", body };
    }
    const confirm = await this.chain.confirmPayment(txHash, account, ih, quote.amount, quote.payTo);
    if (!confirm.ok) {
      this.store.release(lineageIds, budgetIds, quote.amount);
      receipts.push(await this.receipts.append(cred.principalId, "payment.denied", { stage: "confirm", reason: confirm.reason, txHash }, metaQ));
      return { ok: false, status: 502, intent, decision, receipts, error: `settlement not confirmed: ${confirm.reason}` };
    }
    this.store.commit(lineageIds, budgetIds, quote.amount);
    const settlement = { txHash, blockNumber: confirm.blockNumber!.toString(), amount: quote.amount.toString(), payee: quote.payTo };
    receipts.push(
      await this.receipts.append(
        cred.principalId,
        "payment.settled",
        { ...settlement, account, token: quote.token, chain: quote.chain, resource: intent.resource, nonce: auth.nonce, budgets: budgetIds, lineage: lineageIds },
        { ...metaQ, policyHash: decision.policyHash },
      ),
    );
    return { ok: true, status: 200, rail: quote.rail, intent, decision, onchain, settlement, receipts, body };
  }

  private parseQuote(res: Response, want: Rail | "auto"): Quote | { error: string } {
    const x = decodeX402(X402RequiredSchema, res.headers.get(X402_HEADERS.required) ?? undefined);
    const m = decodeMppChallengeHeader(res.headers.get(MPP_HEADERS.challenge) ?? undefined);
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
      return { rail: "mpp", amount: BigInt(meth.amount), token: meth.token as Address, chain: meth.chain, payTo: meth.payTo as Address, timeoutSeconds: Math.max(1, Math.floor((new Date(m.expiresAt).getTime() - Date.now()) / 1000)), mpp: { challengeId: m.id } };
    };
    if (want === "x402") return x ? fromX402() : { error: "payee does not offer x402" };
    if (want === "mpp") return m ? fromMpp() : { error: "payee does not offer MPP" };
    if (x) return fromX402();
    if (m) return fromMpp();
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

  get policyHashHex(): Hex {
    return policyHash(this.policy);
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
