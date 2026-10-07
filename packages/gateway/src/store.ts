import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Receipt, CredentialPublic, SpendLedgerView } from "@apgw/core";

export interface RegisteredCredential extends CredentialPublic {
  sessionKey: string;
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

interface State {
  receipts: Receipt[];
  credentials: Record<string, RegisteredCredential>; // by credentialId
  spentByCredential: Record<string, string>; // settled, base units
  spentByBudget: Record<string, string>;
  reservedByCredential: Record<string, string>; // in-flight
  reservedByBudget: Record<string, string>;
  killSwitch: Record<string, boolean>; // by principalId
  anchors: AnchorRecord[];
}

const empty = (): State => ({
  receipts: [],
  credentials: {},
  spentByCredential: {},
  spentByBudget: {},
  reservedByCredential: {},
  reservedByBudget: {},
  killSwitch: {},
  anchors: [],
});

/**
 * Durable state with write-through to a JSON file. Deliberately simple for the thin slice; the interface is
 * what later phases swap for Postgres/SQLite. Every mutation is synchronous so a crash never loses a receipt
 * that was returned to a caller.
 */
export class Store {
  private state: State;
  private readonly file: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "state.json");
    this.state = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as State) : empty();
  }

  private flush() {
    writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  // receipts
  get receipts(): readonly Receipt[] {
    return this.state.receipts;
  }
  appendReceipt(r: Receipt) {
    this.state.receipts.push(r);
    this.flush();
  }
  receiptsFor(principalId: string): Receipt[] {
    return this.state.receipts.filter((r) => r.principalId === principalId);
  }

  // credentials
  getCredential(id: string): RegisteredCredential | undefined {
    return this.state.credentials[id];
  }
  putCredential(c: RegisteredCredential) {
    this.state.credentials[c.id] = c;
    this.flush();
  }
  credentialsFor(principalId: string): RegisteredCredential[] {
    return Object.values(this.state.credentials).filter((c) => c.principalId === principalId);
  }

  // ledger (settled + reserved both count against caps)
  ledgerView(): SpendLedgerView {
    const sum = (a?: string, b?: string) => BigInt(a ?? "0") + BigInt(b ?? "0");
    return {
      spentByCredential: (id) => sum(this.state.spentByCredential[id], this.state.reservedByCredential[id]),
      spentByBudget: (id) => sum(this.state.spentByBudget[id], this.state.reservedByBudget[id]),
    };
  }
  reserve(credentialIds: string[], budgetIds: string[], amount: bigint) {
    for (const id of credentialIds) this.state.reservedByCredential[id] = (BigInt(this.state.reservedByCredential[id] ?? "0") + amount).toString();
    for (const id of budgetIds) this.state.reservedByBudget[id] = (BigInt(this.state.reservedByBudget[id] ?? "0") + amount).toString();
    this.flush();
  }
  release(credentialIds: string[], budgetIds: string[], amount: bigint) {
    const dec = (cur?: string) => {
      const v = BigInt(cur ?? "0") - amount;
      return (v < 0n ? 0n : v).toString(); // never go negative: a release without a reserve is a bug, not a credit
    };
    for (const id of credentialIds) this.state.reservedByCredential[id] = dec(this.state.reservedByCredential[id]);
    for (const id of budgetIds) this.state.reservedByBudget[id] = dec(this.state.reservedByBudget[id]);
    this.flush();
  }
  commit(credentialIds: string[], budgetIds: string[], amount: bigint) {
    this.release(credentialIds, budgetIds, amount);
    for (const id of credentialIds) this.state.spentByCredential[id] = (BigInt(this.state.spentByCredential[id] ?? "0") + amount).toString();
    for (const id of budgetIds) this.state.spentByBudget[id] = (BigInt(this.state.spentByBudget[id] ?? "0") + amount).toString();
    this.flush();
  }
  spent(): { byCredential: Record<string, string>; byBudget: Record<string, string> } {
    return { byCredential: { ...this.state.spentByCredential }, byBudget: { ...this.state.spentByBudget } };
  }

  // kill switch
  killSwitch(principalId: string): boolean {
    return !!this.state.killSwitch[principalId];
  }
  setKillSwitch(principalId: string, on: boolean) {
    this.state.killSwitch[principalId] = on;
    this.flush();
  }

  // anchors
  get anchors(): readonly AnchorRecord[] {
    return this.state.anchors;
  }
  addAnchor(a: AnchorRecord) {
    this.state.anchors.push(a);
    this.flush();
  }
}
