import {
  attenuate,
  decodeCredential,
  encodeCredential,
  randomId,
  type Credential,
  type Caveat,
  type Receipt,
  type EvidenceBundle,
  type Rail,
} from "@apgw/core";

export type { Credential, Caveat, Receipt, EvidenceBundle, Rail };

export interface PayRequest {
  url: string;
  method?: "GET" | "POST";
  body?: unknown;
  /** Human units, e.g. "0.05". The gateway never pays more than this, and never more than policy allows. */
  maxAmount: string;
  purpose: string;
  rail?: Rail | "auto";
}

export interface PayResponse {
  ok: boolean;
  status: number;
  rail?: Rail;
  intent: { id: string; agentId: string; credentialId: string; resource: string; payee: { host: string; address?: string } };
  decision?: { effect: "allow" | "deny" | "escalate"; reasons: string[]; matchedRules: string[] };
  onchain?: { ok: boolean; reason: string | null };
  settlement?: { txHash: string; blockNumber: string; amount: string; payee: string };
  receipts: Receipt[];
  body?: unknown;
  error?: string;
}

export class ApgwError extends Error {
  constructor(message: string, readonly status: number, readonly response?: unknown) {
    super(message);
  }
}

/**
 * Agent-side client. Holds one credential. `pay()` is the whole integration: the gateway handles the 402
 * dance on whichever rail the payee offers, enforces policy, settles, confirms on-chain and returns the
 * resource body plus receipts.
 */
export class ApgwClient {
  readonly credential: Credential;

  constructor(readonly baseUrl: string, credential: Credential | string) {
    this.credential = typeof credential === "string" ? decodeCredential(credential) : credential;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  get credentialToken(): string {
    return encodeCredential(this.credential);
  }

  private async call<T>(path: string, init: RequestInit = {}, okStatuses: number[] = [200]): Promise<T> {
    const r = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.credentialToken}`, ...(init.headers ?? {}) },
    });
    const json = (await r.json()) as unknown;
    if (!okStatuses.includes(r.status)) throw new ApgwError((json as { error?: string }).error ?? `HTTP ${r.status}`, r.status, json);
    return json as T;
  }

  /** Pay for a resource. Resolves for denials too (ok=false) so agents can read the reasons; throws only on transport/auth errors. */
  pay(req: PayRequest): Promise<PayResponse> {
    return this.call<PayResponse>("/v1/intents", { method: "POST", body: JSON.stringify(req) }, [200, 402, 403, 502]);
  }

  simulate(req: PayRequest): Promise<PayResponse> {
    return this.call<PayResponse>("/v1/intents/simulate", { method: "POST", body: JSON.stringify(req) });
  }

  /**
   * Delegate a narrower credential to a sub-agent. Attenuation happens locally (no network, no root key) and
   * the result is registered so the chain enforces it too. Returns a client for the sub-agent.
   */
  async delegate(opts: { agentId: string; caveats: Caveat[] }): Promise<ApgwClient> {
    const child = attenuate(this.credential, opts.caveats, { agentId: opts.agentId, nonce: randomId("n") });
    await this.call("/v1/credentials/register", { method: "POST", body: JSON.stringify({ credential: child }) });
    return new ApgwClient(this.baseUrl, child);
  }

  /** Restrict this credential further without delegating (same agent, tighter limits). */
  async restrict(caveats: Caveat[]): Promise<ApgwClient> {
    const c = attenuate(this.credential, caveats);
    await this.call("/v1/credentials/register", { method: "POST", body: JSON.stringify({ credential: c }) });
    return new ApgwClient(this.baseUrl, c);
  }

  async receipts(): Promise<Receipt[]> {
    return (await this.call<{ receipts: Receipt[] }>("/v1/receipts")).receipts;
  }

  whoami() {
    return this.call<{ credential: unknown; registered: unknown }>("/v1/credentials/me");
  }
}

/** Operator-side client (admin token). */
export class ApgwAdmin {
  constructor(readonly baseUrl: string, private readonly adminToken: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const r = await fetch(`${this.baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", "x-admin-token": this.adminToken, ...(init.headers ?? {}) } });
    const json = (await r.json()) as unknown;
    if (!r.ok) throw new ApgwError((json as { error?: string }).error ?? `HTTP ${r.status}`, r.status, json);
    return json as T;
  }

  async issueCredential(args: { principalId: string; agentId: string; caveats: Exclude<Caveat, { type: "delegate" }>[] }): Promise<ApgwClient> {
    const r = await this.call<{ credential: Credential }>("/v1/credentials", { method: "POST", body: JSON.stringify(args) });
    return new ApgwClient(this.baseUrl, r.credential);
  }

  exportEvidence(principalId: string): Promise<EvidenceBundle> {
    return this.call<EvidenceBundle>(`/v1/evidence/${encodeURIComponent(principalId)}`);
  }

  anchor(principalId: string) {
    return this.call<{ head: string; count: number; txHash: string; blockNumber: string }>("/v1/evidence/anchor", { method: "POST", body: JSON.stringify({ principalId }) });
  }

  killSwitch(principalId: string, on: boolean, reason?: string) {
    return this.call<{ on: boolean; txHash: string; receipt: Receipt }>("/v1/killswitch", { method: "POST", body: JSON.stringify({ principalId, on, reason }) });
  }

  attachExternal(args: { principalId: string; source: string; data: Record<string, unknown>; credentialId?: string; intentId?: string }) {
    return this.call<{ receipt: Receipt }>("/v1/receipts/external", { method: "POST", body: JSON.stringify(args) });
  }

  health() {
    return this.call<{ ok: boolean; gateway: string; chainId: number; policyHash: string }>("/healthz");
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
export function apgwTools(client: ApgwClient): ToolDefinition[] {
  return [
    {
      name: "apgw_pay",
      description: "Pay for an HTTP resource through the Agentic Payment Gateway under the agent's spending policy. Returns the resource body, the policy decision and signed receipts. If denied, returns the reasons; do not retry with a higher amount.",
      parameters: payParams,
      execute: (a) => client.pay(a as unknown as PayRequest),
    },
    {
      name: "apgw_simulate",
      description: "Dry-run a payment: returns whether policy and the on-chain account would allow it, without paying.",
      parameters: payParams,
      execute: (a) => client.simulate(a as unknown as PayRequest),
    },
    {
      name: "apgw_receipts",
      description: "List the signed receipts (decisions, settlements, denials) for this agent's principal.",
      parameters: { type: "object", properties: {} },
      execute: () => client.receipts(),
    },
  ];
}

export { encodeCredential, decodeCredential };
