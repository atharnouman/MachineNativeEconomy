import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { verifyChain, type Approval, type Decision, type PolicyVersion, type SpendLedgerView } from "@spendmarshal/core";
import { openStore, ChainConflict, type LedgerEntry, type Store, type StoreOptions } from "../src/store.js";
import { SQLITE_MIGRATIONS } from "../src/store-sqlite.js";
import { LocalSigner } from "../src/signer.js";
import { ReceiptLog } from "../src/receipts.js";
import { Metrics } from "../src/metrics.js";
import { drivers, freshStoreOptions } from "./drivers.js";

const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const entry = (over: Partial<Omit<LedgerEntry, "state">> = {}): Omit<LedgerEntry, "state"> => ({
  id: `led_${Math.random().toString(16).slice(2)}`,
  ts: new Date().toISOString(),
  principalId: "p",
  intentId: "int",
  agentId: "child",
  rootAgentId: "root-agent",
  credentialIds: ["root", "child"],
  budgetIds: ["team", "org"],
  amount: "100",
  ...over,
});

const decision = (effect: Decision["effect"]): Decision => ({ effect, reasons: [], checks: [], matchedRules: [], budgetPath: [], policyHash: "0x00", amount: "0" });
const allow = () => decision("allow");
/** Reserves unconditionally (the decision allows whatever the ledger says). */
const reserve = async (s: Store, e: Omit<LedgerEntry, "state">) => (await s.reserveIf(e, allow)).entry!;
/** A figure read from the principal's ledger, inside the store's own read step. */
const figure = <T>(s: Store, principalId: string, read: (v: SpendLedgerView) => T) => s.withLedger(principalId, read);

const approval = (over: Partial<Approval> = {}): Approval => ({
  v: 1,
  id: "apr_1",
  principalId: "p",
  intentId: "i",
  intentHash: `0x${"ab".repeat(32)}`,
  credentialId: "c",
  agentId: "a",
  amount: "1",
  token: "0x",
  chain: "eip155:1",
  payee: { host: "h", url: "http://h/x" },
  resource: "/x",
  purpose: "r",
  rail: "x402",
  reasons: [],
  status: "pending",
  requestedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...over,
});

for (const driver of drivers()) {
  const fresh = async (label = "store") => openStore(await freshStoreOptions(driver, label));
  /** Two handles on one store, as two gateway instances would hold (JSON has one process, so one handle twice). */
  const twoHandles = async (label: string): Promise<[Store, Store]> => {
    const opts: StoreOptions = await freshStoreOptions(driver, label);
    const a = await openStore(opts);
    return [a, driver === "json" ? a : await openStore(opts)];
  };

  describe(`Store ledger [${driver}]`, () => {
    it("reserves, settles and releases against credential lineage and budgets", async () => {
      const s = await fresh();
      const a = await reserve(s, entry());
      expect(await figure(s, "p", (v) => v.spentByCredential("root"))).toBe(100n); // reserved counts
      expect(await figure(s, "p", (v) => v.spentByBudget("team"))).toBe(100n);
      await s.release(a.id);
      expect(await figure(s, "p", (v) => v.spentByCredential("child"))).toBe(0n);
      const b = await reserve(s, entry({ amount: "40" }));
      await s.settle(b.id, "0xabc", new Date().toISOString());
      expect(await figure(s, "p", (v) => v.spentByCredential("root"))).toBe(40n);
      expect((await s.spent("p")).byBudget).toEqual({ team: "40", org: "40" });
      const entries = await s.ledgerEntries("p");
      expect(entries.map((e) => e.state)).toEqual(["released", "settled"]);
      expect(entries[1]!.credentialIds).toEqual(["root", "child"]);
      expect(entries[1]!.budgetIds).toEqual(["team", "org"]);
      expect(entries[1]!.txHash).toBe("0xabc");
      await expect(s.settle("missing", "0x", new Date().toISOString())).rejects.toThrow();
      await s.close();
    });

    it("evaluates windows and activity by scope", async () => {
      const s = await fresh();
      const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
      const now = new Date().toISOString();
      await reserve(s, entry({ ts: old, amount: "10" }));
      await reserve(s, entry({ ts: now, amount: "20" }));
      await reserve(s, entry({ ts: now, amount: "5", rootAgentId: "other-agent", credentialIds: ["x"], budgetIds: ["org"] }));
      const hourAgo = new Date(Date.now() - 3_600_000);
      const figures = await figure(s, "p", (v) => ({
        org: v.spentByBudget("org"),
        orgHour: v.spentByBudget("org", hourAgo),
        rootHour: v.spentByCredential("root", hourAgo),
        child: v.activity("credential", "child", hourAgo),
        agent: v.activity("agent", "root-agent", hourAgo),
        principal: v.activity("principal", "p", hourAgo),
      }));
      expect(figures).toEqual({ org: 35n, orgHour: 25n, rootHour: 20n, child: { count: 1, amount: 20n }, agent: { count: 1, amount: 20n }, principal: { count: 2, amount: 25n } });
      await s.close();
    });

    it("keeps principals apart: the same budget name or agent id in two principals never shares spend", async () => {
      const s = await fresh();
      const hourAgo = new Date(Date.now() - 3_600_000);
      await reserve(s, entry({ principalId: "acme", amount: "50" }));
      const g = await reserve(s, entry({ principalId: "globex", amount: "7" }));
      await s.settle(g.id, "0x1", new Date().toISOString());
      expect(await figure(s, "acme", (v) => [v.spentByBudget("org"), v.spentByCredential("root"), v.activity("agent", "root-agent", hourAgo)])).toEqual([50n, 50n, { count: 1, amount: 50n }]);
      expect(await figure(s, "globex", (v) => [v.spentByBudget("org"), v.activity("agent", "root-agent", hourAgo)])).toEqual([7n, { count: 1, amount: 7n }]);
      expect(await figure(s, "nobody", (v) => v.spentByBudget("org"))).toBe(0n);
      expect((await s.spent("globex")).byBudget).toEqual({ team: "7", org: "7" });
      expect((await s.spent("acme")).byBudget).toEqual({});
      await s.close();
    });

    it("reserves only what the decision allows, deciding on the ledger as it is at that moment", async () => {
      const s = await fresh();
      const denied = await s.reserveIf(entry(), () => decision("deny"));
      expect(denied.entry).toBeUndefined();
      expect(denied.decision.effect).toBe("deny");
      // a cap of 250 at 100 a payment: of six concurrent reservations exactly two fit
      const capped = (v: SpendLedgerView) => decision(v.spentByBudget("org") + 100n <= 250n ? "allow" : "deny");
      const results = await Promise.all(Array.from({ length: 6 }, () => s.reserveIf(entry(), capped)));
      expect(results.filter((r) => r.entry).length).toBe(2);
      expect(await figure(s, "p", (v) => v.spentByBudget("org"))).toBe(200n);
      expect(await s.ledgerEntries("p")).toHaveLength(2);
      await s.close();
    });

    it("lists anchors per principal, so an evidence bundle never carries another tenant's", async () => {
      const s = await fresh();
      await s.addAnchor({ principalId: "acme", head: "0xa1", count: 3, txHash: "0x1", blockNumber: "1", registry: "0x9" });
      await s.addAnchor({ principalId: "globex", head: "0xb1", count: 5, txHash: "0x2", blockNumber: "2", registry: "0x9" });
      await s.addAnchor({ principalId: "acme", head: "0xa2", count: 7, txHash: "0x3", blockNumber: "3", registry: "0x9" });
      expect((await s.anchorsList("acme")).map((a) => a.head)).toEqual(["0xa1", "0xa2"]);
      expect((await s.anchorsList("globex")).map((a) => a.head)).toEqual(["0xb1"]);
      expect(await s.anchorsList()).toHaveLength(3);
      await s.close();
    });

    it("keeps big amounts exact (sums stay within signed 64-bit, i.e. below 2^63 base units)", async () => {
      const s = await fresh();
      const big = (2n ** 61n).toString(); // far beyond any real stablecoin supply; still well inside int64 when summed
      await reserve(s, entry({ amount: big }));
      await reserve(s, entry({ amount: big }));
      expect(await figure(s, "p", (v) => v.spentByBudget("org"))).toBe(2n ** 62n);
      expect((await s.spent("p")).byBudget.org).toBeUndefined(); // reserved, not settled
      await s.close();
    });

    it("persists across instances and round-trips the other records", async () => {
      const opts = await freshStoreOptions(driver, "persist");
      const a = await openStore(opts);
      await a.setKillSwitch("p", true);
      const e = await reserve(a, entry({ amount: "7", budgetIds: ["b"] }));
      await a.settle(e.id, "0x1", new Date().toISOString());
      await a.putApproval(approval());
      await a.addPolicyVersion("p", { version: 1, hash: `0x${"00".repeat(32)}`, prevHash: null, activatedAt: new Date().toISOString(), document: { version: 1, principalId: "p", currency: { asset: "USDC", decimals: 6 }, budgets: {}, agents: {}, velocity: [], rules: [] } });
      await a.addAnchor({ head: "0x1", count: 1, txHash: "0x2", blockNumber: "3", registry: "0x4" });
      for (let i = 0; i < 3; i++) await a.putIntent({ intent: { v: 1, id: `int_${i}`, principalId: "p", agentId: "a", credentialId: "c", payee: { url: "http://h/x", host: "h" }, resource: "/x", maxAmount: { asset: "USDC", chain: "eip155:1", token: "0x0000000000000000000000000000000000000001", value: "1", decimals: 6 }, purpose: "r", rail: "auto", createdAt: new Date().toISOString() }, amount: "1", effect: "allow", ts: new Date().toISOString() });
      await a.close();
      const b = await openStore(opts);
      expect(await b.killSwitch("p")).toBe(true);
      expect(await figure(b, "p", (v) => v.spentByBudget("b"))).toBe(7n);
      expect((await b.getApproval("apr_1"))?.status).toBe("pending");
      expect(await b.approvalsFor("p", "pending")).toHaveLength(1);
      expect(await b.approvalsFor("p", "approved")).toHaveLength(0);
      expect((await b.policyVersions("p")).map((v) => v.version)).toEqual([1]);
      expect(await b.principalsWithPolicies()).toEqual(["p"]);
      expect(await b.anchorsList()).toHaveLength(1);
      expect((await b.recentIntents("p", 2)).map((r) => r.intent.id)).toEqual(["int_1", "int_2"]);
      await b.close();
    });

    it("hands out copies: changing a record read from the store changes nothing until it is written", async () => {
      const s = await fresh();
      await s.putApproval(approval());
      const a = (await s.getApproval("apr_1"))!;
      a.status = "approved";
      expect((await s.getApproval("apr_1"))?.status).toBe("pending");
      await s.close();
    });
  });

  describe(`Store operations for several writers [${driver}]`, () => {
    it("changes an approval only while it has the expected status, so one of two resolutions wins", async () => {
      const s = await fresh();
      await s.putApproval(approval());
      const [first, second] = await Promise.all([s.transitionApproval(approval({ status: "approved" }), ["pending"]), s.transitionApproval(approval({ status: "rejected" }), ["pending"])]);
      expect([first, second].filter(Boolean)).toHaveLength(1);
      expect((await s.getApproval("apr_1"))?.status).toBe(first ? "approved" : "rejected");
      expect(await s.transitionApproval(approval({ status: "consumed" }), ["pending"])).toBe(false);
      expect(await s.transitionApproval(approval({ id: "apr_missing", status: "approved" }), ["pending"])).toBe(false);
      await s.close();
    });

    it("refuses a policy version number that is already taken", async () => {
      const s = await fresh();
      const v = (hash: string): PolicyVersion => ({ version: 1, hash: `0x${hash.repeat(64)}`, prevHash: null, activatedAt: new Date().toISOString(), document: { version: 1, principalId: "p", currency: { asset: "USDC", decimals: 6 }, budgets: {}, agents: {}, velocity: [], rules: [] } });
      expect(await s.addPolicyVersion("p", v("a"))).toBe(true);
      expect(await s.addPolicyVersion("p", v("b"))).toBe(false);
      expect((await s.policyVersions("p")).map((x) => x.hash)).toEqual([`0x${"a".repeat(64)}`]);
      expect(await s.addPolicyVersion("q", v("b"))).toBe(true); // numbers are per principal
      await s.close();
    });

    it("gives a lease to one holder at a time, until it is released or expires", async () => {
      const s = await fresh();
      expect(await s.acquireLease("x", "a", 60_000)).toBe(true);
      expect(await s.acquireLease("x", "b", 60_000)).toBe(false);
      expect(await s.acquireLease("x", "a", 60_000)).toBe(true); // the holder may renew it
      await s.releaseLease("x", "b"); // not b's to release
      expect(await s.acquireLease("x", "b", 60_000)).toBe(false);
      await s.releaseLease("x", "a");
      expect(await s.acquireLease("x", "b", 50)).toBe(true);
      await new Promise((r) => setTimeout(r, 120));
      expect(await s.acquireLease("x", "c", 60_000)).toBe(true); // b's lease expired
      expect(await s.acquireLease("y", "b", 60_000)).toBe(true); // leases are independent
      await s.close();
    });

    it("refuses a receipt whose sequence number is taken", async () => {
      const s = await fresh();
      const log = new ReceiptLog(s, new LocalSigner(PK, "secret"));
      const r = await log.append("p", "external", { n: 1 });
      await expect(s.appendReceipt({ ...r, id: "rcpt_other" })).rejects.toBeInstanceOf(ChainConflict);
      expect(await s.receiptsFor("p")).toHaveLength(1);
      await s.close();
    });

    it("keeps one linear chain when two receipt logs write to the same store at once", async () => {
      const [a, b] = await twoHandles("two-logs");
      const signer = new LocalSigner(PK, "secret");
      const metrics = new Metrics();
      const logA = new ReceiptLog(a, signer, metrics);
      const logB = new ReceiptLog(b, signer, metrics);
      await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? logA : logB).append("p", "external", { i })));
      const rs = await a.receiptsFor("p");
      expect(rs.map((r) => r.seq)).toEqual([...Array(10).keys()]);
      expect(new Set(rs.map((r) => r.data.i))).toEqual(new Set([...Array(10).keys()]));
      const v = await verifyChain(rs, signer.address);
      expect(v.ok, v.problems.join(";")).toBe(true);
      expect((await metrics.chainConflicts.get()).values[0]?.value ?? 0).toBeGreaterThan(0); // the stale log rebuilt
      await a.close();
      if (b !== a) await b.close();
    });
  });

  describe(`ReceiptLog [${driver}]`, () => {
    it("produces a verifiable, strictly sequential chain even under concurrent appends", async () => {
      const store = await fresh();
      const signer = new LocalSigner(PK, "secret");
      const log = new ReceiptLog(store, signer);
      await Promise.all(Array.from({ length: 12 }, (_, i) => log.append("p", "decision", { i, big: 10n ** 20n })));
      const rs = await store.receiptsFor("p");
      expect(rs.map((r) => r.seq)).toEqual([...Array(12).keys()]);
      const v = await verifyChain(rs, signer.address);
      expect(v.ok, v.problems.join(";")).toBe(true);
      expect(rs[0]!.data.big).toBe("100000000000000000000"); // bigint sanitised to string
      await store.close();
    });
  });
}

describe("SQLite migrations", () => {
  const file = () => join(mkdtempSync(join(tmpdir(), "spendmarshal-migrate-")), "spendmarshal.sqlite");
  it("adopts a file written before migrations were versioned, keeping its data", async () => {
    const path = file();
    const old = new Database(path);
    old.exec(SQLITE_MIGRATIONS[0]!.sql); // the schema as it was, at user_version 0
    old.prepare("INSERT INTO killswitch (principal_id, on_flag) VALUES ('p', 1)").run();
    old.close();
    const s = await openStore({ driver: "sqlite", dataDir: join(path, "..") });
    expect(await s.killSwitch("p")).toBe(true);
    expect(await s.acquireLease("x", "a", 1000)).toBe(true); // the lease table came with version 2
    await s.close();
    const db = new Database(path);
    expect(db.pragma("user_version", { simple: true })).toBe(SQLITE_MIGRATIONS.at(-1)!.version);
    db.close();
  });

  it("refuses a file from a newer gateway", async () => {
    const path = file();
    const db = new Database(path);
    db.pragma("user_version = 99");
    db.close();
    await expect(openStore({ driver: "sqlite", dataDir: join(path, "..") })).rejects.toThrow("the SQLite store is at schema version 99, newer than this gateway knows");
  });
});

describe("LocalSigner", () => {
  it("derives a stable session key per credential", () => {
    const signer = new LocalSigner(PK, "secret");
    const a = signer.sessionKeyAddress("cred_x");
    expect(signer.sessionKeyAddress("cred_x")).toBe(a);
    expect(signer.sessionKeyAddress("cred_y")).not.toBe(a);
    const other = new LocalSigner(PK, "different-secret");
    expect(other.sessionKeyAddress("cred_x")).not.toBe(a);
  });
});
