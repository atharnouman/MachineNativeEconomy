import {
  attenuate,
  decodeCredential,
  encodeCredential,
  randomId,
  approvalMessage,
  ed25519Generate,
  ed25519FromJwk,
  signAsHolder,
  effectiveLimits,
  type Credential,
  type Caveat,
  type Receipt,
  type EvidenceBundle,
  type Rail,
  type Approval,
  type ApprovalVerdict,
  type PolicyVersion,
  type Ed25519Jwk,
  type Subscription,
} from "@spendmarshal/core";

export type { Credential, Caveat, Receipt, EvidenceBundle, Rail, Approval, ApprovalVerdict, Ed25519Jwk, Subscription };

export interface PayRequest {
  url: string;
  method?: "GET" | "POST";
  body?: unknown;
  /** Human units, e.g. "0.05". A ceiling, not a price: the gateway pays the quoted price if policy allows it. */
  maxAmount: string;
  purpose: string;
  rail?: Rail | "auto";
  /** Resume an escalated intent under a granted approval (or use `resume()`). */
  approvalId?: string;
  /** x402 payload shape: `standard` works with any facilitator via an on-chain pre-approval (ERC-1271). */
  x402Mode?: "agent-account" | "standard";
}

export interface PayResponse {
  ok: boolean;
  status: number;
  rail?: Rail;
  payloadKind?: "agent-account" | "standard";
  intent: { id: string; agentId: string; credentialId: string; resource: string; payee: { host: string; address?: string } };
  decision?: {
    effect: "allow" | "deny" | "escalate";
    reasons: string[];
    matchedRules: string[];
    policyHash: string;
    approvalId?: string;
    checks?: Array<{ check: string; ok: boolean; detail?: string }>;
    budgetPath?: string[];
  };
  onchain?: { ok: boolean; reason: string | null };
  settlement?: {
    txHash: string;
    blockNumber: string;
    amount: string;
    payee: string;
    approvalTxHash?: string;
    /** L402: proof of payment and native amount */
    lightning?: { preimage: string; paymentHash: string; amountSats: string; satsPerUsdc: number; delivered: boolean };
  };
  /** Present when status is 202: a human must approve before the payment can proceed. */
  pending?: { approvalId: string; expiresAt: string; reasons: string[] };
  receipts: Receipt[];
  body?: unknown;
  error?: string;
}

export type ApprovalPublic = Omit<Approval, "request">;

export interface SubscribeRequest {
  url: string;
  purpose: string;
  /** Human units: the most the payee may charge per cycle. The payee's offer must fit inside. */
  maxAmountPerCharge: string;
  maxCharges?: number;
  /** Human units, lifetime cap. */
  maxTotal?: string;
  expiresAt?: string;
}

export type SubscriptionPublic = Omit<Subscription, "chargeTokenHash">;

export interface SubscribeResponse {
  ok: boolean;
  status: number;
  subscription?: SubscriptionPublic;
  firstCharge?: PayResponse;
  error?: string;
}

export class SpendMarshalError extends Error {
  constructor(message: string, readonly status: number, readonly response?: unknown) {
    super(message);
  }
}

export interface ClientOptions {
  /**
   * Private Ed25519 JWK for a holder-bound credential. Every request is then signed (RFC 9421) so the bearer
   * credential alone cannot be used by anyone who steals it.
   */
  holderKey?: Ed25519Jwk;
  fetch?: typeof fetch;
}

/** Generate a holder key pair. Keep `d` secret; `publicJwk` goes into the credential. */
export function generateHolderKey(): { privateJwk: Ed25519Jwk; publicJwk: Ed25519Jwk; keyid: string } {
  const k = ed25519Generate();
  return { privateJwk: k.jwk, publicJwk: k.publicJwk, keyid: k.keyid };
}

/**
 * Agent-side client. Holds one credential. `pay()` is the whole integration: the gateway handles the 402
 * dance on whichever rail the payee offers, enforces policy, settles, confirms on-chain and returns the
 * resource body plus receipts. A 202 means a human has to approve; `waitForApproval()` then `resume()`.
 */
export class SpendMarshalClient {
  readonly credential: Credential;
  private readonly holder?: ReturnType<typeof ed25519FromJwk>;
  private readonly fetchImpl: typeof fetch;

  constructor(readonly baseUrl: string, credential: Credential | string, opts: ClientOptions = {}) {
    this.credential = typeof credential === "string" ? decodeCredential(credential) : credential;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    if (opts.holderKey) this.holder = ed25519FromJwk(opts.holderKey);
    // a holder-bound credential without its key is still a valid object (e.g. for inspection); requests get 401
  }

  get credentialToken(): string {
    return encodeCredential(this.credential);
  }

  /** True if this credential requires a holder signature. */
  get holderBound(): boolean {
    return effectiveLimits(this.credential.caveats).holderKey !== null;
  }

  private async call<T>(path: string, init: RequestInit = {}, okStatuses: number[] = [200]): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : undefined;
    let headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${this.credentialToken}`, ...((init.headers as Record<string, string>) ?? {}) };
    if (this.holder) headers = { ...headers, ...signAsHolder({ method, url, headers }, this.holder, body) };
    const r = await this.fetchImpl(url, { ...init, method, headers });
    const json = (await r.json()) as unknown;
    if (!okStatuses.includes(r.status)) throw new SpendMarshalError((json as { error?: string }).error ?? `HTTP ${r.status}`, r.status, json);
    return json as T;
  }

  private static readonly PAY_STATUSES = [200, 202, 402, 403, 409, 502];

  /** Pay for a resource. Resolves for denials and pending approvals too (ok=false) so agents can act on them. */
  pay(req: PayRequest): Promise<PayResponse> {
    return this.call<PayResponse>("/v1/intents", { method: "POST", body: JSON.stringify(req) }, SpendMarshalClient.PAY_STATUSES);
  }

  simulate(req: PayRequest): Promise<PayResponse> {
    return this.call<PayResponse>("/v1/intents/simulate", { method: "POST", body: JSON.stringify(req) });
  }

  /** Continue an escalated payment after approval. The gateway re-quotes and re-checks everything. */
  resume(approvalId: string): Promise<PayResponse> {
    return this.call<PayResponse>("/v1/intents/resume", { method: "POST", body: JSON.stringify({ approvalId }) }, SpendMarshalClient.PAY_STATUSES);
  }

  async approval(id: string): Promise<ApprovalPublic> {
    return (await this.call<{ approval: ApprovalPublic }>(`/v1/approvals/${encodeURIComponent(id)}`)).approval;
  }

  /** Poll until the approval leaves `pending` (or the timeout elapses). */
  async waitForApproval(id: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<ApprovalPublic> {
    const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
    for (;;) {
      const a = await this.approval(id);
      if (a.status !== "pending" || Date.now() >= deadline) return a;
      await new Promise((r) => setTimeout(r, opts.intervalMs ?? 1000));
    }
  }

  /**
   * Delegate a narrower credential to a sub-agent. Attenuation happens locally (no network, no root key) and
   * the result is registered so the chain enforces it too. With `bindTo: "new"` a fresh holder key is generated
   * and bound, so the sub-agent's credential is useless without that key; the returned client holds it.
   */
  async delegate(opts: { agentId: string; caveats: Caveat[]; bindTo?: "new" | Ed25519Jwk }): Promise<SpendMarshalClient> {
    let holderKey: Ed25519Jwk | undefined;
    let caveats = opts.caveats;
    if (opts.bindTo === "new") {
      const k = generateHolderKey();
      holderKey = k.privateJwk;
      // only the schema members go into the caveat: anything else (kid) would be stripped server-side and break the HMAC chain
      caveats = [...caveats, { type: "holder_key", jwk: { kty: "OKP", crv: "Ed25519", x: k.publicJwk.x } }];
    } else if (opts.bindTo) {
      caveats = [...caveats, { type: "holder_key", jwk: { kty: "OKP", crv: "Ed25519", x: opts.bindTo.x } }];
    }
    const child = attenuate(this.credential, caveats, { agentId: opts.agentId, nonce: randomId("n") });
    await this.call("/v1/credentials/register", { method: "POST", body: JSON.stringify({ credential: child }) });
    return new SpendMarshalClient(this.baseUrl, child, { holderKey: holderKey ?? (opts.bindTo ? undefined : this.holder?.jwk), fetch: this.fetchImpl });
  }

  /** Restrict this credential further without delegating (same agent, tighter limits). */
  async restrict(caveats: Caveat[]): Promise<SpendMarshalClient> {
    const c = attenuate(this.credential, caveats);
    await this.call("/v1/credentials/register", { method: "POST", body: JSON.stringify({ credential: c }) });
    return new SpendMarshalClient(this.baseUrl, c, { holderKey: this.holder?.jwk, fetch: this.fetchImpl });
  }

  async receipts(): Promise<Receipt[]> {
    return (await this.call<{ receipts: Receipt[] }>("/v1/receipts")).receipts;
  }

  whoami() {
    return this.call<{ credential: unknown; registered: unknown }>("/v1/credentials/me");
  }

  // ── subscriptions (MPP): the first charge pays now; the payee charges later within the terms ──
  subscribe(req: SubscribeRequest): Promise<SubscribeResponse> {
    return this.call<SubscribeResponse>("/v1/subscriptions", { method: "POST", body: JSON.stringify(req) }, [200, 402, 403, 409, 502]);
  }

  async subscriptions(): Promise<SubscriptionPublic[]> {
    return (await this.call<{ subscriptions: SubscriptionPublic[] }>("/v1/subscriptions")).subscriptions;
  }

  async cancelSubscription(id: string): Promise<SubscriptionPublic> {
    return (await this.call<{ subscription: SubscriptionPublic }>(`/v1/subscriptions/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" })).subscription;
  }
}

/** Something that can sign an EIP-191 message: a viem LocalAccount, a hardware wallet wrapper, a KMS client. */
export interface ApprovalSigner {
  address: string;
  signMessage(args: { message: string }): Promise<`0x${string}`>;
}

/** Operator-side client (admin token). */
export class SpendMarshalAdmin {
  constructor(readonly baseUrl: string, private readonly adminToken: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const r = await fetch(`${this.baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", "x-admin-token": this.adminToken, ...(init.headers ?? {}) } });
    const json = (await r.json()) as unknown;
    if (!r.ok) throw new SpendMarshalError((json as { error?: string }).error ?? `HTTP ${r.status}`, r.status, json);
    return json as T;
  }

  async issueCredential(args: { principalId: string; agentId: string; caveats: Exclude<Caveat, { type: "delegate" }>[]; holderKey?: Ed25519Jwk }): Promise<SpendMarshalClient> {
    const caveats = args.holderKey ? [...args.caveats, { type: "holder_key" as const, jwk: { kty: "OKP" as const, crv: "Ed25519" as const, x: args.holderKey.x } }] : args.caveats;
    const r = await this.call<{ credential: Credential }>("/v1/credentials", { method: "POST", body: JSON.stringify({ principalId: args.principalId, agentId: args.agentId, caveats }) });
    return new SpendMarshalClient(this.baseUrl, r.credential, { holderKey: args.holderKey?.d ? args.holderKey : undefined });
  }

  // approvals
  async listApprovals(principalId: string, status?: Approval["status"]): Promise<ApprovalPublic[]> {
    const q = new URLSearchParams({ principalId, ...(status ? { status } : {}) });
    return (await this.call<{ approvals: ApprovalPublic[] }>(`/v1/approvals?${q}`)).approvals;
  }

  /**
   * Resolve an approval. With a `signer`, the resolution is signed (EIP-191 over the canonical approval
   * message) so it verifies offline against the approver's registered address.
   */
  async resolveApproval(
    id: string,
    verdict: ApprovalVerdict,
    approverId: string,
    opts: { signer?: ApprovalSigner; note?: string; principalId?: string; approval?: Pick<Approval, "id" | "principalId" | "intentHash" | "amount"> } = {},
  ): Promise<ApprovalPublic> {
    let signature: `0x${string}` | undefined;
    if (opts.signer) {
      const a = opts.approval ?? (opts.principalId ? await this.getApproval(opts.principalId, id) : undefined);
      if (!a) throw new SpendMarshalError("signing an approval needs opts.approval or opts.principalId", 400);
      signature = await opts.signer.signMessage({ message: approvalMessage(a, verdict) });
    }
    return (await this.call<{ approval: ApprovalPublic }>(`/v1/approvals/${encodeURIComponent(id)}/${verdict}`, { method: "POST", body: JSON.stringify({ approverId, signature, note: opts.note }) })).approval;
  }

  async getApproval(principalId: string, id: string): Promise<ApprovalPublic> {
    const hit = (await this.listApprovals(principalId)).find((a) => a.id === id);
    if (hit) return hit;
    throw new SpendMarshalError(`approval ${id} not found for ${principalId}`, 404);
  }

  // policies
  getPolicy(principalId: string) {
    return this.call<{ active: PolicyVersion; versions: Omit<PolicyVersion, "document">[] }>(`/v1/policies/${encodeURIComponent(principalId)}`);
  }

  updatePolicy(principalId: string, yaml: string, by: string) {
    return this.call<{ version: Omit<PolicyVersion, "document">; diff: Record<string, string[]>; impact: Array<{ intentId: string; resource: string; amount: string; wasEffect: string; nowEffect: string; reasons: string[] }> }>(
      `/v1/policies/${encodeURIComponent(principalId)}`,
      { method: "PUT", body: JSON.stringify({ yaml, by }) },
    );
  }

  // evidence & controls
  exportEvidence(principalId: string): Promise<EvidenceBundle> {
    return this.call<EvidenceBundle>(`/v1/evidence/${encodeURIComponent(principalId)}`);
  }

  anchor(principalId: string) {
    return this.call<{ head: string; count: number; txHash: string; blockNumber: string }>("/v1/evidence/anchor", { method: "POST", body: JSON.stringify({ principalId }) });
  }

  killSwitch(principalId: string, on: boolean, reason?: string) {
    return this.call<{ on: boolean; txHash: string | null; onchain: string; receipt: Receipt }>("/v1/killswitch", { method: "POST", body: JSON.stringify({ principalId, on, reason }) });
  }

  /** Reclaim on-chain charges of expired, unused standard-x402 pre-approvals. Idempotent; run on a schedule. */
  reclaim(principalId?: string) {
    return this.call<{ reclaimed: number; pending: number; results: Array<{ digest: string; ok: boolean; txHash?: string; reason?: string; value: string }> }>("/v1/maintenance/reclaim", { method: "POST", body: JSON.stringify({ principalId }) });
  }

  /** Every subscription of a principal (the agent-side list is scoped to the caller's lineage). */
  async listSubscriptions(principalId: string): Promise<SubscriptionPublic[]> {
    return (await this.call<{ subscriptions: SubscriptionPublic[] }>(`/v1/subscriptions?principalId=${encodeURIComponent(principalId)}`)).subscriptions;
  }

  async cancelSubscription(principalId: string, id: string): Promise<SubscriptionPublic> {
    return (await this.call<{ subscription: SubscriptionPublic }>(`/v1/subscriptions/${encodeURIComponent(id)}/cancel`, { method: "POST", body: JSON.stringify({ principalId }) })).subscription;
  }

  attachExternal(args: { principalId: string; source: string; data: Record<string, unknown>; credentialId?: string; intentId?: string }) {
    return this.call<{ receipt: Receipt }>("/v1/receipts/external", { method: "POST", body: JSON.stringify(args) });
  }

  health() {
    return this.call<{ ok: boolean; gateway: string; chainId: number; policies: Record<string, { version: number; hash: string }>; agentKeyId?: string }>("/healthz");
  }

  async metrics(): Promise<string> {
    const r = await fetch(`${this.baseUrl}/metrics`, { headers: { "x-admin-token": this.adminToken } });
    return r.text();
  }

  async openapi(): Promise<Record<string, unknown>> {
    const r = await fetch(`${this.baseUrl}/openapi.json`);
    return (await r.json()) as Record<string, unknown>;
  }
}

// ───────────────────────────── framework-neutral tools ─────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments: usable with OpenAI function calling, Vercel AI `jsonSchema()`, LangChain, MCP. */
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

const payParams = {
  type: "object",
  properties: {
    url: { type: "string", description: "Resource URL to buy" },
    maxAmount: { type: "string", description: "Ceiling in USDC, e.g. '0.05'" },
    purpose: { type: "string", description: "Why: must match a purpose the policy allows" },
    rail: { type: "string", enum: ["auto", "x402", "mpp"], description: "Payment rail; 'auto' picks what the payee offers" },
  },
  required: ["url", "maxAmount", "purpose"],
} as const;

/** Give an agent framework the gateway as tools. The model never sees keys or signs anything. */
export function spendmarshalTools(client: SpendMarshalClient): ToolDefinition[] {
  return [
    {
      name: "spendmarshal_pay",
      description: "Pay for an HTTP resource through the Agentic Payment Gateway under the agent's spending policy. Returns the resource body, the policy decision and signed receipts. If denied, returns the reasons; do not retry with a higher amount. If status is 202, a human must approve: report the approvalId and use spendmarshal_resume once approved.",
      parameters: payParams,
      execute: (a) => client.pay(a as unknown as PayRequest),
    },
    {
      name: "spendmarshal_simulate",
      description: "Dry-run a payment: returns whether policy and the on-chain account would allow it, without paying.",
      parameters: payParams,
      execute: (a) => client.simulate(a as unknown as PayRequest),
    },
    {
      name: "spendmarshal_resume",
      description: "Continue a payment that was waiting for human approval. Returns the resource if the approval was granted.",
      parameters: { type: "object", properties: { approvalId: { type: "string" } }, required: ["approvalId"] },
      execute: (a) => client.resume(String(a.approvalId)),
    },
    {
      name: "spendmarshal_approval",
      description: "Check the status of a pending approval.",
      parameters: { type: "object", properties: { approvalId: { type: "string" } }, required: ["approvalId"] },
      execute: (a) => client.approval(String(a.approvalId)),
    },
    {
      name: "spendmarshal_subscribe",
      description: "Open a subscription to a resource the payee offers on a cadence (fixed amount per cycle, or metered usage). The first cycle is paid now; later charges are initiated by the payee and still go through the agent's policy. Returns the subscription and its terms.",
      parameters: { type: "object", properties: { url: { type: "string" }, purpose: { type: "string" }, maxAmountPerCharge: { type: "string", description: "Most the payee may charge per cycle, in USDC" }, maxCharges: { type: "integer" }, maxTotal: { type: "string" } }, required: ["url", "purpose", "maxAmountPerCharge"] },
      execute: (a) => client.subscribe(a as unknown as SubscribeRequest),
    },
    {
      name: "spendmarshal_cancel_subscription",
      description: "Cancel a subscription; the payee can no longer charge it.",
      parameters: { type: "object", properties: { subscriptionId: { type: "string" } }, required: ["subscriptionId"] },
      execute: (a) => client.cancelSubscription(String(a.subscriptionId)),
    },
    {
      name: "spendmarshal_receipts",
      description: "List the signed receipts (decisions, settlements, denials, approvals) for this agent's principal.",
      parameters: { type: "object", properties: {} },
      execute: () => client.receipts(),
    },
  ];
}

export { encodeCredential, decodeCredential, approvalMessage };
