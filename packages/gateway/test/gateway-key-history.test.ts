import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { verifyBundle, verifyChain, type EvidenceBundle } from "@spendmarshal/core";
import { buildGateway, type Gateway } from "../src/server.js";
import type { GatewayConfig, PrincipalConfig } from "../src/config.js";
import { openStore, type StoreDriver } from "../src/store.js";
import { LocalSigner } from "../src/signer.js";
import { ReceiptLog } from "../src/receipts.js";

const ZERO: Address = "0x0000000000000000000000000000000000000000";
const policy = (principalId: string) => `
version: 1
principalId: ${principalId}
budgets: { org: { cap: "1.00" } }
agents: { a: { budget: org } }
rules: [{ id: allow-all, effect: allow }]
`;
// three generations of the gateway key (anvil dev keys)
const K1: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const K2: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const K3: Hex = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const [A1, A2, A3] = [K1, K2, K3].map((k) => privateKeyToAccount(k).address) as [Address, Address, Address];
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** A gateway on an existing store. The chain is never contacted: anchoring goes to the fake registry in `start`. */
function config(dataDir: string, driver: StoreDriver, key: Hex, opts: { previous?: Hex[]; policyFor?: string; principals?: Record<string, PrincipalConfig> } = {}): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    rpcUrl: "http://127.0.0.1:1",
    chainId: 31337,
    gatewayPrivateKey: key,
    previousGatewayKeys: opts.previous,
    sessionSecret: "session-secret",
    credentialRootKey: "credential-root-key",
    adminToken: "admin",
    dataDir,
    storeDriver: driver,
    policyYaml: policy(opts.policyFor ?? "org"),
    contracts: { usdc: ZERO, receiptRegistry: ZERO, enforcers: { spendLimit: ZERO, timeWindow: ZERO, allowedTargets: ZERO } },
    principals: opts.principals ?? { org: { account: ZERO } },
    asset: { symbol: "USDC", decimals: 6 },
    facilitator: { enabled: false },
    authorizationTtlSeconds: 120,
  };
}

async function start(cfg: GatewayConfig): Promise<Gateway> {
  const gw = await buildGateway(cfg);
  await gw.ready;
  // a registry where the sender has no earlier anchor and every anchor lands in block 1
  gw.chain.latestAnchorHead = async () => `0x${"0".repeat(64)}` as Hex;
  gw.chain.anchor = async () => ({ txHash: `0x${"1".repeat(64)}` as Hex, blockNumber: 1n });
  return gw;
}

const kinds = (gw: Gateway, p: string) => gw.store.receiptsFor(p).map((r) => r.kind);
const verify = (gw: Gateway, p: string, trustedGatewayKeys?: string[]) => verifyBundle(JSON.parse(JSON.stringify(gw.exportEvidence(p))) as EvidenceBundle, { trustedGatewayKeys });
const check = (r: Awaited<ReturnType<typeof verifyBundle>>, name: string) => r.checks.find((c) => c.check === name);

for (const driver of ["json", "sqlite"] as StoreDriver[]) {
  describe(`gateway key history [${driver}]`, () => {
    it("hands each chain over to a new gateway key, and every bundle keeps verifying", async () => {
      const dir = mkdtempSync(join(tmpdir(), `spendmarshal-gwkeys-${driver}-`));

      // run 1, key K1: "dormant" and "idle" are served once and never again; "org" is anchored
      for (const p of ["dormant", "idle"]) await (await start(config(dir, driver, K1, { policyFor: p, principals: {} }))).close();
      let gw = await start(config(dir, driver, K1));
      await gw.anchor("org");
      expect(kinds(gw, "org")).toEqual(["policy.updated", "evidence.anchored"]);
      expect(gw.store.anchorsList("org")[0]?.party).toBe(A1);
      let report = await verify(gw, "org");
      expect(report.ok, JSON.stringify(report.checks)).toBe(true);
      expect(check(report, "gateway.keys")).toBeUndefined(); // no rotation: the report from before key history
      await gw.close();

      // run 2, key K2 with K1 still configured: startup hands the served principal over, and K1 signs the handover
      gw = await start(config(dir, driver, K2, { previous: [K1] }));
      expect(kinds(gw, "org")).toEqual(["policy.updated", "evidence.anchored", "gateway.key.rotated"]);
      const rotation = gw.store.receiptsFor("org")[2]!;
      expect(rotation.data).toMatchObject({ prevAddress: A1, address: A2, handover: expect.stringMatching(/^0x[0-9a-f]{130}$/) });
      const bundle = gw.exportEvidence("org");
      expect(bundle.gateway.address).toBe(A2);
      expect(bundle.gatewayKeyHistory).toEqual([{ address: A2, prevAddress: A1, seq: 2, effectiveFrom: rotation.ts, receiptId: rotation.id, handedOver: true }]);
      report = await verify(gw, "org", [A1]);
      expect(report.ok, JSON.stringify(report.checks)).toBe(true);
      expect(check(report, "gateway.keys")?.detail).toBe(`${short(A1)} from #0; ${short(A2)} from #2 (handed over)`);
      expect(check(report, "gateway.trusted")?.detail).toBe(`${short(A2)} was handed over from trusted ${short(A1)}`);
      // a principal this gateway does not serve keeps its chain as it was, and its bundle names the key that signed it
      expect(kinds(gw, "dormant")).toEqual(["policy.updated"]);
      expect(gw.exportEvidence("dormant").gateway.address).toBe(A1);
      expect((await verify(gw, "dormant", [A1])).ok).toBe(true);
      await gw.close();

      // a restart with the same key writes nothing
      gw = await start(config(dir, driver, K2, { previous: [K1] }));
      expect(kinds(gw, "org")).toHaveLength(3);
      await gw.close();

      // run 3, key K3, and K2 is gone: the rotation is receipted without a handover. The chain verifies, and a pin on the
      // first key no longer covers it.
      gw = await start(config(dir, driver, K3));
      expect(gw.store.receiptsFor("org")[3]).toMatchObject({ kind: "gateway.key.rotated", data: { prevAddress: A2, address: A3, handover: null } });
      report = await verify(gw, "org");
      expect(report.ok, JSON.stringify(report.checks)).toBe(true);
      expect(check(report, "gateway.keys")?.detail).toBe(`${short(A1)} from #0; ${short(A2)} from #2 (handed over); ${short(A3)} from #3 (no handover)`);
      const pinnedFirst = await verify(gw, "org", [A1]);
      expect(pinnedFirst.ok).toBe(false);
      expect(check(pinnedFirst, "gateway.trusted")?.detail).toBe(`${short(A3)} is neither trusted nor handed over from a trusted key (no handover at #3)`);
      expect((await verify(gw, "org", [A3])).ok).toBe(true);

      // the dormant chain is handed over by its next receipt, here an operator's external receipt
      const res = await gw.app.inject({ method: "POST", url: "/v1/receipts/external", headers: { "x-admin-token": "admin" }, payload: { principalId: "dormant", source: "test", data: { note: "late" } } });
      expect(res.statusCode).toBe(200);
      expect(kinds(gw, "dormant")).toEqual(["policy.updated", "gateway.key.rotated", "external"]);
      expect(gw.store.receiptsFor("dormant")[1]!.data).toEqual({ prevAddress: A1, address: A3, handover: null });
      expect((await verify(gw, "dormant")).ok).toBe(true);

      // anchoring a chain that was not handed over yet hands it over first: the key that sends the anchor signed its head
      const anchored = await gw.anchor("idle");
      expect(kinds(gw, "idle")).toEqual(["policy.updated", "gateway.key.rotated", "evidence.anchored"]);
      expect(anchored).toMatchObject({ count: 2, head: gw.store.receiptsFor("idle")[1]!.hash, party: A3 });
      const idle = await verify(gw, "idle");
      expect(idle.ok, JSON.stringify(idle.checks)).toBe(true);
      expect(check(idle, "anchors.match")?.detail).toBe("1 anchors");
      await gw.close();
    });

    it("writes one rotation however many receipts race to follow a key change", async () => {
      const store = await openStore({ driver, dataDir: mkdtempSync(join(tmpdir(), `spendmarshal-gwkeys-race-${driver}-`)) });
      const old = new ReceiptLog(store, new LocalSigner(K1, "secret"));
      for (let i = 0; i < 3; i++) await old.append("p", "external", { i });
      const log = new ReceiptLog(store, new LocalSigner(K2, "secret", [K1]));
      await Promise.all(Array.from({ length: 10 }, (_, i) => log.append("p", "external", { i })));
      const rs = store.receiptsFor("p");
      expect(rs.map((r) => r.kind)).toEqual(["external", "external", "external", "gateway.key.rotated", ...Array(10).fill("external")]);
      const v = await verifyChain(rs, A2);
      expect(v.ok, v.problems.join("; ")).toBe(true);
      expect(v.keys).toMatchObject([{ prevAddress: A1, address: A2, seq: 3, handedOver: true }]);
      expect(await log.handOver("p")).toBeNull(); // nothing left to hand over
      store.close();
    });

    it("refuses a previous gateway key that is not a private key, before anything is receipted", async () => {
      const dir = mkdtempSync(join(tmpdir(), `spendmarshal-gwkeys-bad-${driver}-`));
      await expect(buildGateway(config(dir, driver, K2, { previous: ["0x1234"] }))).rejects.toThrow("previous gateway key is not a 32-byte hex private key");
      const store = await openStore({ driver, dataDir: dir });
      expect(store.lastReceipt("org")).toBeUndefined();
      expect(store.policyVersions("org")).toEqual([]);
      store.close();
    });
  });
}
