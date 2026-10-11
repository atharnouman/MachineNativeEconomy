import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyChain } from "@spendmarshal/core";
import { openStore, type StoreDriver } from "../src/store.js";
import { LocalSigner } from "../src/signer.js";
import { ReceiptLog } from "../src/receipts.js";
import { IdempotencyGuard, idempotencyKeyOf } from "../src/idempotency.js";
import { DenialThrottle } from "../src/denials.js";

const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const fresh = (driver: StoreDriver) => openStore({ driver, dataDir: mkdtempSync(join(tmpdir(), `spendmarshal-scale-${driver}-`)) });

for (const driver of ["json", "sqlite"] as StoreDriver[]) {
  describe(`receipt chain head [${driver}]`, () => {
    it("appends without reading the chain, survives a restart, and keeps two principals independent under concurrency", async () => {
      const store = await fresh(driver);
      const signer = new LocalSigner(PK, "secret");
      const log = new ReceiptLog(store, signer);
      await Promise.all(Array.from({ length: 60 }, (_, i) => log.append(i % 2 ? "a" : "b", "external", { i })));
      expect((await verifyChain(store.receiptsFor("a"), signer.address)).ok).toBe(true);
      expect((await verifyChain(store.receiptsFor("b"), signer.address)).ok).toBe(true);
      expect(store.lastReceipt("a")?.seq).toBe(29);
      // a new log over the same store (process restart) continues the chain from the stored head
      const again = new ReceiptLog(store, signer);
      const r = await again.append("a", "external", { after: "restart" });
      expect(r.seq).toBe(30);
      expect(r.prev).toBe(store.receiptsFor("a")[29]!.hash);
      expect((await verifyChain(store.receiptsFor("a"), signer.address)).ok).toBe(true);
      expect(store.lastReceipt("nobody")).toBeUndefined();
    });
  });

  describe(`idempotency [${driver}]`, () => {
    it("replays a final outcome for the same credential and key, runs duplicates once, and retries transient failures", async () => {
      const store = await fresh(driver);
      const guard = new IdempotencyGuard(store);
      let calls = 0;
      const settle = async () => ({ ok: true, status: 200, calls: ++calls });
      const first = await guard.run("cred_a", "k1", settle);
      const second = await guard.run("cred_a", "k1", settle);
      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.result.calls).toBe(1);
      expect(calls).toBe(1);
      // another credential with the same key is a different request
      await guard.run("cred_b", "k1", settle);
      expect(calls).toBe(2);
      // concurrent duplicates share one execution
      let slowCalls = 0;
      const slow = () => new Promise<{ ok: boolean; status: number }>((res) => setTimeout(() => res({ ok: true, status: 200, n: ++slowCalls } as never), 30));
      const [x, y] = await Promise.all([guard.run("cred_c", "k2", slow), guard.run("cred_c", "k2", slow)]);
      expect(slowCalls).toBe(1);
      expect(y.replayed || x.replayed).toBe(true);
      // a transient failure is not stored: the retry runs again
      let fails = 0;
      const flaky = async () => ({ ok: false, status: 502, n: ++fails });
      await guard.run("cred_d", "k3", flaky);
      await guard.run("cred_d", "k3", flaky);
      expect(fails).toBe(2);
      // a policy denial is final and replayed
      let denies = 0;
      const deny = async () => ({ ok: false, status: 403, n: ++denies });
      await guard.run("cred_e", "k4", deny);
      const replay = await guard.run("cred_e", "k4", deny);
      expect(denies).toBe(1);
      expect(replay.replayed).toBe(true);
      // no key = no idempotency
      await guard.run("cred_a", undefined, settle);
      await guard.run("cred_a", undefined, settle);
      expect(calls).toBe(4);
    });
  });
}

describe("Idempotency-Key header", () => {
  it("accepts 1-128 characters and rejects the rest", () => {
    expect(idempotencyKeyOf({ headers: {} })).toBeUndefined();
    expect(idempotencyKeyOf({ headers: { "idempotency-key": " abc " } })).toBe("abc");
    expect(() => idempotencyKeyOf({ headers: { "idempotency-key": "" } })).toThrow(/1 to 128/);
    expect(() => idempotencyKeyOf({ headers: { "idempotency-key": "x".repeat(129) } })).toThrow(/1 to 128/);
  });
});

describe("denial throttle", () => {
  it("writes up to the limit per window, suppresses the rest, and reports the suppressed count in the next window", () => {
    const t = new DenialThrottle(3, 1000);
    const t0 = 1_000_000;
    expect(t.admit("c", t0)).toEqual({ carried: 0 });
    expect(t.admit("c", t0 + 1)).toEqual({ carried: 0 });
    expect(t.admit("c", t0 + 2)).toEqual({ carried: 0 });
    expect(t.admit("c", t0 + 3)).toBeNull();
    expect(t.admit("c", t0 + 4)).toBeNull();
    expect(t.admit("other", t0 + 5)).toEqual({ carried: 0 }); // per credential
    expect(t.admit("c", t0 + 1000)).toEqual({ carried: 2 }); // new window reports what was dropped
    expect(t.admit("c", t0 + 1001)).toEqual({ carried: 0 });
  });
});
