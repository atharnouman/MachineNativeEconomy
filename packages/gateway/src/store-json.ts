import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Receipt, ReceiptKind, SpendLedgerView, Approval, PolicyVersion, Subscription, Decision } from "@spendmarshal/core";
import { IDEMPOTENCY_TTL_MS, ChainConflict, type Store, type RegisteredCredential, type AnchorRecord, type LedgerEntry, type IntentRecord, type PreApprovalRecord, type IdempotentRecord } from "./store.js";

interface State {
  receipts: Receipt[];
  idempotency?: Record<string, IdempotentRecord>;
  credentials: Record<string, RegisteredCredential>;
  ledger: LedgerEntry[];
  approvals: Record<string, Approval>;
  intents: IntentRecord[];
  policies: Record<string, PolicyVersion[]>;
  subscriptions: Record<string, Subscription>;
  preApprovals: Record<string, PreApprovalRecord>;
  killSwitch: Record<string, boolean>;
  anchors: AnchorRecord[];
}

const empty = (): State => ({ receipts: [], credentials: {}, ledger: [], approvals: {}, intents: [], policies: {}, subscriptions: {}, preApprovals: {}, killSwitch: {}, anchors: [] });

/** Callers get copies of mutable records, so a change takes effect only through the store. */
const copy = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

/**
 * JSON-file driver with write-through on every mutation. Zero dependencies; for demos and single-process dev. Every
 * method runs without an `await` inside, so each check-then-act is atomic within the process (ADR-0025). Leases live in
 * memory: the process that holds them is the only writer.
 */
export class JsonStore implements Store {
  private state: State;
  private readonly leases = new Map<string, { holder: string; until: number }>();

  constructor(private readonly file: string) {
    this.state = existsSync(file) ? { ...empty(), ...(JSON.parse(readFileSync(file, "utf8")) as Partial<State>) } : empty();
  }

  private flush() {
    writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  private last(principalId: string): Receipt | undefined {
    for (let i = this.state.receipts.length - 1; i >= 0; i--) {
      const r = this.state.receipts[i]!;
      if (r.principalId === principalId) return r;
    }
    return undefined;
  }

  async appendReceipt(r: Receipt) {
    const head = this.last(r.principalId);
    if (head && r.seq <= head.seq) throw new ChainConflict(r.principalId, r.seq);
    this.state.receipts.push(r);
    this.flush();
  }
  async receiptsFor(principalId: string): Promise<Receipt[]> {
    return this.state.receipts.filter((r) => r.principalId === principalId);
  }
  async lastReceipt(principalId: string): Promise<Receipt | undefined> {
    return this.last(principalId);
  }
  async receiptsOfKind(principalId: string, kinds: readonly ReceiptKind[]): Promise<Receipt[]> {
    return this.state.receipts.filter((r) => r.principalId === principalId && kinds.includes(r.kind));
  }

  async getIdempotent(scope: string, key: string): Promise<IdempotentRecord | undefined> {
    const rec = this.state.idempotency?.[`${scope}\u0000${key}`];
    if (!rec || Date.now() - Date.parse(rec.createdAt) > IDEMPOTENCY_TTL_MS) return undefined;
    return copy(rec);
  }
  async putIdempotent(rec: IdempotentRecord) {
    const all = (this.state.idempotency ??= {});
    all[`${rec.scope}\u0000${rec.key}`] = copy(rec);
    if (Object.keys(all).length > 5000) {
      const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
      for (const [k, v] of Object.entries(all)) if (Date.parse(v.createdAt) < cutoff) delete all[k];
    }
    this.flush();
  }

  async getCredential(id: string) {
    return copy(this.state.credentials[id]);
  }
  async putCredential(c: RegisteredCredential) {
    this.state.credentials[c.id] = copy(c);
    this.flush();
  }
  async credentialsFor(principalId: string) {
    return Object.values(this.state.credentials)
      .filter((c) => c.principalId === principalId)
      .map(copy);
  }

  private view(principalId: string): SpendLedgerView {
    const live = (since?: Date) => this.state.ledger.filter((e) => e.principalId === principalId && e.state !== "released" && (!since || new Date(e.ts) >= since));
    const sum = (es: LedgerEntry[]) => es.reduce((a, e) => a + BigInt(e.amount), 0n);
    return {
      spentByCredential: (id, since) => sum(live(since).filter((e) => e.credentialIds.includes(id))),
      spentByBudget: (id, since) => sum(live(since).filter((e) => e.budgetIds.includes(id))),
      activity: (scope, id, since) => {
        const es = live(since).filter((e) => (scope === "credential" ? e.credentialIds.includes(id) : scope === "agent" ? e.rootAgentId === id : e.principalId === id));
        return { count: es.length, amount: sum(es) };
      },
    };
  }
  async reserveIf(e: Omit<LedgerEntry, "state">, decide: (ledger: SpendLedgerView) => Decision) {
    const decision = decide(this.view(e.principalId));
    if (decision.effect !== "allow") return { decision };
    const entry: LedgerEntry = { ...copy(e), state: "reserved" };
    this.state.ledger.push(entry);
    this.flush();
    return { decision, entry: copy(entry) };
  }
  async withLedger<T>(principalId: string, read: (ledger: SpendLedgerView) => T): Promise<T> {
    return read(this.view(principalId));
  }
  async settle(id: string, txHash: string, settledAt: string) {
    const e = this.state.ledger.find((x) => x.id === id);
    if (!e) throw new Error(`ledger entry ${id} not found`);
    e.state = "settled";
    e.txHash = txHash;
    e.settledAt = settledAt;
    this.flush();
  }
  async release(id: string) {
    const e = this.state.ledger.find((x) => x.id === id);
    if (!e) throw new Error(`ledger entry ${id} not found`);
    e.state = "released";
    this.flush();
  }
  async ledgerEntries(principalId: string) {
    return this.state.ledger.filter((e) => e.principalId === principalId).map(copy);
  }
  async spent(principalId: string) {
    const byCredential: Record<string, bigint> = {};
    const byBudget: Record<string, bigint> = {};
    for (const e of this.state.ledger) {
      if (e.state !== "settled" || e.principalId !== principalId) continue;
      for (const c of e.credentialIds) byCredential[c] = (byCredential[c] ?? 0n) + BigInt(e.amount);
      for (const b of e.budgetIds) byBudget[b] = (byBudget[b] ?? 0n) + BigInt(e.amount);
    }
    const str = (o: Record<string, bigint>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.toString()]));
    return { byCredential: str(byCredential), byBudget: str(byBudget) };
  }

  async putApproval(a: Approval) {
    this.state.approvals[a.id] = copy(a);
    this.flush();
  }
  async transitionApproval(next: Approval, from: readonly Approval["status"][]) {
    const cur = this.state.approvals[next.id];
    if (!cur || !from.includes(cur.status)) return false;
    this.state.approvals[next.id] = copy(next);
    this.flush();
    return true;
  }
  async getApproval(id: string) {
    return copy(this.state.approvals[id]);
  }
  async approvalsFor(principalId: string, status?: Approval["status"]) {
    return Object.values(this.state.approvals)
      .filter((a) => a.principalId === principalId && (!status || a.status === status))
      .map(copy);
  }

  async putIntent(r: IntentRecord) {
    this.state.intents.push(copy(r));
    if (this.state.intents.length > 5000) this.state.intents.splice(0, this.state.intents.length - 5000);
    this.flush();
  }
  async recentIntents(principalId: string, n: number) {
    return this.state.intents
      .filter((r) => r.intent.principalId === principalId)
      .slice(-n)
      .map(copy);
  }

  async policyVersions(principalId: string) {
    return [...(this.state.policies[principalId] ?? [])];
  }
  async addPolicyVersion(principalId: string, v: PolicyVersion) {
    const versions = (this.state.policies[principalId] ??= []);
    if (versions.some((x) => x.version === v.version)) return false;
    versions.push(v);
    this.flush();
    return true;
  }
  async principalsWithPolicies() {
    return Object.keys(this.state.policies);
  }

  async putSubscription(s: Subscription) {
    this.state.subscriptions[s.id] = copy(s);
    this.flush();
  }
  async getSubscription(id: string) {
    return copy(this.state.subscriptions[id]);
  }
  async subscriptionsFor(principalId: string) {
    return Object.values(this.state.subscriptions)
      .filter((s) => s.principalId === principalId)
      .map(copy);
  }

  async putPreApproval(p: PreApprovalRecord) {
    this.state.preApprovals[p.digest] = copy(p);
    this.flush();
  }
  async getPreApproval(digest: string) {
    return copy(this.state.preApprovals[digest]);
  }
  async pendingPreApprovals(principalId?: string) {
    return Object.values(this.state.preApprovals)
      .filter((p) => p.state === "pending" && (!principalId || p.principalId === principalId))
      .map(copy);
  }

  async killSwitch(principalId: string) {
    return !!this.state.killSwitch[principalId];
  }
  async setKillSwitch(principalId: string, on: boolean) {
    this.state.killSwitch[principalId] = on;
    this.flush();
  }

  async anchorsList(principalId?: string) {
    return (principalId === undefined ? this.state.anchors : this.state.anchors.filter((a) => a.principalId === principalId)).map(copy);
  }
  async addAnchor(a: AnchorRecord) {
    this.state.anchors.push(copy(a));
    this.flush();
  }

  async acquireLease(name: string, holder: string, ttlMs: number) {
    const now = Date.now();
    const cur = this.leases.get(name);
    if (cur && cur.holder !== holder && cur.until > now) return false;
    this.leases.set(name, { holder, until: now + ttlMs });
    return true;
  }
  async releaseLease(name: string, holder: string) {
    if (this.leases.get(name)?.holder === holder) this.leases.delete(name);
  }

  async close() {
    /* nothing to release */
  }
}
