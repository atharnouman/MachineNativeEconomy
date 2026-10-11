import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Receipt, SpendLedgerView, Approval, PolicyVersion, Subscription } from "@spendmarshal/core";
import type { Store, RegisteredCredential, AnchorRecord, LedgerEntry, IntentRecord, PreApprovalRecord } from "./store.js";

interface State {
  receipts: Receipt[];
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

/** JSON-file driver with write-through on every mutation. Zero dependencies; for demos and single-process dev. */
export class JsonStore implements Store {
  private state: State;

  constructor(private readonly file: string) {
    this.state = existsSync(file) ? { ...empty(), ...(JSON.parse(readFileSync(file, "utf8")) as Partial<State>) } : empty();
  }

  private flush() {
    writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  appendReceipt(r: Receipt) {
    this.state.receipts.push(r);
    this.flush();
  }
  receiptsFor(principalId: string): Receipt[] {
    return this.state.receipts.filter((r) => r.principalId === principalId);
  }

  getCredential(id: string) {
    return this.state.credentials[id];
  }
  putCredential(c: RegisteredCredential) {
    this.state.credentials[c.id] = c;
    this.flush();
  }
  credentialsFor(principalId: string) {
    return Object.values(this.state.credentials).filter((c) => c.principalId === principalId);
  }

  reserve(e: Omit<LedgerEntry, "state">): LedgerEntry {
    const entry: LedgerEntry = { ...e, state: "reserved" };
    this.state.ledger.push(entry);
    this.flush();
    return entry;
  }
  settle(id: string, txHash: string, settledAt: string) {
    const e = this.state.ledger.find((x) => x.id === id);
    if (!e) throw new Error(`ledger entry ${id} not found`);
    e.state = "settled";
    e.txHash = txHash;
    e.settledAt = settledAt;
    this.flush();
  }
  release(id: string) {
    const e = this.state.ledger.find((x) => x.id === id);
    if (!e) throw new Error(`ledger entry ${id} not found`);
    e.state = "released";
    this.flush();
  }
  ledgerView(): SpendLedgerView {
    const live = (since?: Date) => this.state.ledger.filter((e) => e.state !== "released" && (!since || new Date(e.ts) >= since));
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
  ledgerEntries(principalId: string) {
    return this.state.ledger.filter((e) => e.principalId === principalId);
  }
  spent() {
    const byCredential: Record<string, bigint> = {};
    const byBudget: Record<string, bigint> = {};
    for (const e of this.state.ledger) {
      if (e.state !== "settled") continue;
      for (const c of e.credentialIds) byCredential[c] = (byCredential[c] ?? 0n) + BigInt(e.amount);
      for (const b of e.budgetIds) byBudget[b] = (byBudget[b] ?? 0n) + BigInt(e.amount);
    }
    const str = (o: Record<string, bigint>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.toString()]));
    return { byCredential: str(byCredential), byBudget: str(byBudget) };
  }

  putApproval(a: Approval) {
    this.state.approvals[a.id] = a;
    this.flush();
  }
  getApproval(id: string) {
    return this.state.approvals[id];
  }
  approvalsFor(principalId: string, status?: Approval["status"]) {
    return Object.values(this.state.approvals).filter((a) => a.principalId === principalId && (!status || a.status === status));
  }

  putIntent(r: IntentRecord) {
    this.state.intents.push(r);
    if (this.state.intents.length > 5000) this.state.intents.splice(0, this.state.intents.length - 5000);
    this.flush();
  }
  recentIntents(principalId: string, n: number) {
    return this.state.intents.filter((r) => r.intent.principalId === principalId).slice(-n);
  }

  policyVersions(principalId: string) {
    return [...(this.state.policies[principalId] ?? [])];
  }
  addPolicyVersion(principalId: string, v: PolicyVersion) {
    (this.state.policies[principalId] ??= []).push(v);
    this.flush();
  }
  principalsWithPolicies() {
    return Object.keys(this.state.policies);
  }

  putSubscription(s: Subscription) {
    this.state.subscriptions[s.id] = s;
    this.flush();
  }
  getSubscription(id: string) {
    return this.state.subscriptions[id];
  }
  subscriptionsFor(principalId: string) {
    return Object.values(this.state.subscriptions).filter((s) => s.principalId === principalId);
  }

  putPreApproval(p: PreApprovalRecord) {
    this.state.preApprovals[p.digest] = p;
    this.flush();
  }
  getPreApproval(digest: string) {
    return this.state.preApprovals[digest];
  }
  pendingPreApprovals(principalId?: string) {
    return Object.values(this.state.preApprovals).filter((p) => p.state === "pending" && (!principalId || p.principalId === principalId));
  }

  killSwitch(principalId: string) {
    return !!this.state.killSwitch[principalId];
  }
  setKillSwitch(principalId: string, on: boolean) {
    this.state.killSwitch[principalId] = on;
    this.flush();
  }

  anchorsList() {
    return [...this.state.anchors];
  }
  addAnchor(a: AnchorRecord) {
    this.state.anchors.push(a);
    this.flush();
  }

  close() {
    /* nothing to release */
  }
}
