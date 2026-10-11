import type { SubscriptionTerms, ChargeRequest } from "@spendmarshal/core";
import type { AgentIdentity } from "./middleware.js";

/** A subscription as the payee sees it: where to charge and with what token. */
export interface PayeeSubscription {
  id: string; // payee-side id
  agentSubscriptionId: string; // the gateway's id
  resource: string;
  chargeUrl: string;
  token: string;
  terms: SubscriptionTerms;
  openedAt: string;
  agent?: AgentIdentity;
  charges: Array<{ at: string; status: number; amount?: string; txHash?: string; error?: string }>;
}

export interface ChargeOutcome {
  status: number;
  ok: boolean;
  amount?: string;
  txHash?: string;
  charges?: number;
  totalCharged?: string;
  subscriptionStatus?: string;
  nextAllowedAt?: string;
  error?: string;
  reasons?: string[];
}

/**
 * The payee's book of open subscriptions. `charge()` is what a billing job calls on each cycle: it posts to
 * the gateway's charge URL with the token and records the outcome. The gateway decides (cadence, caps,
 * policy) and settles on-chain; the payee never holds an agent's key or signs anything.
 */
export class SubscriptionBook {
  private readonly subs = new Map<string, PayeeSubscription>();
  private seq = 0;

  register(s: Omit<PayeeSubscription, "id" | "openedAt" | "charges">): PayeeSubscription {
    const entry: PayeeSubscription = { ...s, id: `psub_${++this.seq}`, openedAt: new Date().toISOString(), charges: [] };
    this.subs.set(entry.id, entry);
    return entry;
  }

  list(): PayeeSubscription[] {
    return [...this.subs.values()];
  }

  get(id: string): PayeeSubscription | undefined {
    return this.subs.get(id);
  }

  async charge(id: string, body: ChargeRequest = {}): Promise<ChargeOutcome> {
    const s = this.subs.get(id);
    if (!s) return { status: 404, ok: false, error: "unknown subscription" };
    const r = await fetch(s.chargeUrl, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const json = (await r.json()) as Partial<ChargeOutcome>;
    const out: ChargeOutcome = { status: r.status, ok: r.ok, ...json };
    s.charges.push({ at: new Date().toISOString(), status: r.status, amount: out.amount, txHash: out.txHash, error: out.error });
    return out;
  }
}
