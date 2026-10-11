import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyChain } from "@spendmarshal/core";
import { openStore, type Store, type StoreDriver } from "../src/store.js";
import { LocalSigner } from "../src/signer.js";
import { ReceiptLog } from "../src/receipts.js";

const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const entry = (over: Partial<Parameters<Store["reserve"]>[0]> = {}) => ({
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

for (const driver of ["json", "sqlite"] as StoreDriver[]) {
  const fresh = () => openStore({ driver, dataDir: mkdtempSync(join(tmpdir(), `spendmarshal-${driver}-`)) });

  describe(`Store ledger [${driver}]`, () => {
    it("reserves, settles and releases against credential lineage and budgets", async () => {
      const s = await fresh();
      const a = s.reserve(entry());
      expect(s.ledgerView("p").spentByCredential("root")).toBe(100n); // reserved counts
      expect(s.ledgerView("p").spentByBudget("team")).toBe(100n);
      s.release(a.id);
      expect(s.ledgerView("p").spentByCredential("child")).toBe(0n);
      const b = s.reserve(entry({ amount: "40" }));
      s.settle(b.id, "0xabc", new Date().toISOString());
      expect(s.ledgerView("p").spentByCredential("root")).toBe(40n);
      expect(s.spent("p").byBudget).toEqual({ team: "40", org: "40" });
      const entries = s.ledgerEntries("p");
      expect(entries.map((e) => e.state)).toEqual(["released", "settled"]);
      expect(entries[1]!.credentialIds).toEqual(["root", "child"]);
      expect(entries[1]!.budgetIds).toEqual(["team", "org"]);
      expect(entries[1]!.txHash).toBe("0xabc");
      expect(() => s.settle("missing", "0x", new Date().toISOString())).toThrow();
      s.close();
    });

    it("evaluates windows and activity by scope", async () => {
      const s = await fresh();
      const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
      const now = new Date().toISOString();
      s.reserve(entry({ ts: old, amount: "10" }));
      s.reserve(entry({ ts: now, amount: "20" }));
      s.reserve(entry({ ts: now, amount: "5", rootAgentId: "other-agent", credentialIds: ["x"], budgetIds: ["org"] }));
      const v = s.ledgerView("p");
      const hourAgo = new Date(Date.now() - 3_600_000);
      expect(v.spentByBudget("org")).toBe(35n);
      expect(v.spentByBudget("org", hourAgo)).toBe(25n);
      expect(v.spentByCredential("root", hourAgo)).toBe(20n);
      expect(v.activity("credential", "child", hourAgo)).toEqual({ count: 1, amount: 20n });
      expect(v.activity("agent", "root-agent", hourAgo)).toEqual({ count: 1, amount: 20n });
      expect(v.activity("principal", "p", hourAgo)).toEqual({ count: 2, amount: 25n });
      s.close();
    });

    it("keeps principals apart: the same budget name or agent id in two principals never shares spend", async () => {
      const s = await fresh();
      const hourAgo = new Date(Date.now() - 3_600_000);
      s.reserve(entry({ principalId: "acme", amount: "50" }));
      const g = s.reserve(entry({ principalId: "globex", amount: "7" }));
      s.settle(g.id, "0x1", new Date().toISOString());
      expect(s.ledgerView("acme").spentByBudget("org")).toBe(50n);
      expect(s.ledgerView("globex").spentByBudget("org")).toBe(7n);
      expect(s.ledgerView("acme").spentByCredential("root")).toBe(50n);
      expect(s.ledgerView("acme").activity("agent", "root-agent", hourAgo)).toEqual({ count: 1, amount: 50n });
      expect(s.ledgerView("globex").activity("agent", "root-agent", hourAgo)).toEqual({ count: 1, amount: 7n });
      expect(s.ledgerView("nobody").spentByBudget("org")).toBe(0n);
      expect(s.spent("globex").byBudget).toEqual({ team: "7", org: "7" });
      expect(s.spent("acme").byBudget).toEqual({});
      s.close();
    });

    it("lists anchors per principal, so an evidence bundle never carries another tenant's", async () => {
      const s = await fresh();
      s.addAnchor({ principalId: "acme", head: "0xa1", count: 3, txHash: "0x1", blockNumber: "1", registry: "0x9" });
      s.addAnchor({ principalId: "globex", head: "0xb1", count: 5, txHash: "0x2", blockNumber: "2", registry: "0x9" });
      s.addAnchor({ principalId: "acme", head: "0xa2", count: 7, txHash: "0x3", blockNumber: "3", registry: "0x9" });
      expect(s.anchorsList("acme").map((a) => a.head)).toEqual(["0xa1", "0xa2"]);
      expect(s.anchorsList("globex").map((a) => a.head)).toEqual(["0xb1"]);
      expect(s.anchorsList()).toHaveLength(3);
      s.close();
    });

    it("keeps big amounts exact (sums stay within signed 64-bit, i.e. below 2^63 base units)", async () => {
      const s = await fresh();
      const big = (2n ** 61n).toString(); // far beyond any real stablecoin supply; still well inside int64 when summed
      s.reserve(entry({ amount: big }));
      s.reserve(entry({ amount: big }));
      expect(s.ledgerView("p").spentByBudget("org")).toBe(2n ** 62n);
      expect(s.spent("p").byBudget.org).toBeUndefined(); // reserved, not settled
      s.close();
    });

    it("persists across instances and round-trips the other records", async () => {
      const dir = mkdtempSync(join(tmpdir(), `spendmarshal-${driver}-persist-`));
      const a = await openStore({ driver, dataDir: dir });
      a.setKillSwitch("p", true);
      const e = a.reserve(entry({ amount: "7", budgetIds: ["b"] }));
      a.settle(e.id, "0x1", new Date().toISOString());
      a.putApproval({ v: 1, id: "apr_1", principalId: "p", intentId: "i", intentHash: `0x${"ab".repeat(32)}`, credentialId: "c", agentId: "a", amount: "1", token: "0x", chain: "eip155:1", payee: { host: "h", url: "http://h/x" }, resource: "/x", purpose: "r", rail: "x402", reasons: [], status: "pending", requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1000).toISOString() });
      a.addPolicyVersion("p", { version: 1, hash: `0x${"00".repeat(32)}`, prevHash: null, activatedAt: new Date().toISOString(), document: { version: 1, principalId: "p", currency: { asset: "USDC", decimals: 6 }, budgets: {}, agents: {}, velocity: [], rules: [] } });
      a.addAnchor({ head: "0x1", count: 1, txHash: "0x2", blockNumber: "3", registry: "0x4" });
      for (let i = 0; i < 3; i++) a.putIntent({ intent: { v: 1, id: `int_${i}`, principalId: "p", agentId: "a", credentialId: "c", payee: { url: "http://h/x", host: "h" }, resource: "/x", maxAmount: { asset: "USDC", chain: "eip155:1", token: "0x0000000000000000000000000000000000000001", value: "1", decimals: 6 }, purpose: "r", rail: "auto", createdAt: new Date().toISOString() }, amount: "1", effect: "allow", ts: new Date().toISOString() });
      a.close();
      const b = await openStore({ driver, dataDir: dir });
      expect(b.killSwitch("p")).toBe(true);
      expect(b.ledgerView("p").spentByBudget("b")).toBe(7n);
      expect(b.getApproval("apr_1")?.status).toBe("pending");
      expect(b.approvalsFor("p", "pending")).toHaveLength(1);
      expect(b.approvalsFor("p", "approved")).toHaveLength(0);
      expect(b.policyVersions("p").map((v) => v.version)).toEqual([1]);
      expect(b.principalsWithPolicies()).toEqual(["p"]);
      expect(b.anchorsList()).toHaveLength(1);
      expect(b.recentIntents("p", 2).map((r) => r.intent.id)).toEqual(["int_1", "int_2"]);
      b.close();
    });
  });

  describe(`ReceiptLog [${driver}]`, () => {
    it("produces a verifiable, strictly sequential chain even under concurrent appends", async () => {
      const store = await fresh();
      const signer = new LocalSigner(PK, "secret");
      const log = new ReceiptLog(store, signer);
      await Promise.all(Array.from({ length: 12 }, (_, i) => log.append("p", "decision", { i, big: 10n ** 20n })));
      const rs = store.receiptsFor("p");
      expect(rs.map((r) => r.seq)).toEqual([...Array(12).keys()]);
      const v = await verifyChain(rs, signer.address);
      expect(v.ok, v.problems.join(";")).toBe(true);
      expect(rs[0]!.data.big).toBe("100000000000000000000"); // bigint sanitised to string
      store.close();
    });
  });
}

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
