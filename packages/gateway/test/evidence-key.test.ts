import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { receiptSigner, verifyBundle, type EvidenceBundle } from "@spendmarshal/core";
import { buildGateway, type Gateway } from "../src/server.js";
import type { GatewayConfig } from "../src/config.js";
import type { StoreDriver } from "../src/store.js";
import { LocalSigner, receiptKeyOf } from "../src/signer.js";

const ZERO: Address = "0x0000000000000000000000000000000000000000";
const POLICY = `
version: 1
principalId: org
budgets: { org: { cap: "1.00" } }
agents: { a: { budget: org } }
rules: [{ id: allow-all, effect: allow }]
`;
// two gateway (on-chain) keys and one evidence key (anvil dev keys)
const G1: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const G2: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const E: Hex = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const [AG1, AG2, AE] = [G1, G2, E].map((k) => privateKeyToAccount(k).address) as [Address, Address, Address];
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function config(dataDir: string, driver: StoreDriver, gatewayKey: Hex, evidenceKey?: Hex): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    rpcUrl: "http://127.0.0.1:1",
    chainId: 31337,
    gatewayPrivateKey: gatewayKey,
    evidencePrivateKey: evidenceKey,
    sessionSecret: "session-secret",
    credentialRootKey: "credential-root-key",
    adminToken: "admin",
    dataDir,
    storeDriver: driver,
    policyYaml: POLICY,
    contracts: { usdc: ZERO, receiptRegistry: ZERO, enforcers: { spendLimit: ZERO, timeWindow: ZERO, allowedTargets: ZERO } },
    principals: { org: { account: ZERO } },
    asset: { symbol: "USDC", decimals: 6 },
    facilitator: { enabled: false },
    authorizationTtlSeconds: 120,
  };
}

/** A gateway on an existing store, with a registry where every anchor lands in block 1 (the chain is never contacted). */
async function start(cfg: GatewayConfig): Promise<Gateway> {
  const gw = await buildGateway(cfg);
  await gw.ready;
  gw.chain.latestAnchorHead = async () => `0x${"0".repeat(64)}` as Hex;
  gw.chain.anchor = async () => ({ txHash: `0x${String((await gw.store.anchorsList()).length + 1).repeat(64)}` as Hex, blockNumber: 1n });
  return gw;
}

const kinds = async (gw: Gateway) => (await gw.store.receiptsFor("org")).map((r) => r.kind);
const exported = async (gw: Gateway) => JSON.parse(JSON.stringify(await gw.exportEvidence("org"))) as EvidenceBundle;
const check = (r: Awaited<ReturnType<typeof verifyBundle>>, name: string) => r.checks.find((c) => c.check === name);

for (const driver of ["json", "sqlite"] as StoreDriver[]) {
  describe(`evidence key [${driver}]`, () => {
    it("keeps one evidence key while the gateway key changes, and records who sent each anchor", async () => {
      const dir = mkdtempSync(join(tmpdir(), `spendmarshal-evidence-${driver}-`));

      // run 1: gateway key G1, evidence key E
      let gw = await start(config(dir, driver, G1, E));
      const health = (await gw.app.inject({ method: "GET", url: "/healthz" })).json() as { gateway: string; evidenceKey: string };
      expect(health).toMatchObject({ gateway: AG1, evidenceKey: AE });
      expect(receiptSigner((await gw.store.receiptsFor("org"))[0]!)).toBe(AE);
      expect(await gw.anchor("org")).toMatchObject({ count: 1, party: AG1 });
      await gw.close();

      // run 2: a new gateway key (a fresh session key, as the testnet runner uses), the same evidence key: no rotation
      gw = await start(config(dir, driver, G2, E));
      expect(await gw.anchor("org")).toMatchObject({ count: 2, party: AG2 }); // the policy receipt and the first anchor's
      expect(await kinds(gw)).toEqual(["policy.updated", "evidence.anchored", "evidence.anchored"]);
      expect((await gw.store.receiptsFor("org")).map(receiptSigner)).toEqual([AE, AE, AE]);
      const bundle = await exported(gw);
      expect(bundle.gateway.address).toBe(AE);
      expect(bundle.gatewayKeyHistory).toEqual([]);
      expect(bundle.anchors.map((a) => a.party)).toEqual([AG1, AG2]);
      const report = await verifyBundle(bundle, { trustedGatewayKeys: [AE] });
      expect(report.ok, JSON.stringify(report.checks)).toBe(true);
      expect(check(report, "anchors.match")?.detail).toBe("2 anchors");
      expect(check(report, "gateway.trusted")?.detail).toBe(`trusted ${short(AE)}`);

      // an anchor listed under a sender its chain does not record fails
      const misattributed = await exported(gw);
      misattributed.anchors[0]!.party = AG2;
      expect(check(await verifyBundle(misattributed), "anchors.match")?.ok).toBe(false);
      await gw.close();
    });

    it("hands an existing chain over when a separate evidence key is turned on, signed by the gateway key", async () => {
      const dir = mkdtempSync(join(tmpdir(), `spendmarshal-evidence-on-${driver}-`));
      let gw = await start(config(dir, driver, G1));
      expect(receiptSigner((await gw.store.receiptsFor("org"))[0]!)).toBe(AG1);
      await gw.close();

      gw = await start(config(dir, driver, G1, E));
      expect(await kinds(gw)).toEqual(["policy.updated", "gateway.key.rotated"]);
      expect((await gw.store.receiptsFor("org"))[1]!.data).toMatchObject({ prevAddress: AG1, address: AE, handover: expect.stringMatching(/^0x[0-9a-f]{130}$/) });
      const report = await verifyBundle(await exported(gw), { trustedGatewayKeys: [AG1] });
      expect(report.ok, JSON.stringify(report.checks)).toBe(true);
      expect(check(report, "gateway.trusted")?.detail).toBe(`trusted ${short(AG1)}; handed over ${short(AE)}`);
      expect((await verifyBundle(await exported(gw))).ok).toBe(true); // a handover needs no pin
      await gw.close();
    });

    it("refuses an evidence key that is not a private key, before anything is receipted", async () => {
      const dir = mkdtempSync(join(tmpdir(), `spendmarshal-evidence-bad-${driver}-`));
      await expect(buildGateway(config(dir, driver, G1, "0x1234"))).rejects.toThrow("evidence key is not a 32-byte hex private key");
    });
  });
}

describe("LocalSigner with an evidence key", () => {
  it("signs receipts with the evidence key and keeps the gateway key for everything on-chain", async () => {
    const separate = new LocalSigner(G1, "secret", [], E);
    expect([separate.address, separate.evidenceAddress, receiptKeyOf(separate)]).toEqual([AG1, AE, AE]);
    const hash = `0x${"ab".repeat(32)}` as Hex;
    expect(receiptSigner({ hash, sig: await separate.signReceiptHash(hash) })).toBe(AE);
    expect(await separate.signKeyHandover(AG1, "handover")).toMatch(/^0x[0-9a-f]{130}$/); // the gateway key hands its chains over
    expect(await separate.signKeyHandover(AG2, "handover")).toBeNull();

    const single = new LocalSigner(G1, "secret");
    expect([single.address, receiptKeyOf(single)]).toEqual([AG1, AG1]);
    expect(receiptSigner({ hash, sig: await single.signReceiptHash(hash) })).toBe(AG1);
  });
});
