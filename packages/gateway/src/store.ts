import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Receipt, CredentialPublic, SpendLedgerView, Approval, PaymentIntent, PolicyVersion, Subscription } from "@spendmarshal/core";

export interface RegisteredCredential extends CredentialPublic {
  sessionKey: string;
  parentSessionKey: string | null;
  registeredAt: string;
  txHash: string;
}

export interface AnchorRecord {
  head: string;
  count: number;
  txHash: string;
  blockNumber: string;
  registry: string;
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

/**
 * The gateway's durable state. Two drivers implement it: a JSON file (zero dependencies, fine for demos and
 * single-process dev) and SQLite (WAL mode, real queries, the default for a self-hosted deployment). Every
 * mutation is synchronous so a crash never loses a receipt that was returned to a caller.
 */
export interface Store {
  // receipts
  appendReceipt(r: Receipt): void;
  receiptsFor(principalId: string): Receipt[];
  /** The chain head for a principal (indexed; never loads the chain). */
  lastReceipt(principalId: string): Receipt | undefined;
  // idempotency: final outcomes kept for IDEMPOTENCY_TTL_MS
  getIdempotent(scope: string, key: string): IdempotentRecord | undefined;
  putIdempotent(rec: IdempotentRecord): void;
  // credentials
  getCredential(id: string): RegisteredCredential | undefined;
  putCredential(c: RegisteredCredential): void;
  credentialsFor(principalId: string): RegisteredCredential[];
  // ledger
  reserve(e: Omit<LedgerEntry, "state">): LedgerEntry;
  settle(id: string, txHash: string, settledAt: string): void;
  release(id: string): void;
  /** Live view: reserved + settled entries count against caps, budgets, rate limits and velocity. */
  ledgerView(): SpendLedgerView;
  ledgerEntries(principalId: string): LedgerEntry[];
  spent(): { byCredential: Record<string, string>; byBudget: Record<string, string> };
  // approvals
  putApproval(a: Approval): void;
  getApproval(id: string): Approval | undefined;
  approvalsFor(principalId: string, status?: Approval["status"]): Approval[];
  // intents (impact analysis)
  putIntent(r: IntentRecord): void;
  recentIntents(principalId: string, n: number): IntentRecord[];
  // policy versions
  policyVersions(principalId: string): PolicyVersion[];
  addPolicyVersion(principalId: string, v: PolicyVersion): void;
  principalsWithPolicies(): string[];
  // subscriptions
  putSubscription(s: Subscription): void;
  getSubscription(id: string): Subscription | undefined;
  subscriptionsFor(principalId: string): Subscription[];
  // pre-approvals (standard x402 path)
  putPreApproval(p: PreApprovalRecord): void;
  getPreApproval(digest: string): PreApprovalRecord | undefined;
  pendingPreApprovals(principalId?: string): PreApprovalRecord[];
  // kill switch
  killSwitch(principalId: string): boolean;
  setKillSwitch(principalId: string, on: boolean): void;
  // anchors
  anchorsList(): AnchorRecord[];
  addAnchor(a: AnchorRecord): void;
  close(): void;
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
