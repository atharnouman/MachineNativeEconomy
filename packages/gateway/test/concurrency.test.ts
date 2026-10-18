import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { nowIso, randomId, verifyBundle, verifyChain, type Credential, type Decision, type EvidenceBundle, type PaymentIntent, type Subscription } from "@spendmarshal/core";
import { buildGateway, type Gateway } from "../src/server.js";
import type { GatewayConfig } from "../src/config.js";
import { openStore, type StoreDriver, type StoreOptions } from "../src/store.js";
import { IdempotencyGuard } from "../src/idempotency.js";
import type { PayResult, ChargeResult } from "../src/pay.js";
import { drivers, freshStoreOptions } from "./drivers.js";

const ZERO: Address = "0x0000000000000000000000000000000000000000";
const GATEWAY_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const cfo = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const policy = (cap = "1.00") => `
version: 1
principalId: org
budgets: { org: { cap: "${cap}" } }
agents: { a: { budget: org } }
rules: [{ id: allow-all, effect: allow }]
`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function config(opts: StoreOptions, policyYaml = policy()): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    rpcUrl: "http://127.0.0.1:1",
    chainId: 31337,
    gatewayPrivateKey: GATEWAY_KEY,
    sessionSecret: "session-secret",
    credentialRootKey: "credential-root-key",
    adminToken: "operator-admin-token",
    dataDir: opts.dataDir,
    storeDriver: opts.driver,
    policyYaml,
    contracts: { usdc: ZERO, receiptRegistry: ZERO, enforcers: { spendLimit: ZERO, timeWindow: ZERO, allowedTargets: ZERO } },
    principals: { org: { account: ZERO } },
    approvers: { cfo: cfo.address },
    asset: { symbol: "USDC", decimals: 6 },
    facilitator: { enabled: false },
    authorizationTtlSeconds: 120,
  };
}

async function start(opts: StoreOptions, policyYaml?: string): Promise<Gateway> {
  const gw = await buildGateway(config(opts, policyYaml));
  await gw.ready;
  return gw;
}

async function requestApproval(gw: Gateway) {
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
  const decision: Decision = { effect: "escalate", reasons: ["RULE_ESCALATE:big"], checks: [], matchedRules: ["big"], budgetPath: ["org"], policyHash: (await gw.policies.activeVersion("org")).hash as Hex, amount: "40000" };
  return gw.approvals.request({ intent, decision, amount: 40_000n, rail: "x402", request: { method: "GET" } });
}

const kinds = async (gw: Gateway) => (await gw.store.receiptsFor("org")).map((r) => r.kind);
const exported = async (gw: Gateway) => JSON.parse(JSON.stringify(await gw.exportEvidence("org"))) as EvidenceBundle;

/** Replaces a private step of the payment service, to hold a lease for a while without a payee or a chain. */
function stub<T>(gw: Gateway, method: "payOnce" | "chargeLeased", run: () => Promise<T>) {
  (gw.payments as unknown as Record<string, () => Promise<T>>)[method] = run;
}

for (const driver of drivers()) {
  describe(`races fixed within one gateway [${driver}]`, () => {
    it("lets only one of two simultaneous resolutions of an approval through, and receipts only that one", async () => {
      const gw = await start(await freshStoreOptions(driver, "race-resolve"));
      const a = await requestApproval(gw);
      const outcomes = await Promise.allSettled([gw.approvals.resolve(a.id, "approve", { id: "ops" }), gw.approvals.resolve(a.id, "reject", { id: "ops" })]);
      const won = outcomes.filter((o) => o.status === "fulfilled");
      expect(won).toHaveLength(1);
      const lost = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
      expect((lost.reason as { statusCode?: number }).statusCode).toBe(409);
      const resolutions = (await kinds(gw)).filter((k) => k === "approval.granted" || k === "approval.rejected");
      expect(resolutions).toHaveLength(1);
      expect((await gw.store.getApproval(a.id))?.status).toBe(resolutions[0] === "approval.granted" ? "approved" : "rejected");
      expect((await verifyBundle(await exported(gw))).ok).toBe(true);
      await gw.close();
    });

    it("runs one payment at a time under an approval: a second one at the same time gets 409", async () => {
      const gw = await start(await freshStoreOptions(driver, "race-approval-use"));
      let running = 0;
      let most = 0;
      stub<PayResult>(gw, "payOnce", async () => {
        most = Math.max(most, ++running);
        await sleep(100);
        running--;
        return { ok: false, status: 502, intent: {} as PaymentIntent, receipts: [], error: "payee unreachable" };
      });
      const cred = { principalId: "org" } as Credential;
      const req = { url: "https://payee.example/v1/report", maxAmount: "0.04", purpose: "research", approvalId: "apr_shared" };
      const outcomes = await Promise.allSettled([gw.payments.pay(cred, req), gw.payments.pay(cred, req)]);
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      expect(((outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult).reason as Error).message).toBe("approval apr_shared is in use by another payment");
      expect(most).toBe(1);
      // the lease is given up when the payment ends, so a retry may run
      expect((await gw.payments.pay(cred, req)).status).toBe(502);
      await gw.close();
    });

    it("runs one charge of a subscription at a time, and checks its terms under the lease", async () => {
      const gw = await start(await freshStoreOptions(driver, "race-charge"));
      const token = "charge-token";
      const sub = { v: 1, id: "sub_1", principalId: "org", agentId: "a", credentialId: "cred_test", payee: { url: "https://payee.example/v1/feed", host: "payee.example", address: ZERO }, resource: "/v1/feed", purpose: "feed", token: ZERO, chain: "eip155:31337", terms: { kind: "fixed", amountPerCharge: "1000", interval: "1h", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }, chargeTokenHash: createHash("sha256").update(token).digest("hex"), chargeUrl: "http://127.0.0.1/v1/subscriptions/sub_1/charges", status: "active", createdAt: nowIso(), charges: 1, totalCharged: "1000" } as Subscription;
      await gw.store.putSubscription(sub);
      let seen: Subscription | undefined;
      (gw.payments as unknown as { chargeLeased: (s: Subscription) => Promise<ChargeResult> }).chargeLeased = async (s) => {
        seen = s;
        await sleep(100);
        return { ok: true, status: 200, subscriptionId: s.id, subscriptionStatus: "active" };
      };
      const [x, y] = await Promise.all([gw.payments.charge("sub_1", token, {}), gw.payments.charge("sub_1", token, {})]);
      expect([x.status, y.status].sort()).toEqual([200, 409]);
      expect([x, y].find((r) => r.status === 409)?.error).toBe("another charge of this subscription is in progress");
      expect(seen?.charges).toBe(1); // read under the lease
      expect((await gw.payments.charge("sub_1", "wrong-token", {})).status).toBe(401);
      await gw.close();
    });

    it("refuses the second of two simultaneous policy updates instead of numbering both version 2", async () => {
      const gw = await start(await freshStoreOptions(driver, "race-policy"));
      const outcomes = await Promise.allSettled([gw.policies.update("org", policy("2.00"), "alice"), gw.policies.update("org", policy("3.00"), "bob")]);
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      expect(((outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult).reason as { statusCode?: number }).statusCode).toBe(409);
      expect((await gw.policies.versions("org")).map((v) => v.version)).toEqual([1, 2]);
      expect((await kinds(gw)).filter((k) => k === "policy.updated")).toHaveLength(2);
      await gw.close();
    });
  });

  describe(`one execution per idempotency key across gateway instances [${driver}]`, () => {
    it("runs a request once when two instances get it at the same time, and replays it to the other", async () => {
      const opts = await freshStoreOptions(driver, "idempotency");
      const a = await openStore(opts);
      const b = driver === "json" ? a : await openStore(opts); // JSON has one process: one handle twice
      let runs = 0;
      const request = async () => {
        runs++;
        await sleep(150);
        return { ok: true, status: 200, n: runs };
      };
      const [x, y] = await Promise.all([new IdempotencyGuard(a).run("cred_1", "key-1", request), new IdempotencyGuard(b).run("cred_1", "key-1", request)]);
      expect(runs).toBe(1);
      expect(x.result).toEqual(y.result);
      expect([x.replayed, y.replayed].sort()).toEqual([false, true]);
      await a.close();
      if (b !== a) await b.close();
    });
  });
}

// JSON keeps its state in one process, so two gateways can only share a SQLite file (and, later, a database).
for (const driver of drivers().filter((d): d is Exclude<StoreDriver, "json"> => d !== "json")) {
  describe(`two gateway instances on one store [${driver}]`, () => {
    it("starting together, they record policy version 1 and each approver once, and keep one chain", async () => {
      const opts = await freshStoreOptions(driver, "two-instances");
      const [one, two] = await Promise.all([start(opts), start(opts)]);
      expect((await one.policies.versions("org")).map((v) => v.version)).toEqual([1]);
      expect(await kinds(one)).toEqual(["policy.updated", "approver.registered"]);
      await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? one : two).receipts.append("org", "external", { i })));
      const rs = await two.store.receiptsFor("org");
      expect(rs.map((r) => r.seq)).toEqual([...Array(10).keys()]);
      expect((await verifyChain(rs, one.signer.address)).ok).toBe(true);
      const report = await verifyBundle(await exported(two));
      expect(report.ok, JSON.stringify(report.checks)).toBe(true);
      await one.close();
      await two.close();
    });

    it("lets one instance resolve an approval and refuses the other's resolution", async () => {
      const opts = await freshStoreOptions(driver, "two-instances-approval");
      const one = await start(opts);
      const two = await start(opts);
      const a = await requestApproval(one);
      const outcomes = await Promise.allSettled([one.approvals.resolve(a.id, "approve", { id: "ops" }), two.approvals.resolve(a.id, "reject", { id: "ops" })]);
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      expect((await kinds(one)).filter((k) => k === "approval.granted" || k === "approval.rejected")).toHaveLength(1);
      expect((await verifyBundle(await exported(one))).ok).toBe(true);
      await one.close();
      await two.close();
    });
  });
}
