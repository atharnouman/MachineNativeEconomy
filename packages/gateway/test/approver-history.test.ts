import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { approvalMessage, nowIso, randomId, verifyBundle, type Decision, type PaymentIntent } from "@spendmarshal/core";
import { buildGateway, type Gateway } from "../src/server.js";
import type { GatewayConfig, PrincipalConfig } from "../src/config.js";
import type { StoreDriver } from "../src/store.js";

const ZERO: Address = "0x0000000000000000000000000000000000000000";
const POLICY = `
version: 1
principalId: org
budgets: { org: { cap: "1.00" } }
agents: { a: { budget: org } }
rules: [{ id: allow-all, effect: allow }]
`;
// three generations of the CFO's approval key (anvil dev keys)
const keyA = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const keyB = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");
const keyC = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");

/** A gateway on an existing store; the chain is never contacted (no payment runs here). */
function config(dataDir: string, driver: StoreDriver, approvers: Record<string, Address>, principals: Record<string, PrincipalConfig> = { org: { account: ZERO } }): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    rpcUrl: "http://127.0.0.1:1",
    chainId: 31337,
    gatewayPrivateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // the same gateway key in every run
    sessionSecret: "session-secret",
    credentialRootKey: "credential-root-key",
    adminToken: "admin",
    dataDir,
    storeDriver: driver,
    policyYaml: POLICY,
    contracts: { usdc: ZERO, receiptRegistry: ZERO, enforcers: { spendLimit: ZERO, timeWindow: ZERO, allowedTargets: ZERO } },
    principals,
    asset: { symbol: "USDC", decimals: 6 },
    facilitator: { enabled: false },
    authorizationTtlSeconds: 120,
    approvers,
  };
}

async function start(cfg: GatewayConfig): Promise<Gateway> {
  const gw = await buildGateway(cfg);
  await gw.ready;
  return gw;
}

/** An escalated intent's pending approval, as the payment flow creates it. */
function requestApproval(gw: Gateway) {
  const intent: PaymentIntent = {
    v: 1,
    id: randomId("int"),
    principalId: "org",
    agentId: "a",
    credentialId: "cred_test",
    payee: { url: "https://payee.example/v1/report", host: "payee.example" },
    resource: "/v1/report",
    maxAmount: { asset: "USDC", chain: "eip155:31337", token: ZERO, value: "50000", decimals: 6 },
    purpose: "research",
    rail: "x402",
    createdAt: nowIso(),
  };
  const decision: Decision = { effect: "escalate", reasons: ["RULE_ESCALATE:big"], checks: [], matchedRules: ["big"], budgetPath: ["org"], policyHash: gw.policies.activeVersion("org").hash as Hex, amount: "40000" };
  return gw.approvals.request({ intent, decision, amount: 40_000n, rail: "x402", request: { method: "GET" } });
}

async function approve(gw: Gateway, approvalId: string, signer: typeof keyA) {
  const a = gw.store.getApproval(approvalId)!;
  return gw.approvals.resolve(approvalId, "approve", { id: "cfo", signature: await signer.signMessage({ message: approvalMessage(a, "approve") }) });
}

const kinds = (gw: Gateway) => gw.store.receiptsFor("org").map((r) => r.kind);

for (const driver of ["json", "sqlite"] as StoreDriver[]) {
  describe(`approver key history [${driver}]`, () => {
    it("keeps every approval verifiable when the approver's key rotates between runs on one store", async () => {
      const dir = mkdtempSync(join(tmpdir(), `spendmarshal-approvers-${driver}-`));

      // run 1: the CFO signs with key A
      let gw = await start(config(dir, driver, { cfo: keyA.address }));
      expect(kinds(gw)).toEqual(["policy.updated", "approver.registered"]);
      await approve(gw, (await requestApproval(gw)).id, keyA);
      await gw.close();

      // run 2: the key is rotated to B. The chain records it before anything else happens, and A no longer signs.
      gw = await start(config(dir, driver, { cfo: keyB.address }));
      expect(kinds(gw).slice(4)).toEqual(["approver.registered"]);
      expect(gw.store.receiptsFor("org")[4]!.data).toEqual({ approverId: "cfo", address: keyB.address, prevAddress: keyA.address });
      const second = await requestApproval(gw);
      await expect(approve(gw, second.id, keyA)).rejects.toThrow("approver signature invalid");
      await approve(gw, second.id, keyB);
      const bundle = gw.exportEvidence("org");
      expect(bundle.approvers).toEqual({ cfo: keyB.address });
      expect(bundle.approverHistory.cfo?.map((k) => [k.address, k.seq])).toEqual([
        [keyA.address, 1],
        [keyB.address, 4],
      ]);
      const report = await verifyBundle(JSON.parse(JSON.stringify(bundle)));
      expect(report.ok, JSON.stringify(report.checks)).toBe(true);
      expect(report.checks.find((c) => c.check === "approvals")?.detail).toBe("2 granted, 2 signature-verified");
      await gw.close();

      // run 3: same key again: nothing new is registered; an approval is left pending
      gw = await start(config(dir, driver, { cfo: keyB.address }));
      expect(kinds(gw).filter((k) => k === "approver.registered")).toHaveLength(2);
      const pending = await requestApproval(gw);
      await gw.close();

      // run 4: this gateway no longer serves the principal, and the key is rotated to C. Startup leaves the principal's
      // chain alone; resolving its pending approval registers C right before the grant it signs.
      gw = await start(config(dir, driver, { cfo: keyC.address }, {}));
      const before = gw.store.receiptsFor("org").length;
      await approve(gw, pending.id, keyC);
      expect(kinds(gw).slice(before)).toEqual(["approver.registered", "approval.granted"]);
      const later = gw.exportEvidence("org");
      expect(later.approverHistory.cfo?.map((k) => k.address)).toEqual([keyA.address, keyB.address, keyC.address]);
      const again = await verifyBundle(JSON.parse(JSON.stringify(later)));
      expect(again.ok, JSON.stringify(again.checks)).toBe(true);
      expect(again.checks.find((c) => c.check === "approvals")?.detail).toBe("3 granted, 3 signature-verified");

      // removing the approver is receipted too, and the bundle still verifies every earlier approval
      await gw.close();
      gw = await start(config(dir, driver, {}));
      expect(kinds(gw).at(-1)).toBe("approver.removed");
      const removed = await verifyBundle(JSON.parse(JSON.stringify(gw.exportEvidence("org"))));
      expect(removed.ok, JSON.stringify(removed.checks)).toBe(true);
      await gw.close();
    });

    it("refuses to start with an approver key that is not an address", async () => {
      const dir = mkdtempSync(join(tmpdir(), `spendmarshal-approvers-${driver}-`));
      await expect(buildGateway(config(dir, driver, { cfo: "0x1234" as Address }))).rejects.toThrow("approver cfo: 0x1234 is not an address");
    });
  });
}
