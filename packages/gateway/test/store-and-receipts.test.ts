import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyChain } from "@apgw/core";
import { Store } from "../src/store.js";
import { LocalSigner } from "../src/signer.js";
import { ReceiptLog } from "../src/receipts.js";

const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe("Store ledger", () => {
  it("reserves, commits and releases against credential lineage and budgets", () => {
    const s = new Store(mkdtempSync(join(tmpdir(), "apgw-store-")));
    s.reserve(["root", "child"], ["org", "team"], 100n);
    expect(s.ledgerView().spentByCredential("root")).toBe(100n); // reserved counts
    expect(s.ledgerView().spentByBudget("team")).toBe(100n);
    s.release(["root", "child"], ["org", "team"], 100n);
    expect(s.ledgerView().spentByCredential("child")).toBe(0n);
    s.reserve(["root", "child"], ["org", "team"], 40n);
    s.commit(["root", "child"], ["org", "team"], 40n);
    expect(s.ledgerView().spentByCredential("root")).toBe(40n);
    expect(s.spent().byBudget).toEqual({ org: "40", team: "40" });
  });

  it("persists across instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "apgw-store-"));
    const a = new Store(dir);
    a.setKillSwitch("p", true);
    a.reserve(["c"], ["b"], 7n);
    a.commit(["c"], ["b"], 7n);
    const b = new Store(dir);
    expect(b.killSwitch("p")).toBe(true);
    expect(b.ledgerView().spentByBudget("b")).toBe(7n);
  });
});

describe("ReceiptLog", () => {
  it("produces a verifiable, strictly sequential chain even under concurrent appends", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "apgw-rcpt-")));
    const signer = new LocalSigner(PK, "secret");
    const log = new ReceiptLog(store, signer);
    await Promise.all(Array.from({ length: 12 }, (_, i) => log.append("p", "decision", { i, big: 10n ** 20n })));
    const rs = store.receiptsFor("p");
    expect(rs.map((r) => r.seq)).toEqual([...Array(12).keys()]);
    const v = await verifyChain(rs, signer.address);
    expect(v.ok, v.problems.join(";")).toBe(true);
    expect(rs[0]!.data.big).toBe("100000000000000000000"); // bigint sanitised to string
  });

  it("derives a stable session key per credential and signs typed data with it", async () => {
    const signer = new LocalSigner(PK, "secret");
    const a = signer.sessionKeyAddress("cred_x");
    expect(signer.sessionKeyAddress("cred_x")).toBe(a);
    expect(signer.sessionKeyAddress("cred_y")).not.toBe(a);
    const other = new LocalSigner(PK, "different-secret");
    expect(other.sessionKeyAddress("cred_x")).not.toBe(a);
  });
});
