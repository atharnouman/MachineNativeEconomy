import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { approvalMessage, nowIso, randomId, verifyBundle, type Decision, type EvidenceBundle, type PaymentIntent } from "@spendmarshal/core";
import { buildGateway, type Gateway } from "../src/server.js";
import type { GatewayConfig, PrincipalConfig } from "../src/config.js";
import type { StoreDriver, StoreOptions } from "../src/store.js";
import { drivers, freshStoreOptions } from "./drivers.js";

const ZERO: Address = "0x0000000000000000000000000000000000000000";
const policy = (principalId: string) => `
version: 1
principalId: ${principalId}
budgets: { org: { cap: "1.00" } }
agents: { a: { budget: org } }
rules: [{ id: allow-all, effect: allow }]
`;
// approver keys (anvil dev keys): acme's cfo, globex's cfo and globex's auditor
const acmeCfo = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const globexCfo = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");
const globexAuditor = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const OPERATOR = "operator-admin-token";
const ACME = "acme-admin-token-0001";
const GLOBEX = "globex-admin-token-01";

const principals = (over: Partial<Record<"acme" | "globex", Partial<PrincipalConfig>>> = {}): Record<string, PrincipalConfig> => ({
  acme: { account: ZERO, approvers: { cfo: acmeCfo.address }, adminToken: ACME, ...over.acme },
  globex: { account: ZERO, approvers: { cfo: globexCfo.address, auditor: globexAuditor.address }, adminToken: GLOBEX, ...over.globex },
});

function config(store: StoreOptions, policyFor: string, ps: Record<string, PrincipalConfig> = principals()): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    rpcUrl: "http://127.0.0.1:1",
    chainId: 31337,
    gatewayPrivateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    sessionSecret: "session-secret",
    credentialRootKey: "credential-root-key",
    adminToken: OPERATOR,
    dataDir: store.dataDir,
    storeDriver: store.driver,
    databaseUrl: store.databaseUrl,
    policyYaml: policy(policyFor),
    contracts: { usdc: ZERO, receiptRegistry: ZERO, enforcers: { spendLimit: ZERO, timeWindow: ZERO, allowedTargets: ZERO } },
    principals: ps,
    asset: { symbol: "USDC", decimals: 6 },
    facilitator: { enabled: false },
    authorizationTtlSeconds: 120,
  };
}

/** Both principals with a policy: globex's from an earlier start, acme's from this one. */
async function start(driver: StoreDriver): Promise<Gateway> {
  const dir = await freshStoreOptions(driver, "tenants");
  const first = await buildGateway(config(dir, "globex"));
  await first.ready;
  await first.close();
  const gw = await buildGateway(config(dir, "acme"));
  await gw.ready;
  gw.chain.now = async () => 0n; // the reclaim job reads chain time first; nothing here is on-chain
  return gw;
}

/** An escalated intent's pending approval, as the payment flow creates it. */
async function requestApproval(gw: Gateway, principalId: string) {
  const intent: PaymentIntent = {
    v: 1,
    id: randomId("int"),
    principalId,
    agentId: "a",
    credentialId: "cred_test",
    payee: { url: "https://payee.example/v1/report", host: "payee.example" },
    resource: "/v1/report",
    maxAmount: { asset: "USDC", chain: "eip155:31337", token: ZERO, value: "50000", decimals: 6 },
    purpose: "research",
    rail: "x402",
    createdAt: nowIso(),
  };
  const decision: Decision = { effect: "escalate", reasons: ["RULE_ESCALATE:big"], checks: [], matchedRules: ["big"], budgetPath: ["org"], policyHash: (await gw.policies.activeVersion(principalId)).hash as Hex, amount: "40000" };
  return gw.approvals.request({ intent, decision, amount: 40_000n, rail: "x402", request: { method: "GET" } });
}

async function signed(gw: Gateway, approvalId: string, approverId: string, signer: typeof acmeCfo) {
  const a = (await gw.store.getApproval(approvalId))!;
  return gw.approvals.resolve(approvalId, "approve", { id: approverId, signature: await signer.signMessage({ message: approvalMessage(a, "approve") }) });
}

const registered = async (gw: Gateway, principalId: string) => (await gw.store.receiptsFor(principalId)).filter((r) => r.kind === "approver.registered").map((r) => [r.data.approverId, r.data.address]);
const call = (gw: Gateway, method: "GET" | "POST", url: string, token?: string, payload?: object) =>
  gw.app.inject({ method, url, headers: token ? { "x-admin-token": token } : {}, ...(payload ? { payload } : {}) });

for (const driver of drivers()) {
  describe(`approvers and admin tokens per organisation [${driver}]`, () => {
    it("registers and accepts only a principal's own approvers", async () => {
      const gw = await start(driver);
      expect(await registered(gw, "acme")).toEqual([["cfo", acmeCfo.address]]);
      expect(await registered(gw, "globex")).toEqual([["cfo", globexCfo.address], ["auditor", globexAuditor.address]]);

      const acme = await requestApproval(gw, "acme");
      await expect(signed(gw, acme.id, "auditor", globexAuditor)).rejects.toThrow("approver auditor has no registered key for acme");
      await expect(signed(gw, acme.id, "cfo", globexCfo)).rejects.toThrow("approver signature invalid"); // the same name, another principal's key
      await expect(signed(gw, acme.id, "constructor", acmeCfo)).rejects.toThrow("approver constructor has no registered key for acme");
      expect((await signed(gw, acme.id, "cfo", acmeCfo)).status).toBe("approved");
      const globex = await requestApproval(gw, "globex");
      expect((await signed(gw, globex.id, "auditor", globexAuditor)).status).toBe("approved");

      for (const [principalId, approvers] of [["acme", { cfo: acmeCfo.address }], ["globex", { cfo: globexCfo.address, auditor: globexAuditor.address }]] as const) {
        const bundle = JSON.parse(JSON.stringify((await gw.exportEvidence(principalId)))) as EvidenceBundle;
        expect(bundle.approvers).toEqual(approvers);
        const report = await verifyBundle(bundle);
        expect(report.ok, JSON.stringify(report.checks)).toBe(true);
      }
      await gw.close();
    });

    it("moves a principal from the gateway-wide approvers to its own with key-change receipts in its chain", async () => {
      const dir = await freshStoreOptions(driver, "tenants-move");
      const shared = config(dir, "acme", { acme: { account: ZERO }, globex: { account: ZERO } });
      shared.approvers = { cfo: globexCfo.address, auditor: globexAuditor.address };
      const first = await buildGateway(shared);
      await first.ready;
      await first.close();
      const gw = await buildGateway(config(dir, "acme")); // now acme lists its own cfo, globex the two it had
      await gw.ready;
      const changes = async (principalId: string) => (await gw.store.receiptsFor(principalId)).filter((r) => r.kind.startsWith("approver.")).map((r) => ({ kind: r.kind, ...r.data }));
      expect(await changes("acme")).toEqual([
        { kind: "approver.registered", approverId: "cfo", address: globexCfo.address, prevAddress: null },
        { kind: "approver.registered", approverId: "auditor", address: globexAuditor.address, prevAddress: null },
        { kind: "approver.registered", approverId: "cfo", address: acmeCfo.address, prevAddress: globexCfo.address },
        { kind: "approver.removed", approverId: "auditor", prevAddress: globexAuditor.address },
      ]);
      expect(await changes("globex")).toHaveLength(2);
      const report = await verifyBundle(JSON.parse(JSON.stringify((await gw.exportEvidence("acme")))) as EvidenceBundle);
      expect(report.ok, JSON.stringify(report.checks)).toBe(true);
      await gw.close();
    });

    it("lets a principal's admin token act on that principal only, and changes nothing before checking", async () => {
      const gw = await start(driver);
      const acme = await requestApproval(gw, "acme");
      const globex = await requestApproval(gw, "globex");
      const onlyAcme = { ok: false, status: 403, error: "this admin token acts on acme only" };

      expect((await call(gw, "GET", "/v1/approvals?principalId=acme", ACME)).statusCode).toBe(200);
      expect((await call(gw, "GET", "/v1/approvals?principalId=globex", ACME)).json()).toEqual(onlyAcme);
      expect((await call(gw, "GET", "/v1/evidence/acme", ACME)).statusCode).toBe(200);
      expect((await call(gw, "GET", "/v1/evidence/globex", ACME)).statusCode).toBe(403);
      expect((await call(gw, "GET", "/v1/policies/globex", ACME)).statusCode).toBe(403);
      expect((await call(gw, "GET", "/v1/subscriptions?principalId=globex", ACME)).statusCode).toBe(403);
      expect((await call(gw, "POST", "/v1/killswitch", ACME, { principalId: "globex", on: true })).statusCode).toBe(403);
      expect((await call(gw, "POST", "/v1/receipts/external", ACME, { principalId: "globex", source: "test", data: {} })).statusCode).toBe(403);
      // another principal's approval is left exactly as it was
      expect((await call(gw, "POST", `/v1/approvals/${globex.id}/approve`, ACME, { approverId: "ops" })).statusCode).toBe(403);
      expect((await gw.store.getApproval(globex.id))?.status).toBe("pending");
      // the reclaim job for every principal at once is the operator's
      expect((await call(gw, "POST", "/v1/maintenance/reclaim", ACME, {})).statusCode).toBe(403);
      expect((await call(gw, "POST", "/v1/maintenance/reclaim", ACME, { principalId: "acme" })).statusCode).toBe(200);
      // no token, an unknown one, and the operator's
      expect((await call(gw, "GET", "/v1/approvals?principalId=acme")).statusCode).toBe(401);
      expect((await call(gw, "GET", "/v1/approvals?principalId=acme", "not-a-token")).statusCode).toBe(401);
      for (const p of ["acme", "globex"]) expect((await call(gw, "GET", `/v1/approvals?principalId=${p}`, OPERATOR)).statusCode).toBe(200);
      expect((await call(gw, "POST", "/v1/maintenance/reclaim", OPERATOR, {})).statusCode).toBe(200);

      // within its own principal the token resolves an approval (admin-token method)
      const approved = await call(gw, "POST", `/v1/approvals/${acme.id}/approve`, ACME, { approverId: "ops" });
      expect(approved.statusCode).toBe(200);
      expect((await gw.store.getApproval(acme.id))?.approver).toEqual({ id: "ops", method: "admin-token" });
      await gw.close();
    });

    it("refuses admin tokens that are short or shared, and approvers that are not addresses, before anything is receipted", async () => {
      const dir = () => freshStoreOptions(driver, "tenants-bad");
      await expect(buildGateway(config(await dir(), "acme", principals({ globex: { adminToken: ACME } })))).rejects.toThrow("the admin token of globex is the same as the admin token of acme");
      await expect(buildGateway(config(await dir(), "acme", principals({ acme: { adminToken: OPERATOR + "-but" }, globex: { adminToken: OPERATOR + "-but" } })))).rejects.toThrow("the admin token of globex is the same as the admin token of acme");
      const sameAsOperator = config(await dir(), "acme", principals());
      sameAsOperator.adminToken = ACME;
      await expect(buildGateway(sameAsOperator)).rejects.toThrow("the admin token of acme is the same as the gateway admin token");
      await expect(buildGateway(config(await dir(), "acme", principals({ acme: { adminToken: "short" } })))).rejects.toThrow("the admin token of acme is shorter than 16 characters");
      await expect(buildGateway(config(await dir(), "acme", principals({ acme: { approvers: { cfo: "0x12" as Address } } })))).rejects.toThrow("approver cfo of acme: 0x12 is not an address");
    });
  });
}
