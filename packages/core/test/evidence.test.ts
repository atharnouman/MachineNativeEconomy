import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  verifyBundle,
  parsePolicyYaml,
  policyHash,
  receiptHash,
  approvalMessage,
  type EvidenceBundle,
  type Receipt,
  type ReceiptBody,
  type Policy,
} from "../src/index.js";

const gw = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const cfo = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");

const yamlV1 = `
version: 1
principalId: org
budgets: { org: { cap: "1.00" } }
agents: { a: { budget: org } }
rules: [{ id: allow-all, effect: allow }]
`;
const v1 = parsePolicyYaml(yamlV1);
const v2: Policy = { ...v1, budgets: { org: { cap: "2.00", period: "lifetime" } } };

async function sign(body: ReceiptBody): Promise<Receipt> {
  const hash = receiptHash(body);
  return { ...body, hash, sig: await gw.signMessage({ message: { raw: hash } }) };
}

async function chain(items: Array<Partial<ReceiptBody> & { kind: Receipt["kind"]; ts: string }>): Promise<Receipt[]> {
  const out: Receipt[] = [];
  let prev: string | null = null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const r = await sign({ v: 1, id: `r${i}`, principalId: "org", seq: i, prev: prev as ReceiptBody["prev"], data: {}, ...it });
    out.push(r);
    prev = r.hash;
  }
  return out;
}

function bundle(over: Partial<EvidenceBundle>): EvidenceBundle {
  return {
    v: 1,
    principalId: "org",
    exportedAt: new Date().toISOString(),
    gateway: { address: gw.address, chain: "eip155:31337" },
    contracts: {},
    policy: { hash: policyHash(v2), document: v2 },
    policyVersions: [
      { version: 1, hash: policyHash(v1), prevHash: null, activatedAt: "2026-10-08T00:00:00.000Z", document: v1 },
      { version: 2, hash: policyHash(v2), prevHash: policyHash(v1), activatedAt: "2026-10-08T12:00:00.000Z", document: v2 },
    ],
    approvers: { cfo: cfo.address },
    credentials: [],
    receipts: [],
    anchors: [],
    ...over,
  };
}

describe("evidence verifier", () => {
  it("accepts receipts that cite the policy version active at their time", async () => {
    const receipts = await chain([
      { kind: "decision", ts: "2026-10-08T06:00:00.000Z", policyHash: policyHash(v1), data: { effect: "allow" } },
      { kind: "policy.updated", ts: "2026-10-08T12:00:00.000Z", data: { version: 2 } },
      { kind: "decision", ts: "2026-10-08T13:00:00.000Z", policyHash: policyHash(v2), data: { effect: "allow" } },
    ]);
    const r = await verifyBundle(bundle({ receipts }));
    expect(r.ok, JSON.stringify(r.checks)).toBe(true);
  });

  it("rejects a decision citing a policy that was not active yet, and a broken version chain", async () => {
    const receipts = await chain([{ kind: "decision", ts: "2026-10-08T06:00:00.000Z", policyHash: policyHash(v2), data: { effect: "allow" } }]);
    const r = await verifyBundle(bundle({ receipts }));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.check === "receipts.policyHash")?.ok).toBe(false);
    const b = bundle({});
    b.policyVersions[1]!.prevHash = null;
    const r2 = await verifyBundle(b);
    expect(r2.checks.find((c) => c.check === "policy.versions")?.ok).toBe(false);
  });

  it("verifies signed approvals against registered approvers and flags forgeries", async () => {
    const approval = { id: "apr_1", principalId: "org", intentHash: `0x${"ab".repeat(32)}`, amount: "40000" };
    const good = await cfo.signMessage({ message: approvalMessage(approval, "approve") });
    const receipts = await chain([
      { kind: "approval.requested", ts: "2026-10-08T13:00:00.000Z", approvalId: "apr_1", data: { approval } },
      { kind: "approval.granted", ts: "2026-10-08T13:05:00.000Z", approvalId: "apr_1", data: { approval, approver: { id: "cfo", method: "signature", address: cfo.address, signature: good } } },
      { kind: "approval.consumed", ts: "2026-10-08T13:06:00.000Z", approvalId: "apr_1", data: {} },
    ]);
    const ok = await verifyBundle(bundle({ receipts }));
    expect(ok.checks.find((c) => c.check === "approvals")).toMatchObject({ ok: true });

    const forged = await chain([
      { kind: "approval.granted", ts: "2026-10-08T13:05:00.000Z", approvalId: "apr_2", data: { approval: { ...approval, id: "apr_2" }, approver: { id: "cfo", method: "signature", address: cfo.address, signature: good } } },
      { kind: "approval.consumed", ts: "2026-10-08T13:06:00.000Z", approvalId: "apr_9", data: {} },
    ]);
    const bad = await verifyBundle(bundle({ receipts: forged }));
    const check = bad.checks.find((c) => c.check === "approvals");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("signature invalid");
    expect(check?.detail).toContain("consumed without a grant");
  });
});
