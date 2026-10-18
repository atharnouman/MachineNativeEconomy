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
function config(dataDir: string, driver: StoreDriver, key: Hex, opts: { previous?: Hex[]; addresses?: Address[]; policyFor?: string; principals?: Record<string, PrincipalConfig> } = {}): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    rpcUrl: "http://127.0.0.1:1",
    chainId: 31337,
    gatewayPrivateKey: key,
    previousGatewayKeys: opts.previous,
    previousGatewayAddresses: opts.addresses,
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

/** A gateway whose startup may still be running (or failing): `start` waits for it. */
async function build(cfg: GatewayConfig): Promise<Gateway> {
  const gw = await buildGateway(cfg);
  // a registry where the sender has no earlier anchor and every anchor lands in block 1
  gw.chain.latestAnchorHead = async () => `0x${"0".repeat(64)}` as Hex;
  gw.chain.anchor = async () => ({ txHash: `0x${"1".repeat(64)}` as Hex, blockNumber: 1n });
  return gw;
}

async function start(cfg: GatewayConfig): Promise<Gateway> {
  const gw = await build(cfg);
  await gw.ready;
  return gw;
}

const kinds = async (gw: Gateway, p: string) => (await gw.store.receiptsFor(p)).map((r) => r.kind);
const verify = async (gw: Gateway, p: string, trustedGatewayKeys?: string[]) => verifyBundle(JSON.parse(JSON.stringify(await gw.exportEvidence(p))) as EvidenceBundle, { trustedGatewayKeys });
const check = (r: Awaited<ReturnType<typeof verifyBundle>>, name: string) => r.checks.find((c) => c.check === name);
const external = (gw: Gateway, principalId: string) => gw.app.inject({ method: "POST", url: "/v1/receipts/external", headers: { "x-admin-token": "admin" }, payload: { principalId, source: "test", data: { note: "late" } } });

for (const driver of ["json", "sqlite"] as StoreDriver[]) {
  describe(`gateway key history [${driver}]`, () => {
    it("hands each chain over to a new gateway key, and every bundle keeps verifying", async () => {
      const dir = mkdtempSync(join(tmpdir(), `spendmarshal-gwkeys-${driver}-`));

      // run 1, key K1: "dormant" and "idle" are served once and never again; "org" is anchored
      for (const p of ["dormant", "idle"]) await (await start(config(dir, driver, K1, { policyFor: p, principals: {} }))).close();
      let gw = await start(config(dir, driver, K1));
      await gw.anchor("org");
      expect(await kinds(gw, "org")).toEqual(["policy.updated", "evidence.anchored"]);
      expect((await gw.store.anchorsList("org"))[0]?.party).toBe(A1);
      let report = await verify(gw, "org");
      expect(report.ok, JSON.stringify(report.checks)).toBe(true);
      expect(check(report, "gateway.keys")).toBeUndefined(); // no rotation: the report from before key history
      await gw.close();

      // run 2, key K2 with K1 still configured: startup hands the served principal over, and K1 signs the handover
      gw = await start(config(dir, driver, K2, { previous: [K1] }));
      expect(await kinds(gw, "org")).toEqual(["policy.updated", "evidence.anchored", "gateway.key.rotated"]);
      const rotation = (await gw.store.receiptsFor("org"))[2]!;
      expect(rotation.data).toMatchObject({ prevAddress: A1, address: A2, handover: expect.stringMatching(/^0x[0-9a-f]{130}$/) });
      const bundle = (await gw.exportEvidence("org"));
      expect(bundle.gateway.address).toBe(A2);
      expect(bundle.gatewayKeyHistory).toEqual([{ address: A2, prevAddress: A1, seq: 2, effectiveFrom: rotation.ts, receiptId: rotation.id, handedOver: true }]);
      report = await verify(gw, "org", [A1]);
      expect(report.ok, JSON.stringify(report.checks)).toBe(true);
      expect(check(report, "gateway.keys")?.detail).toBe(`${short(A1)} from #0; ${short(A2)} from #2 (handed over)`);
      expect(check(report, "gateway.trusted")?.detail).toBe(`trusted ${short(A1)}; handed over ${short(A2)}`);
      // a principal this gateway does not serve keeps its chain as it was, and its bundle names the key that signed it
      expect(await kinds(gw, "dormant")).toEqual(["policy.updated"]);
      expect((await gw.exportEvidence("dormant")).gateway.address).toBe(A1);
      expect((await verify(gw, "dormant", [A1])).ok).toBe(true);
      await gw.close();

      // a restart with the same key writes nothing
      gw = await start(config(dir, driver, K2, { previous: [K1] }));
      expect(await kinds(gw, "org")).toHaveLength(3);
      await gw.close();

      // run 3, key K3, and K2 is gone, but nobody told the gateway: it refuses to continue the chain K2 signed (ADR-0022).
      // Startup fails and writes nothing; an operator's receipt for an unserved chain and the reclaim job are refused too.
      gw = await build(config(dir, driver, K3));
      await expect(gw.ready).rejects.toThrow(`the receipt chain of org ends with #2, signed by ${A2}`);
      expect(await kinds(gw, "org")).toHaveLength(3);
      expect((await external(gw, "dormant")).statusCode).toBe(409);
      expect(await kinds(gw, "dormant")).toEqual(["policy.updated"]);
      const sent: string[] = [];
      gw.chain.now = async () => 2_000_000_000n;
      gw.chain.reclaimApproval = async (_account, digest) => {
        sent.push(digest);
        return { ok: true, txHash: `0x${"2".repeat(64)}` as Hex };
      };
      await gw.store.putPreApproval({ digest: `0x${"d".repeat(64)}`, principalId: "dormant", account: ZERO, credentialId: "cred_x", intentId: "int_x", value: "1", validBefore: "1", approvalTxHash: `0x${"3".repeat(64)}`, createdAt: new Date().toISOString(), state: "pending" });
      expect(await gw.payments.reclaimExpiredPreApprovals()).toMatchObject([{ ok: false, reason: expect.stringContaining("refusing to continue it") }]);
      expect(sent).toEqual([]); // the chain refused first, so nothing was sent on-chain
      expect(await gw.metrics.text()).toContain("spendmarshal_receipt_chain_refusals_total 3");
      await gw.close();

      // run 3 again, with K2 and K1 declared as previous addresses whose keys are gone: the rotation is receipted without a
      // handover. The chain is consistent, but nothing vouches for the change, so it verifies only with both sides pinned.
      gw = await start(config(dir, driver, K3, { addresses: [A2, A1] }));
      expect((await gw.store.receiptsFor("org"))[3]).toMatchObject({ kind: "gateway.key.rotated", data: { prevAddress: A2, address: A3, handover: null } });
      report = await verify(gw, "org");
      expect(check(report, "receipts.chain")?.ok).toBe(true);
      expect(check(report, "gateway.keys")?.detail).toBe(`${short(A1)} from #0; ${short(A2)} from #2 (handed over); ${short(A3)} from #3 (no handover)`);
      expect(check(report, "gateway.trusted")).toEqual({ check: "gateway.trusted", ok: false, detail: `rotation without a handover at #3 (${short(A2)} → ${short(A3)}): pin the gateway keys you trust` });
      expect(check(await verify(gw, "org", [A1]), "gateway.trusted")?.detail).toBe(`receipts #3–#3 were signed by ${short(A3)}, which is neither trusted nor linked to a trusted key by handovers`);
      expect((await verify(gw, "org", [A1, A3])).ok).toBe(true);

      // the dormant chain is handed over by its next receipt, here an operator's external receipt
      expect((await external(gw, "dormant")).statusCode).toBe(200);
      expect(await kinds(gw, "dormant")).toEqual(["policy.updated", "gateway.key.rotated", "external"]);
      expect((await gw.store.receiptsFor("dormant"))[1]!.data).toEqual({ prevAddress: A1, address: A3, handover: null });
      expect((await verify(gw, "dormant", [A1, A3])).ok).toBe(true);

      // anchoring a chain that was not handed over yet hands it over first: the key that sends the anchor signed its head
      const anchored = await gw.anchor("idle");
      expect(await kinds(gw, "idle")).toEqual(["policy.updated", "gateway.key.rotated", "evidence.anchored"]);
      expect(anchored).toMatchObject({ count: 2, head: (await gw.store.receiptsFor("idle"))[1]!.hash, party: A3 });
      const idle = await verify(gw, "idle", [A1, A3]);
      expect(idle.ok, JSON.stringify(idle.checks)).toBe(true);
      expect(check(idle, "anchors.match")?.detail).toBe("1 anchors");
      expect(await gw.metrics.text()).toContain('spendmarshal_gateway_key_rotations_total{handover="no"} 3');
      await gw.close();
    });

    it("writes one rotation however many receipts race to follow a key change", async () => {
      const store = await openStore({ driver, dataDir: mkdtempSync(join(tmpdir(), `spendmarshal-gwkeys-race-${driver}-`)) });
      const old = new ReceiptLog(store, new LocalSigner(K1, "secret"));
      for (let i = 0; i < 3; i++) await old.append("p", "external", { i });
      const log = new ReceiptLog(store, new LocalSigner(K2, "secret", [K1]));
      await Promise.all(Array.from({ length: 10 }, (_, i) => log.append("p", "external", { i })));
      const rs = (await store.receiptsFor("p"));
      expect(rs.map((r) => r.kind)).toEqual(["external", "external", "external", "gateway.key.rotated", ...Array(10).fill("external")]);
      const v = await verifyChain(rs, A2);
      expect(v.ok, v.problems.join("; ")).toBe(true);
      expect(v.keys).toMatchObject([{ prevAddress: A1, address: A2, seq: 3, handedOver: true }]);
      expect(await log.handOver("p")).toBeNull(); // nothing left to hand over
      await store.close();
    });

    it("refuses to continue a chain an unknown key signed, and writes nothing, until that key is declared", async () => {
      const store = await openStore({ driver, dataDir: mkdtempSync(join(tmpdir(), `spendmarshal-gwkeys-refuse-${driver}-`)) });
      await new ReceiptLog(store, new LocalSigner(K1, "secret")).append("p", "external", { by: "K1" });
      const strict = new ReceiptLog(store, new LocalSigner(K2, "secret"));
      await expect(strict.append("p", "external", { by: "K2" })).rejects.toMatchObject({ statusCode: 409 });
      await expect(strict.handOver("p")).rejects.toThrow("refusing to continue it");
      expect((await store.receiptsFor("p"))).toHaveLength(1);
      const declared = new ReceiptLog(store, new LocalSigner(K2, "secret"), undefined, { previousGatewayAddresses: [A1.toLowerCase()] });
      expect((await declared.handOver("p"))?.data).toEqual({ prevAddress: A1, address: A2, handover: null });
      await declared.append("p", "external", { by: "K2" });
      expect((await verifyChain((await store.receiptsFor("p")), A2)).ok).toBe(true);
      await store.close();
    });

    it("refuses a previous gateway address that is not an address, before anything is receipted", async () => {
      const dir = mkdtempSync(join(tmpdir(), `spendmarshal-gwkeys-badaddr-${driver}-`));
      await expect(buildGateway(config(dir, driver, K2, { addresses: ["0x1234" as Address] }))).rejects.toThrow("previous gateway address 0x1234 is not an address");
      const store = await openStore({ driver, dataDir: dir });
      expect((await store.lastReceipt("org"))).toBeUndefined();
      await store.close();
    });

    it("refuses a previous gateway key that is not a private key, before anything is receipted", async () => {
      const dir = mkdtempSync(join(tmpdir(), `spendmarshal-gwkeys-bad-${driver}-`));
      await expect(buildGateway(config(dir, driver, K2, { previous: ["0x1234"] }))).rejects.toThrow("previous gateway key is not a 32-byte hex private key");
      const store = await openStore({ driver, dataDir: dir });
      expect((await store.lastReceipt("org"))).toBeUndefined();
      expect((await store.policyVersions("org"))).toEqual([]);
      await store.close();
    });
  });
}
