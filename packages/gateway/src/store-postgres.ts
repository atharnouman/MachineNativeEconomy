import { createHash } from "node:crypto";
import pg from "pg";
import type { Receipt, ReceiptKind, SpendLedgerView, Approval, PolicyVersion, Subscription, Decision } from "@spendmarshal/core";
import { IDEMPOTENCY_TTL_MS, ChainConflict, type Store, type RegisteredCredential, type AnchorRecord, type LedgerEntry, type IntentRecord, type PreApprovalRecord, type IdempotentRecord, type NonceLock } from "./store.js";
import { decideOnFigures, type LedgerAnswer, type LedgerQuestion } from "./ledger-figures.js";

/** Versioned migrations, applied in order at startup and recorded in `schema_migrations` (ADR-0025). Never edit an applied one. */
export const POSTGRES_MIGRATIONS: ReadonlyArray<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: "initial schema",
    sql: `
CREATE TABLE receipts (
  principal_id text NOT NULL, seq bigint NOT NULL, id text NOT NULL UNIQUE, ts text NOT NULL, kind text NOT NULL, json text NOT NULL,
  PRIMARY KEY (principal_id, seq)
);
CREATE INDEX receipts_principal_kind ON receipts (principal_id, kind, seq);
CREATE TABLE credentials (id text PRIMARY KEY, principal_id text NOT NULL, json text NOT NULL, created bigserial NOT NULL);
CREATE INDEX credentials_principal ON credentials (principal_id, created);
CREATE TABLE ledger (
  id text PRIMARY KEY, principal_id text NOT NULL, ts text NOT NULL, intent_id text NOT NULL, agent_id text NOT NULL, root_agent_id text NOT NULL,
  credential_ids text[] NOT NULL, budget_ids text[] NOT NULL, amount numeric(78, 0) NOT NULL, state text NOT NULL, settled_at text, tx_hash text,
  created bigserial NOT NULL
);
CREATE INDEX ledger_principal_ts ON ledger (principal_id, ts);
CREATE INDEX ledger_credentials ON ledger USING gin (credential_ids);
CREATE INDEX ledger_budgets ON ledger USING gin (budget_ids);
CREATE TABLE approvals (id text PRIMARY KEY, principal_id text NOT NULL, status text NOT NULL, json text NOT NULL, created bigserial NOT NULL);
CREATE INDEX approvals_principal_status ON approvals (principal_id, status, created);
CREATE TABLE intents (seq bigserial PRIMARY KEY, principal_id text NOT NULL, ts text NOT NULL, json text NOT NULL);
CREATE INDEX intents_principal ON intents (principal_id, seq);
CREATE TABLE policies (principal_id text NOT NULL, version integer NOT NULL, json text NOT NULL, PRIMARY KEY (principal_id, version));
CREATE TABLE subscriptions (id text PRIMARY KEY, principal_id text NOT NULL, status text NOT NULL, json text NOT NULL, created bigserial NOT NULL);
CREATE INDEX subscriptions_principal ON subscriptions (principal_id, created);
CREATE TABLE preapprovals (digest text PRIMARY KEY, principal_id text NOT NULL, state text NOT NULL, json text NOT NULL, created bigserial NOT NULL);
CREATE INDEX preapprovals_state ON preapprovals (state, principal_id, created);
CREATE TABLE killswitch (principal_id text PRIMARY KEY, on_flag boolean NOT NULL);
CREATE TABLE anchors (seq bigserial PRIMARY KEY, principal_id text, json text NOT NULL);
CREATE INDEX anchors_principal ON anchors (principal_id, seq);
CREATE TABLE idempotency (scope text NOT NULL, key text NOT NULL, created_at text NOT NULL, status integer NOT NULL, json text NOT NULL, PRIMARY KEY (scope, key));
CREATE INDEX idempotency_created ON idempotency (created_at);
CREATE TABLE leases (name text PRIMARY KEY, holder text NOT NULL, until timestamptz NOT NULL);
CREATE TABLE relayer_nonces (chain_id bigint NOT NULL, address text NOT NULL, next_nonce bigint NOT NULL, PRIMARY KEY (chain_id, address));
`,
  },
];

const checksum = (sql: string) => createHash("sha256").update(sql).digest("hex");
const UNIQUE_VIOLATION = "23505";

type Queryable = Pick<pg.PoolClient, "query">;

/**
 * Postgres driver, for several gateway instances on one database (ADR-0025). Each check-then-act runs in one transaction;
 * the ones that read more than one row hold an advisory lock named after the principal (the ledger) or the key (the
 * gateway key's nonces). Leases and their expiry use the database's clock, so the instances' clocks do not matter.
 */
export class PostgresStore implements Store, NonceLock {
  private idempotencyInserts = 0;
  private intentInserts = 0;

  private constructor(private readonly pool: pg.Pool) {}

  /** Connects, applies pending migrations under an advisory lock, and returns the store. */
  static async open(databaseUrl: string): Promise<PostgresStore> {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    pool.on("error", () => undefined); // an idle client that dies is replaced on the next query
    const store = new PostgresStore(pool);
    try {
      await store.migrate();
    } catch (err) {
      await pool.end();
      throw err;
    }
    return store;
  }

  private async migrate() {
    const c = await this.pool.connect();
    try {
      await c.query("SELECT pg_advisory_lock(hashtextextended('spendmarshal:migrations', 0))");
      await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
      const applied = new Map((await c.query<{ version: number; checksum: string }>("SELECT version, checksum FROM schema_migrations")).rows.map((r) => [r.version, r.checksum]));
      const latest = POSTGRES_MIGRATIONS[POSTGRES_MIGRATIONS.length - 1]!.version;
      const newest = Math.max(0, ...applied.keys());
      if (newest > latest) throw new Error(`the Postgres store is at schema version ${newest}, newer than this gateway knows (${latest})`);
      for (const m of POSTGRES_MIGRATIONS) {
        const done = applied.get(m.version);
        if (done !== undefined) {
          if (done !== checksum(m.sql)) throw new Error(`migration ${m.version} (${m.name}) has changed since it was applied to this database`);
          continue;
        }
        await c.query("BEGIN");
        try {
          await c.query(m.sql);
          await c.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [m.version, m.name, checksum(m.sql)]);
          await c.query("COMMIT");
        } catch (err) {
          await c.query("ROLLBACK");
          throw err;
        }
      }
    } finally {
      await c.query("SELECT pg_advisory_unlock(hashtextextended('spendmarshal:migrations', 0))").catch(() => undefined);
      c.release(true); // closed, not pooled: the session lock can never outlive this
    }
  }

  private async tx<T>(run: (c: Queryable) => Promise<T>, mode = ""): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query(mode ? `BEGIN ISOLATION LEVEL ${mode}` : "BEGIN");
      const result = await run(c);
      await c.query("COMMIT");
      return result;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  private async rows<T extends pg.QueryResultRow>(sql: string, params: unknown[] = [], c: Queryable = this.pool): Promise<T[]> {
    return (await c.query<T>(sql, params)).rows;
  }
  private async json<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.rows<{ json: string }>(sql, params)).map((r) => JSON.parse(r.json) as T);
  }
  private async one<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.json<T>(sql, params))[0];
  }

  // ───────── receipts ─────────
  async appendReceipt(r: Receipt) {
    try {
      await this.pool.query("INSERT INTO receipts (principal_id, seq, id, ts, kind, json) VALUES ($1, $2, $3, $4, $5, $6)", [r.principalId, r.seq, r.id, r.ts, r.kind, JSON.stringify(r)]);
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code === UNIQUE_VIOLATION && e.constraint === "receipts_pkey") throw new ChainConflict(r.principalId, r.seq);
      throw err;
    }
  }
  receiptsFor(principalId: string) {
    return this.json<Receipt>("SELECT json FROM receipts WHERE principal_id = $1 ORDER BY seq", [principalId]);
  }
  lastReceipt(principalId: string) {
    return this.one<Receipt>("SELECT json FROM receipts WHERE principal_id = $1 ORDER BY seq DESC LIMIT 1", [principalId]);
  }
  receiptsOfKind(principalId: string, kinds: readonly ReceiptKind[]) {
    return this.json<Receipt>("SELECT json FROM receipts WHERE principal_id = $1 AND kind = ANY($2::text[]) ORDER BY seq", [principalId, kinds]);
  }

  // ───────── idempotency ─────────
  async getIdempotent(scope: string, key: string) {
    const r = (await this.rows<{ json: string; created_at: string }>("SELECT json, created_at FROM idempotency WHERE scope = $1 AND key = $2", [scope, key]))[0];
    if (!r || Date.now() - Date.parse(r.created_at) > IDEMPOTENCY_TTL_MS) return undefined;
    return JSON.parse(r.json) as IdempotentRecord;
  }
  async putIdempotent(rec: IdempotentRecord) {
    await this.pool.query("INSERT INTO idempotency (scope, key, created_at, status, json) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (scope, key) DO UPDATE SET created_at = excluded.created_at, status = excluded.status, json = excluded.json", [rec.scope, rec.key, rec.createdAt, rec.status, JSON.stringify(rec)]);
    if (++this.idempotencyInserts % 200 === 0) await this.pool.query("DELETE FROM idempotency WHERE created_at < $1", [new Date(Date.now() - IDEMPOTENCY_TTL_MS).toISOString()]);
  }

  // ───────── credentials ─────────
  getCredential(id: string) {
    return this.one<RegisteredCredential>("SELECT json FROM credentials WHERE id = $1", [id]);
  }
  async putCredential(c: RegisteredCredential) {
    await this.pool.query("INSERT INTO credentials (id, principal_id, json) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET json = excluded.json", [c.id, c.principalId, JSON.stringify(c)]);
  }
  credentialsFor(principalId: string) {
    return this.json<RegisteredCredential>("SELECT json FROM credentials WHERE principal_id = $1 ORDER BY created", [principalId]);
  }

  // ───────── ledger ─────────
  /** Answers each question with one aggregate, all in one round trip. */
  private async figures(c: Queryable, principalId: string, questions: LedgerQuestion[]): Promise<LedgerAnswer[]> {
    const params: unknown[] = [principalId];
    const p = (v: unknown) => `$${params.push(v)}`;
    const filterFor = (q: LedgerQuestion): string => {
      if (q.kind === "budget") return `budget_ids @> ARRAY[${p(q.id)}::text]`;
      if (q.kind === "credential" || q.scope === "credential") return `credential_ids @> ARRAY[${p(q.id)}::text]`;
      return q.scope === "agent" ? `root_agent_id = ${p(q.id)}` : `principal_id = ${p(q.id)}`;
    };
    const parts = questions.map((q, i) => {
      const filter = filterFor(q);
      const since = q.since === null ? "" : ` AND ts >= ${p(q.since)}`;
      return `SELECT ${i} AS i, count(*)::bigint AS n, coalesce(sum(amount), 0)::text AS s FROM ledger WHERE principal_id = $1 AND state <> 'released' AND ${filter}${since}`;
    });
    const got = await this.rows<{ i: number; n: string; s: string }>(parts.join(" UNION ALL "), params, c);
    const out: LedgerAnswer[] = questions.map(() => ({ count: 0, amount: 0n }));
    for (const r of got) out[Number(r.i)] = { count: Number(r.n), amount: BigInt(r.s) };
    return out;
  }

  async reserveIf(e: Omit<LedgerEntry, "state">, decide: (ledger: SpendLedgerView) => Decision) {
    return this.tx(async (c) => {
      // reservations of one principal take turns; other principals never wait
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`ledger:${e.principalId}`]);
      const decision = await decideOnFigures(decide, (qs) => this.figures(c, e.principalId, qs));
      if (decision.effect !== "allow") return { decision };
      await c.query("INSERT INTO ledger (id, principal_id, ts, intent_id, agent_id, root_agent_id, credential_ids, budget_ids, amount, state) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'reserved')", [e.id, e.principalId, e.ts, e.intentId, e.agentId, e.rootAgentId, e.credentialIds, e.budgetIds, e.amount]);
      const entry: LedgerEntry = { ...e, state: "reserved" };
      return { decision, entry };
    });
  }
  async withLedger<T>(principalId: string, read: (ledger: SpendLedgerView) => T): Promise<T> {
    return this.tx((c) => decideOnFigures(read, (qs) => this.figures(c, principalId, qs)), "REPEATABLE READ READ ONLY");
  }
  async settle(id: string, txHash: string, settledAt: string) {
    const r = await this.pool.query("UPDATE ledger SET state = 'settled', tx_hash = $1, settled_at = $2 WHERE id = $3", [txHash, settledAt, id]);
    if (r.rowCount === 0) throw new Error(`ledger entry ${id} not found`);
  }
  async release(id: string) {
    const r = await this.pool.query("UPDATE ledger SET state = 'released' WHERE id = $1", [id]);
    if (r.rowCount === 0) throw new Error(`ledger entry ${id} not found`);
  }
  async ledgerEntries(principalId: string): Promise<LedgerEntry[]> {
    const rows = await this.rows<{ id: string; principal_id: string; ts: string; intent_id: string; agent_id: string; root_agent_id: string; credential_ids: string[]; budget_ids: string[]; amount: string; state: LedgerEntry["state"]; settled_at: string | null; tx_hash: string | null }>(
      "SELECT id, principal_id, ts, intent_id, agent_id, root_agent_id, credential_ids, budget_ids, amount::text AS amount, state, settled_at, tx_hash FROM ledger WHERE principal_id = $1 ORDER BY created",
      [principalId],
    );
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      principalId: r.principal_id,
      intentId: r.intent_id,
      agentId: r.agent_id,
      rootAgentId: r.root_agent_id,
      credentialIds: r.credential_ids,
      budgetIds: r.budget_ids,
      amount: r.amount,
      state: r.state,
      ...(r.settled_at ? { settledAt: r.settled_at } : {}),
      ...(r.tx_hash ? { txHash: r.tx_hash } : {}),
    }));
  }
  async spent(principalId: string) {
    const totals = async (column: "credential_ids" | "budget_ids") =>
      Object.fromEntries((await this.rows<{ k: string; s: string }>(`SELECT k, sum(amount)::text AS s FROM ledger, unnest(${column}) AS k WHERE principal_id = $1 AND state = 'settled' GROUP BY k`, [principalId])).map((r) => [r.k, r.s]));
    return { byCredential: await totals("credential_ids"), byBudget: await totals("budget_ids") };
  }

  // ───────── approvals ─────────
  async putApproval(a: Approval) {
    await this.pool.query("INSERT INTO approvals (id, principal_id, status, json) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET status = excluded.status, json = excluded.json", [a.id, a.principalId, a.status, JSON.stringify(a)]);
  }
  async transitionApproval(next: Approval, from: readonly Approval["status"][]) {
    const r = await this.pool.query("UPDATE approvals SET status = $1, json = $2 WHERE id = $3 AND status = ANY($4::text[])", [next.status, JSON.stringify(next), next.id, from]);
    return r.rowCount === 1;
  }
  getApproval(id: string) {
    return this.one<Approval>("SELECT json FROM approvals WHERE id = $1", [id]);
  }
  approvalsFor(principalId: string, status?: Approval["status"]) {
    return status
      ? this.json<Approval>("SELECT json FROM approvals WHERE principal_id = $1 AND status = $2 ORDER BY created", [principalId, status])
      : this.json<Approval>("SELECT json FROM approvals WHERE principal_id = $1 ORDER BY created", [principalId]);
  }

  // ───────── intents ─────────
  async putIntent(r: IntentRecord) {
    await this.pool.query("INSERT INTO intents (principal_id, ts, json) VALUES ($1, $2, $3)", [r.intent.principalId, r.ts, JSON.stringify(r)]);
    // keep the last 5000 per principal, trimmed every 500 inserts: the trim scans the principal's rows
    if (++this.intentInserts % 500 === 0) {
      await this.pool.query("DELETE FROM intents WHERE principal_id = $1 AND seq < (SELECT seq FROM intents WHERE principal_id = $1 ORDER BY seq DESC OFFSET 4999 LIMIT 1)", [r.intent.principalId]);
    }
  }
  async recentIntents(principalId: string, n: number) {
    return (await this.json<IntentRecord>("SELECT json FROM intents WHERE principal_id = $1 ORDER BY seq DESC LIMIT $2", [principalId, n])).reverse();
  }

  // ───────── policy versions ─────────
  policyVersions(principalId: string) {
    return this.json<PolicyVersion>("SELECT json FROM policies WHERE principal_id = $1 ORDER BY version", [principalId]);
  }
  async addPolicyVersion(principalId: string, v: PolicyVersion) {
    const r = await this.pool.query("INSERT INTO policies (principal_id, version, json) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [principalId, v.version, JSON.stringify(v)]);
    return r.rowCount === 1;
  }
  async principalsWithPolicies() {
    return (await this.rows<{ principal_id: string }>("SELECT DISTINCT principal_id FROM policies ORDER BY principal_id")).map((r) => r.principal_id);
  }

  // ───────── subscriptions ─────────
  async putSubscription(s: Subscription) {
    await this.pool.query("INSERT INTO subscriptions (id, principal_id, status, json) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET status = excluded.status, json = excluded.json", [s.id, s.principalId, s.status, JSON.stringify(s)]);
  }
  getSubscription(id: string) {
    return this.one<Subscription>("SELECT json FROM subscriptions WHERE id = $1", [id]);
  }
  subscriptionsFor(principalId: string) {
    return this.json<Subscription>("SELECT json FROM subscriptions WHERE principal_id = $1 ORDER BY created", [principalId]);
  }

  // ───────── pre-approvals ─────────
  async putPreApproval(p: PreApprovalRecord) {
    await this.pool.query("INSERT INTO preapprovals (digest, principal_id, state, json) VALUES ($1, $2, $3, $4) ON CONFLICT (digest) DO UPDATE SET state = excluded.state, json = excluded.json", [p.digest, p.principalId, p.state, JSON.stringify(p)]);
  }
  getPreApproval(digest: string) {
    return this.one<PreApprovalRecord>("SELECT json FROM preapprovals WHERE digest = $1", [digest]);
  }
  pendingPreApprovals(principalId?: string) {
    return principalId
      ? this.json<PreApprovalRecord>("SELECT json FROM preapprovals WHERE state = 'pending' AND principal_id = $1 ORDER BY created", [principalId])
      : this.json<PreApprovalRecord>("SELECT json FROM preapprovals WHERE state = 'pending' ORDER BY created");
  }

  // ───────── kill switch ─────────
  async killSwitch(principalId: string) {
    return (await this.rows<{ on_flag: boolean }>("SELECT on_flag FROM killswitch WHERE principal_id = $1", [principalId]))[0]?.on_flag ?? false;
  }
  async setKillSwitch(principalId: string, on: boolean) {
    await this.pool.query("INSERT INTO killswitch (principal_id, on_flag) VALUES ($1, $2) ON CONFLICT (principal_id) DO UPDATE SET on_flag = excluded.on_flag", [principalId, on]);
  }

  // ───────── anchors ─────────
  anchorsList(principalId?: string) {
    return principalId === undefined ? this.json<AnchorRecord>("SELECT json FROM anchors ORDER BY seq") : this.json<AnchorRecord>("SELECT json FROM anchors WHERE principal_id = $1 ORDER BY seq", [principalId]);
  }
  async addAnchor(a: AnchorRecord) {
    await this.pool.query("INSERT INTO anchors (principal_id, json) VALUES ($1, $2)", [a.principalId ?? null, JSON.stringify(a)]);
  }

  // ───────── leases ─────────
  async acquireLease(name: string, holder: string, ttlMs: number) {
    const r = await this.pool.query(
      "INSERT INTO leases (name, holder, until) VALUES ($1, $2, now() + make_interval(secs => $3::double precision / 1000)) ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, until = excluded.until WHERE leases.until <= now() OR leases.holder = excluded.holder",
      [name, holder, ttlMs],
    );
    return r.rowCount === 1;
  }
  async releaseLease(name: string, holder: string) {
    await this.pool.query("DELETE FROM leases WHERE name = $1 AND holder = $2", [name, holder]);
  }

  // ───────── the gateway key's nonces ─────────
  async withNonce<T>(chainId: number, address: string, send: (atLeast: number) => Promise<{ nonce: number; result: T }>): Promise<T> {
    const key = address.toLowerCase();
    return this.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`nonce:${chainId}:${key}`]);
      const row = (await this.rows<{ next_nonce: string }>("SELECT next_nonce FROM relayer_nonces WHERE chain_id = $1 AND address = $2", [chainId, key], c))[0];
      const { nonce, result } = await send(row ? Number(row.next_nonce) : 0);
      await c.query("INSERT INTO relayer_nonces (chain_id, address, next_nonce) VALUES ($1, $2, $3) ON CONFLICT (chain_id, address) DO UPDATE SET next_nonce = GREATEST(relayer_nonces.next_nonce, excluded.next_nonce)", [chainId, key, nonce + 1]);
      return result;
    });
  }

  async close() {
    await this.pool.end();
  }
}
