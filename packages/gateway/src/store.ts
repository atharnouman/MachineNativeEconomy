import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomId, type Receipt, type ReceiptKind, type CredentialPublic, type SpendLedgerView, type Approval, type PaymentIntent, type PolicyVersion, type Subscription, type Decision } from "@spendmarshal/core";

export interface RegisteredCredential extends CredentialPublic {
  sessionKey: string;
  parentSessionKey: string | null;
  registeredAt: string;
  txHash: string;
}

export interface AnchorRecord {
  /** whose receipt chain was anchored (absent on records written before anchors were scoped) */
  principalId?: string;
  head: string;
  count: number;
  txHash: string;
  blockNumber: string;
  registry: string;
  /** the address that sent the anchor; the registry chains anchors per sender (absent on records from before ADR-0020) */
  party?: string;
}

/** One payment's charge against the ledger. Reserved while in flight, settled on confirmation, released on failure. */
export interface LedgerEntry {
  id: string;
  ts: string; // reservation time; windows and periods are evaluated on this
  principalId: string;
  intentId: string;
  agentId: string;
  rootAgentId: string;
  credentialIds: string[]; // the whole lineage, outermost first
  budgetIds: string[]; // the budget path, leaf first
  amount: string; // base units
  state: "reserved" | "settled" | "released";
  settledAt?: string;
  txHash?: string;
}

export interface IntentRecord {
  intent: PaymentIntent;
  amount: string; // base units decided on
  effect: "allow" | "deny" | "escalate";
  ts: string;
}

/** A standard-x402 pre-approval the account charged on-chain; cleared when settled, reclaimable when expired unused. */
export interface PreApprovalRecord {
  digest: string; // EIP-3009 digest under the token domain (the account's key for it)
  principalId: string;
  account: string;
  credentialId: string;
  intentId: string;
  value: string;
  validBefore: string; // unix seconds as string
  approvalTxHash: string;
  createdAt: string;
  state: "pending" | "settled" | "reclaimed";
  settledTxHash?: string;
  reclaimTxHash?: string;
}

/** A stored final outcome of an idempotent request (POST /v1/intents, POST /v1/subscriptions). */
export interface IdempotentRecord {
  /** the credential id: a key is only ever replayed to the credential that created it */
  scope: string;
  key: string;
  status: number;
  body: unknown;
  createdAt: string;
}
export const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000;

/** A receipt whose sequence number another writer took first: the head moved, so read it again and rebuild (ADR-0025). */
export class ChainConflict extends Error {
  constructor(
    readonly principalId: string,
    readonly seq: number,
  ) {
    super(`receipt #${seq} of ${principalId} was written by another writer first`);
    this.name = "ChainConflict";
  }
}

/**
 * The gateway's durable state. Three drivers implement it: a JSON file (zero dependencies, for demos and single-process
 * dev), SQLite (WAL mode, the default for a self-hosted deployment) and Postgres (several gateway instances on one
 * database). Every method is asynchronous; a write completes before the receipt or response that depends on it.
 *
 * Everything that checks state and then changes it is one operation here, which each driver makes atomic, so it holds
 * across gateway instances as well as within one (ADR-0025): `reserveIf`, `appendReceipt` (refuses a taken sequence
 * number), `transitionApproval`, `addPolicyVersion` (refuses a taken version) and the leases.
 */
export interface Store {
  // receipts
  /** Appends a receipt; rejects with `ChainConflict` when its sequence number is taken. */
  appendReceipt(r: Receipt): Promise<void>;
  receiptsFor(principalId: string): Promise<Receipt[]>;
  /** The chain head for a principal (indexed; never loads the chain). */
  lastReceipt(principalId: string): Promise<Receipt | undefined>;
  /** A principal's receipts of the given kinds, in chain order (indexed; never loads the rest of the chain). */
  receiptsOfKind(principalId: string, kinds: readonly ReceiptKind[]): Promise<Receipt[]>;
  // idempotency: final outcomes kept for IDEMPOTENCY_TTL_MS
  getIdempotent(scope: string, key: string): Promise<IdempotentRecord | undefined>;
  putIdempotent(rec: IdempotentRecord): Promise<void>;
  // credentials
  getCredential(id: string): Promise<RegisteredCredential | undefined>;
  putCredential(c: RegisteredCredential): Promise<void>;
  credentialsFor(principalId: string): Promise<RegisteredCredential[]>;
  // ledger
  /**
   * Decides on the principal's ledger and, when the decision allows, reserves `entry` in the same step: no other
   * reservation of that principal comes in between. Reserved and settled entries count against caps, budgets, rate limits
   * and velocity; budget names and agent ids are only unique within a principal, so every figure is scoped to it.
   * `decide` may run more than once and must depend only on the view it gets (fix `now` outside it).
   */
  reserveIf(entry: Omit<LedgerEntry, "state">, decide: (ledger: SpendLedgerView) => Decision): Promise<{ decision: Decision; entry?: LedgerEntry }>;
  /** Runs `read` on a consistent view of the principal's ledger. Like `decide` above, it may run more than once. */
  withLedger<T>(principalId: string, read: (ledger: SpendLedgerView) => T): Promise<T>;
  settle(id: string, txHash: string, settledAt: string): Promise<void>;
  release(id: string): Promise<void>;
  ledgerEntries(principalId: string): Promise<LedgerEntry[]>;
  /** Settled totals of one principal, by credential and by budget. */
  spent(principalId: string): Promise<{ byCredential: Record<string, string>; byBudget: Record<string, string> }>;
  // approvals
  putApproval(a: Approval): Promise<void>;
  /** Replaces the approval with `next` only while its stored status is one of `from`; true when it did. */
  transitionApproval(next: Approval, from: readonly Approval["status"][]): Promise<boolean>;
  getApproval(id: string): Promise<Approval | undefined>;
  approvalsFor(principalId: string, status?: Approval["status"]): Promise<Approval[]>;
  // intents (impact analysis)
  putIntent(r: IntentRecord): Promise<void>;
  recentIntents(principalId: string, n: number): Promise<IntentRecord[]>;
  // policy versions
  policyVersions(principalId: string): Promise<PolicyVersion[]>;
  /** Adds a version; false when that version number is already taken (the policy changed meanwhile). */
  addPolicyVersion(principalId: string, v: PolicyVersion): Promise<boolean>;
  principalsWithPolicies(): Promise<string[]>;
  // subscriptions
  putSubscription(s: Subscription): Promise<void>;
  getSubscription(id: string): Promise<Subscription | undefined>;
  subscriptionsFor(principalId: string): Promise<Subscription[]>;
  // pre-approvals (standard x402 path)
  putPreApproval(p: PreApprovalRecord): Promise<void>;
  getPreApproval(digest: string): Promise<PreApprovalRecord | undefined>;
  pendingPreApprovals(principalId?: string): Promise<PreApprovalRecord[]>;
  // kill switch
  killSwitch(principalId: string): Promise<boolean>;
  setKillSwitch(principalId: string, on: boolean): Promise<void>;
  // anchors
  /** Anchors in order; with a principal, only that principal's (a bundle must never carry another tenant's). */
  anchorsList(principalId?: string): Promise<AnchorRecord[]>;
  addAnchor(a: AnchorRecord): Promise<void>;
  // leases, for work that spans awaits
  /** Takes the named lease for `holder` for `ttlMs`, unless another holder has it unexpired; true when taken. */
  acquireLease(name: string, holder: string, ttlMs: number): Promise<boolean>;
  /** Gives the lease up if `holder` still has it. */
  releaseLease(name: string, holder: string): Promise<void>;
  close(): Promise<void>;
}

export type StoreDriver = "json" | "sqlite";

export interface StoreOptions {
  driver?: StoreDriver;
  dataDir: string;
}

/** Open the configured store. JSON lives at `<dataDir>/state.json`, SQLite at `<dataDir>/spendmarshal.sqlite`. */
export async function openStore(opts: StoreOptions): Promise<Store> {
  mkdirSync(opts.dataDir, { recursive: true });
  if ((opts.driver ?? "json") === "sqlite") {
    const { SqliteStore } = await import("./store-sqlite.js");
    return new SqliteStore(join(opts.dataDir, "spendmarshal.sqlite"));
  }
  const { JsonStore } = await import("./store-json.js");
  return new JsonStore(join(opts.dataDir, "state.json"));
}

/**
 * Runs `fn` while holding the named lease, given up afterwards whatever happens. Waits up to `waitMs` for a lease another
 * holder has (default: not at all), then fails with 409 and the `busy` message.
 */
export async function withLease<T>(store: Store, name: string, opts: { ttlMs: number; waitMs?: number; busy: string }, fn: () => Promise<T>): Promise<T> {
  const holder = randomId("lease");
  const deadline = Date.now() + (opts.waitMs ?? 0);
  while (!(await store.acquireLease(name, holder, opts.ttlMs))) {
    if (Date.now() >= deadline) throw Object.assign(new Error(opts.busy), { statusCode: 409 });
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    return await fn();
  } finally {
    await store.releaseLease(name, holder);
  }
}
