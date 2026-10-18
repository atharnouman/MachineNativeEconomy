import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ReceiptRegistryAbi, receiptSigner, type EvidenceBundle } from "@spendmarshal/core";
import { ANVIL_KEYS, deployCore, registryAnchorsPerChain, startAnvil } from "@spendmarshal/devnet";
import { buildGateway, type Gateway, type GatewayConfig } from "@spendmarshal/gateway";
import { verifyEvidence } from "@spendmarshal/cli";

const ZERO: Address = "0x0000000000000000000000000000000000000000";
const KEY = ANVIL_KEYS[0]!;
const policy = (principalId: string) => `
version: 1
principalId: ${principalId}
budgets: { org: { cap: "1.00" } }
agents: { a: { budget: org } }
rules: [{ id: allow-all, effect: allow }]
`;

// Real anvil and the real ReceiptRegistry: one gateway key anchors two principals, the longer chain first (ADR-0021).
describe("anchoring several principals from one gateway key", () => {
  it("keeps each principal's anchors apart in any order of chain length, and both bundles verify on-chain", async () => {
    const net = await startAnvil({ port: 18547 });
    let gw: Gateway | undefined;
    try {
      const core = await deployCore(net, KEY);
      expect(await registryAnchorsPerChain(net, core.receiptRegistry)).toBe(true);
      expect(await registryAnchorsPerChain(net, core.usdc)).toBe(false); // a contract without per-chain anchors
      const dir = mkdtempSync(join(tmpdir(), "spendmarshal-anchors-"));
      const config = (policyFor: string): GatewayConfig => ({
        host: "127.0.0.1",
        port: 0,
        rpcUrl: net.rpcUrl,
        chainId: net.chainId,
        gatewayPrivateKey: KEY,
        sessionSecret: "session-secret",
        credentialRootKey: "credential-root-key",
        adminToken: "admin",
        dataDir: dir,
        policyYaml: policy(policyFor),
        contracts: { usdc: core.usdc, receiptRegistry: core.receiptRegistry, enforcers: core.enforcers },
        principals: { acme: { account: ZERO }, globex: { account: ZERO } },
        asset: { symbol: "USDC", decimals: 6 },
        facilitator: { enabled: false },
        authorizationTtlSeconds: 120,
      });

      // globex's policy comes from an earlier start; then acme's chain grows long while globex's stays short
      const first = await buildGateway(config("globex"));
      await first.ready;
      await first.close();
      gw = await buildGateway(config("acme"));
      await gw.ready;
      for (let i = 0; i < 6; i++) await gw.receipts.append("acme", "external", { source: "test", i });

      const acme1 = await gw.anchor("acme");
      const globex = await gw.anchor("globex"); // shorter than acme's: a registry keyed by sender alone refused this
      const acme2 = await gw.anchor("acme"); // continues acme's own sequence, with globex's anchor in between
      expect(globex.count).toBeLessThan(acme1.count);
      expect(acme2.count).toBe(acme1.count + 1); // acme's chain gained the first anchor's receipt

      const party = privateKeyToAccount(KEY).address;
      for (const [principal, last] of [["acme", acme2], ["globex", globex]] as const) {
        const genesis = (await gw.store.receiptsFor(principal))[0]!.hash as Hex;
        const [head, count] = await net.pub.readContract({ address: core.receiptRegistry, abi: ReceiptRegistryAbi, functionName: "latest", args: [party, genesis] });
        expect([head, count]).toEqual([last.head, BigInt(last.count)]);
        const report = await verifyEvidence(JSON.parse(JSON.stringify(await gw.exportEvidence(principal))), { rpcUrl: net.rpcUrl });
        expect(report.ok, JSON.stringify(report.checks)).toBe(true);
        expect(report.checks.find((c) => c.check === "anchors.onchain")?.ok).toBe(true);
      }
    } finally {
      await gw?.close();
      net.stop();
    }
  });

  it("finds an anchor that records no sender under the key that sent it, after the gateway key changed", async () => {
    const net = await startAnvil({ port: 18548 });
    let gw: Gateway | undefined;
    try {
      const core = await deployCore(net, KEY);
      const dir = mkdtempSync(join(tmpdir(), "spendmarshal-anchors-legacy-"));
      // keys the first test never sent from: viem's nonce manager is process-wide, keyed by address and chain id, and this
      // anvil starts from nonce 0 again
      const [OLD_KEY, NEW_KEY] = [ANVIL_KEYS[2]!, ANVIL_KEYS[3]!];
      const [oldAddress, newAddress] = [privateKeyToAccount(OLD_KEY).address, privateKeyToAccount(NEW_KEY).address];
      const config = (key: Hex, previousGatewayAddresses?: Address[]): GatewayConfig => ({
        host: "127.0.0.1",
        port: 0,
        rpcUrl: net.rpcUrl,
        chainId: net.chainId,
        gatewayPrivateKey: key,
        previousGatewayAddresses,
        sessionSecret: "session-secret",
        credentialRootKey: "credential-root-key",
        adminToken: "admin",
        dataDir: dir,
        policyYaml: policy("acme"),
        contracts: { usdc: core.usdc, receiptRegistry: core.receiptRegistry, enforcers: core.enforcers },
        principals: { acme: { account: ZERO } },
        asset: { symbol: "USDC", decimals: 6 },
        facilitator: { enabled: false },
        authorizationTtlSeconds: 120,
      });

      // the old key anchors; then its key is gone, the operator declares it, and the new key anchors too
      gw = await buildGateway(config(OLD_KEY));
      await gw.ready;
      await gw.anchor("acme");
      await gw.close();
      gw = await buildGateway(config(NEW_KEY, [oldAddress]));
      await gw.ready;
      await gw.anchor("acme");

      // a bundle whose first anchor was recorded before anchors named their sender
      const bundle = JSON.parse(JSON.stringify(await gw.exportEvidence("acme"))) as EvidenceBundle;
      expect(bundle.gateway.address).toBe(newAddress);
      delete bundle.anchors[0]!.party;
      const report = await verifyEvidence(bundle, { rpcUrl: net.rpcUrl, trustedGatewayKeys: [oldAddress, newAddress] });
      expect(report.ok, JSON.stringify(report.checks)).toBe(true);
      expect(report.checks.find((c) => c.check === "anchors.onchain")?.detail).toMatch(/^0x[0-9a-f]{8} @ block \d+; 0x[0-9a-f]{8} @ block \d+$/);
      // without pins the rotation (no handover) fails the trust check, while the anchors are still found on-chain
      const unpinned = await verifyEvidence(bundle, { rpcUrl: net.rpcUrl });
      expect(unpinned.checks.find((c) => c.check === "gateway.trusted")?.ok).toBe(false);
      expect(unpinned.checks.find((c) => c.check === "anchors.onchain")?.ok).toBe(true);
    } finally {
      await gw?.close();
      net.stop();
    }
  });

  it("keeps one evidence key while the gateway key changes between runs, as the testnet runner does (ADR-0023)", async () => {
    const net = await startAnvil({ port: 18549 });
    let gw: Gateway | undefined;
    try {
      const core = await deployCore(net, KEY);
      const dir = mkdtempSync(join(tmpdir(), "spendmarshal-anchors-evidence-"));
      const evidenceKey = generatePrivateKey(); // signs receipts only: never funded, never sends a transaction
      const evidence = privateKeyToAccount(evidenceKey).address;
      const [runOne, runTwo] = [ANVIL_KEYS[4]!, ANVIL_KEYS[5]!]; // keys no other test here sent from (one nonce manager per process)
      const config = (gatewayPrivateKey: Hex): GatewayConfig => ({
        host: "127.0.0.1",
        port: 0,
        rpcUrl: net.rpcUrl,
        chainId: net.chainId,
        gatewayPrivateKey,
        evidencePrivateKey: evidenceKey,
        sessionSecret: "session-secret",
        credentialRootKey: "credential-root-key",
        adminToken: "admin",
        dataDir: dir,
        policyYaml: policy("acme"),
        contracts: { usdc: core.usdc, receiptRegistry: core.receiptRegistry, enforcers: core.enforcers },
        principals: { acme: { account: ZERO } },
        asset: { symbol: "USDC", decimals: 6 },
        facilitator: { enabled: false },
        authorizationTtlSeconds: 120,
      });
      for (const key of [runOne, runTwo]) {
        gw = await buildGateway(config(key));
        await gw.ready;
        await gw.anchor("acme");
        if (key === runOne) await gw.close();
      }
      const receipts = await gw!.store.receiptsFor("acme");
      expect(receipts.map((r) => r.kind)).not.toContain("gateway.key.rotated");
      expect(new Set(receipts.map(receiptSigner))).toEqual(new Set([evidence]));
      const bundle = JSON.parse(JSON.stringify(await gw!.exportEvidence("acme"))) as EvidenceBundle;
      expect(bundle.anchors.map((a) => a.party)).toEqual([privateKeyToAccount(runOne).address, privateKeyToAccount(runTwo).address]);
      const report = await verifyEvidence(bundle, { rpcUrl: net.rpcUrl, trustedGatewayKeys: [evidence] });
      expect(report.ok, JSON.stringify(report.checks)).toBe(true);
      expect(report.checks.find((c) => c.check === "anchors.onchain")?.detail).toMatch(/^0x[0-9a-f]{8} @ block \d+; 0x[0-9a-f]{8} @ block \d+$/);
      expect((await verifyEvidence(bundle, { rpcUrl: net.rpcUrl })).ok).toBe(true); // no rotation, so nothing to pin
    } finally {
      await gw?.close();
      net.stop();
    }
  });
});
