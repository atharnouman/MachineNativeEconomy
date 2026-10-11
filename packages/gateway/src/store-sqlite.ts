import Database from "better-sqlite3";
import type { Receipt, SpendLedgerView, Approval, PolicyVersion, Subscription } from "@apgw/core";
import type { Store, RegisteredCredential, AnchorRecord, LedgerEntry, IntentRecord, PreApprovalRecord } from "./store.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL,
  UNIQUE (principal_id, seq)
);
CREATE INDEX IF NOT EXISTS receipts_principal ON receipts (principal_id, seq);
CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS credentials_principal ON credentials (principal_id);
CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, ts TEXT NOT NULL, intent_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  root_agent_id TEXT NOT NULL, amount INTEGER NOT NULL, state TEXT NOT NULL, settled_at TEXT, tx_hash TEXT
);
CREATE INDEX IF NOT EXISTS ledger_principal_ts ON ledger (principal_id, ts);
CREATE INDEX IF NOT EXISTS ledger_root_agent ON ledger (root_agent_id, ts);
CREATE TABLE IF NOT EXISTS ledger_credentials (entry_id TEXT NOT NULL, credential_id TEXT NOT NULL, PRIMARY KEY (entry_id, credential_id));
CREATE INDEX IF NOT EXISTS ledger_credentials_cred ON ledger_credentials (credential_id);
CREATE TABLE IF NOT EXISTS ledger_budgets (entry_id TEXT NOT NULL, budget_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (entry_id, budget_id));
CREATE INDEX IF NOT EXISTS ledger_budgets_budget ON ledger_budgets (budget_id);
CREATE TABLE IF NOT EXISTS ledger_credentials_order (entry_id TEXT NOT NULL, credential_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (entry_id, position));
CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS approvals_principal_status ON approvals (principal_id, status);
CREATE TABLE IF NOT EXISTS intents (seq INTEGER PRIMARY KEY AUTOINCREMENT, principal_id TEXT NOT NULL, ts TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS intents_principal ON intents (principal_id, seq);
CREATE TABLE IF NOT EXISTS policies (principal_id TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (principal_id, version));
CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS subscriptions_principal ON subscriptions (principal_id, status);
CREATE TABLE IF NOT EXISTS preapprovals (digest TEXT PRIMARY KEY, principal_id TEXT NOT NULL, state TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS preapprovals_state ON preapprovals (state, principal_id);
CREATE TABLE IF NOT EXISTS killswitch (principal_id TEXT PRIMARY KEY, on_flag INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS anchors (seq INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL);
`;

/**
 * SQLite driver (better-sqlite3, WAL mode, 64-bit integers for amounts). Synchronous like the JSON driver, so
 * the receipt log's ordering guarantees hold unchanged. One file, no server: still a one-command self-host.
 */
export class SqliteStore implements Store {
  private readonly db: Database.Database;

  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.defaultSafeIntegers(true); // INTEGER columns come back as BigInt: amounts never lose precision
    this.db.exec(SCHEMA);
  }

  private row<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  private rows<T>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  // ───────── receipts ─────────
  appendReceipt(r: Receipt) {
    this.db.prepare("INSERT INTO receipts (id, principal_id, seq, ts, kind, json) VALUES (?, ?, ?, ?, ?, ?)").run(r.id, r.principalId, r.seq, r.ts, r.kind, JSON.stringify(r));
  }
  receiptsFor(principalId: string): Receipt[] {
    return this.rows<{ json: string }>("SELECT json FROM receipts WHERE principal_id = ? ORDER BY seq", principalId).map((x) => JSON.parse(x.json) as Receipt);
  }

  // ───────── credentials ─────────
  getCredential(id: string) {
    const r = this.row<{ json: string }>("SELECT json FROM credentials WHERE id = ?", id);
    return r ? (JSON.parse(r.json) as RegisteredCredential) : undefined;
  }
  putCredential(c: RegisteredCredential) {
    this.db.prepare("INSERT INTO credentials (id, principal_id, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json").run(c.id, c.principalId, JSON.stringify(c));
  }
  credentialsFor(principalId: string) {
    return this.rows<{ json: string }>("SELECT json FROM credentials WHERE principal_id = ? ORDER BY rowid", principalId).map((x) => JSON.parse(x.json) as RegisteredCredential);
  }

  // ───────── ledger ─────────
  reserve(e: Omit<LedgerEntry, "state">): LedgerEntry {
    const entry: LedgerEntry = { ...e, state: "reserved" };
    const tx = this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO ledger (id, principal_id, ts, intent_id, agent_id, root_agent_id, amount, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved')")
        .run(e.id, e.principalId, e.ts, e.intentId, e.agentId, e.rootAgentId, BigInt(e.amount));
      const lc = this.db.prepare("INSERT OR IGNORE INTO ledger_credentials (entry_id, credential_id) VALUES (?, ?)");
      const lco = this.db.prepare("INSERT INTO ledger_credentials_order (entry_id, credential_id, position) VALUES (?, ?, ?)");
      e.credentialIds.forEach((c, i) => {
        lc.run(e.id, c);
        lco.run(e.id, c, i);
      });
      const lb = this.db.prepare("INSERT OR IGNORE INTO ledger_budgets (entry_id, budget_id, position) VALUES (?, ?, ?)");
      e.budgetIds.forEach((b, i) => lb.run(e.id, b, i));
    });
    tx();
    return entry;
  }
  settle(id: string, txHash: string, settledAt: string) {
    const r = this.db.prepare("UPDATE ledger SET state = 'settled', tx_hash = ?, settled_at = ? WHERE id = ?").run(txHash, settledAt, id);
    if (r.changes === 0) throw new Error(`ledger entry ${id} not found`);
  }
  release(id: string) {
    const r = this.db.prepare("UPDATE ledger SET state = 'released' WHERE id = ?").run(id);
    if (r.changes === 0) throw new Error(`ledger entry ${id} not found`);
  }
  ledgerView(): SpendLedgerView {
    const sinceIso = (d?: Date) => (d ? d.toISOString() : null);
    const sum = (r: { s: bigint | null } | undefined) => BigInt(r?.s ?? 0n);
    return {
      spentByCredential: (id, since) =>
        sum(
          this.row<{ s: bigint | null }>(
            "SELECT SUM(l.amount) AS s FROM ledger l JOIN ledger_credentials c ON c.entry_id = l.id WHERE c.credential_id = ? AND l.state != 'released' AND (? IS NULL OR l.ts >= ?)",
            id,
            sinceIso(since),
            sinceIso(since),
          ),
        ),
      spentByBudget: (id, since) =>
        sum(
          this.row<{ s: bigint | null }>(
            "SELECT SUM(l.amount) AS s FROM ledger l JOIN ledger_budgets b ON b.entry_id = l.id WHERE b.budget_id = ? AND l.state != 'released' AND (? IS NULL OR l.ts >= ?)",
            id,
            sinceIso(since),
            sinceIso(since),
          ),
        ),
      activity: (scope, id, since) => {
        const s = sinceIso(since);
        const q =
          scope === "credential"
            ? "SELECT COUNT(*) AS n, SUM(l.amount) AS s FROM ledger l JOIN ledger_credentials c ON c.entry_id = l.id WHERE c.credential_id = ? AND l.state != 'released' AND l.ts >= ?"
            : scope === "agent"
              ? "SELECT COUNT(*) AS n, SUM(amount) AS s FROM ledger WHERE root_agent_id = ? AND state != 'released' AND ts >= ?"
              : "SELECT COUNT(*) AS n, SUM(amount) AS s FROM ledger WHERE principal_id = ? AND state != 'released' AND ts >= ?";
        const r = this.row<{ n: bigint; s: bigint | null }>(q, id, s);
        return { count: Number(r?.n ?? 0n), amount: BigInt(r?.s ?? 0n) };
      },
    };
  }
  ledgerEntries(principalId: string): LedgerEntry[] {
    const rows = this.rows<{ id: string; principal_id: string; ts: string; intent_id: string; agent_id: string; root_agent_id: string; amount: bigint; state: LedgerEntry["state"]; settled_at: string | null; tx_hash: string | null }>(
      "SELECT * FROM ledger WHERE principal_id = ? ORDER BY rowid",
      principalId,
    );
    return rows.map((r) => ({
      id: r.id,
      principalId: r.principal_id,
      ts: r.ts,
      intentId: r.intent_id,
      agentId: r.agent_id,
      rootAgentId: r.root_agent_id,
      amount: r.amount.toString(),
      state: r.state,
      ...(r.settled_at ? { settledAt: r.settled_at } : {}),
      ...(r.tx_hash ? { txHash: r.tx_hash } : {}),
      credentialIds: this.rows<{ credential_id: string }>("SELECT credential_id FROM ledger_credentials_order WHERE entry_id = ? ORDER BY position", r.id).map((x) => x.credential_id),
      budgetIds: this.rows<{ budget_id: string }>("SELECT budget_id FROM ledger_budgets WHERE entry_id = ? ORDER BY position", r.id).map((x) => x.budget_id),
    }));
  }
  spent() {
    const byCredential = Object.fromEntries(
      this.rows<{ k: string; s: bigint }>("SELECT c.credential_id AS k, SUM(l.amount) AS s FROM ledger l JOIN ledger_credentials c ON c.entry_id = l.id WHERE l.state = 'settled' GROUP BY c.credential_id").map((x) => [x.k, x.s.toString()]),
    );
    const byBudget = Object.fromEntries(
      this.rows<{ k: string; s: bigint }>("SELECT b.budget_id AS k, SUM(l.amount) AS s FROM ledger l JOIN ledger_budgets b ON b.entry_id = l.id WHERE l.state = 'settled' GROUP BY b.budget_id").map((x) => [x.k, x.s.toString()]),
    );
    return { byCredential, byBudget };
  }

  // ───────── approvals ─────────
  putApproval(a: Approval) {
    this.db.prepare("INSERT INTO approvals (id, principal_id, status, json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json").run(a.id, a.principalId, a.status, JSON.stringify(a));
  }
  getApproval(id: string) {
    const r = this.row<{ json: string }>("SELECT json FROM approvals WHERE id = ?", id);
    return r ? (JSON.parse(r.json) as Approval) : undefined;
  }
  approvalsFor(principalId: string, status?: Approval["status"]) {
    const rows = status
      ? this.rows<{ json: string }>("SELECT json FROM approvals WHERE principal_id = ? AND status = ? ORDER BY rowid", principalId, status)
      : this.rows<{ json: string }>("SELECT json FROM approvals WHERE principal_id = ? ORDER BY rowid", principalId);
    return rows.map((x) => JSON.parse(x.json) as Approval);
  }

  // ───────── intents ─────────
  private intentInserts = 0;
  putIntent(r: IntentRecord) {
    this.db.prepare("INSERT INTO intents (principal_id, ts, json) VALUES (?, ?, ?)").run(r.intent.principalId, r.ts, JSON.stringify(r));
    // trim to the last 5000 per principal, but only every 500 inserts: the trim scans the principal's rows
    if (++this.intentInserts % 500 === 0) {
      this.db.prepare("DELETE FROM intents WHERE principal_id = ? AND seq NOT IN (SELECT seq FROM intents WHERE principal_id = ? ORDER BY seq DESC LIMIT 5000)").run(r.intent.principalId, r.intent.principalId);
    }
  }
  recentIntents(principalId: string, n: number) {
    return this.rows<{ json: string }>("SELECT json FROM intents WHERE principal_id = ? ORDER BY seq DESC LIMIT ?", principalId, n)
      .map((x) => JSON.parse(x.json) as IntentRecord)
      .reverse();
  }

  // ───────── policy versions ─────────
  policyVersions(principalId: string) {
    return this.rows<{ json: string }>("SELECT json FROM policies WHERE principal_id = ? ORDER BY version", principalId).map((x) => JSON.parse(x.json) as PolicyVersion);
  }
  addPolicyVersion(principalId: string, v: PolicyVersion) {
    this.db.prepare("INSERT INTO policies (principal_id, version, json) VALUES (?, ?, ?)").run(principalId, v.version, JSON.stringify(v));
  }
  principalsWithPolicies() {
    return this.rows<{ principal_id: string }>("SELECT DISTINCT principal_id FROM policies ORDER BY principal_id").map((x) => x.principal_id);
  }

  // ───────── subscriptions ─────────
  putSubscription(s: Subscription) {
    this.db.prepare("INSERT INTO subscriptions (id, principal_id, status, json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json").run(s.id, s.principalId, s.status, JSON.stringify(s));
  }
  getSubscription(id: string) {
    const r = this.row<{ json: string }>("SELECT json FROM subscriptions WHERE id = ?", id);
    return r ? (JSON.parse(r.json) as Subscription) : undefined;
  }
  subscriptionsFor(principalId: string) {
    return this.rows<{ json: string }>("SELECT json FROM subscriptions WHERE principal_id = ? ORDER BY rowid", principalId).map((x) => JSON.parse(x.json) as Subscription);
  }

  // ───────── pre-approvals ─────────
  putPreApproval(p: PreApprovalRecord) {
    this.db.prepare("INSERT INTO preapprovals (digest, principal_id, state, json) VALUES (?, ?, ?, ?) ON CONFLICT(digest) DO UPDATE SET state = excluded.state, json = excluded.json").run(p.digest, p.principalId, p.state, JSON.stringify(p));
  }
  getPreApproval(digest: string) {
    const r = this.row<{ json: string }>("SELECT json FROM preapprovals WHERE digest = ?", digest);
    return r ? (JSON.parse(r.json) as PreApprovalRecord) : undefined;
  }
  pendingPreApprovals(principalId?: string) {
    const rows = principalId
      ? this.rows<{ json: string }>("SELECT json FROM preapprovals WHERE state = 'pending' AND principal_id = ? ORDER BY rowid", principalId)
      : this.rows<{ json: string }>("SELECT json FROM preapprovals WHERE state = 'pending' ORDER BY rowid");
    return rows.map((x) => JSON.parse(x.json) as PreApprovalRecord);
  }

  // ───────── kill switch ─────────
  killSwitch(principalId: string) {
    const r = this.row<{ on_flag: bigint }>("SELECT on_flag FROM killswitch WHERE principal_id = ?", principalId);
    return !!r && r.on_flag !== 0n;
  }
  setKillSwitch(principalId: string, on: boolean) {
    this.db.prepare("INSERT INTO killswitch (principal_id, on_flag) VALUES (?, ?) ON CONFLICT(principal_id) DO UPDATE SET on_flag = excluded.on_flag").run(principalId, on ? 1 : 0);
  }

  // ───────── anchors ─────────
  anchorsList() {
    return this.rows<{ json: string }>("SELECT json FROM anchors ORDER BY seq").map((x) => JSON.parse(x.json) as AnchorRecord);
  }
  addAnchor(a: AnchorRecord) {
    this.db.prepare("INSERT INTO anchors (json) VALUES (?)").run(JSON.stringify(a));
  }

  close() {
    this.db.close();
  }
}
