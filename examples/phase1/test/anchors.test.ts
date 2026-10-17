import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ReceiptRegistryAbi } from "@spendmarshal/core";
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
        const genesis = gw.store.receiptsFor(principal)[0]!.hash as Hex;
        const [head, count] = await net.pub.readContract({ address: core.receiptRegistry, abi: ReceiptRegistryAbi, functionName: "latest", args: [party, genesis] });
        expect([head, count]).toEqual([last.head, BigInt(last.count)]);
        const report = await verifyEvidence(JSON.parse(JSON.stringify(gw.exportEvidence(principal))), { rpcUrl: net.rpcUrl });
        expect(report.ok, JSON.stringify(report.checks)).toBe(true);
        expect(report.checks.find((c) => c.check === "anchors.onchain")?.ok).toBe(true);
      }
    } finally {
      await gw?.close();
      net.stop();
    }
  });
});
