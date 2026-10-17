import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  verifyBundle,
  approverKeyHistory,
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
const cfoRotated = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");
const ceo = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");

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
    gatewayKeyHistory: [],
    contracts: {},
    policy: { hash: policyHash(v2), document: v2 },
    policyVersions: [
      { version: 1, hash: policyHash(v1), prevHash: null, activatedAt: "2026-10-08T00:00:00.000Z", document: v1 },
      { version: 2, hash: policyHash(v2), prevHash: policyHash(v1), activatedAt: "2026-10-08T12:00:00.000Z", document: v2 },
    ],
    approvers: { cfo: cfo.address },
    approverHistory: {},
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

describe("approver key history", () => {
  const ts = (minute: number) => `2026-10-11T10:${String(minute).padStart(2, "0")}:00.000Z`;
  const approval = (id: string) => ({ id, principalId: "org", intentHash: `0x${id.slice(-1).repeat(64)}`, amount: "40000" });
  type Signer = typeof cfo;
  /** An `approval.granted` receipt signed by `signer`, claiming `claimed` (default: the signer) as the approver's address. */
  const granted = async (id: string, minute: number, signer: Signer, approverId = "cfo", claimed: string = signer.address) => ({
    kind: "approval.granted" as const,
    ts: ts(minute),
    approvalId: id,
    data: { approval: approval(id), approver: { id: approverId, method: "signature", address: claimed, signature: await signer.signMessage({ message: approvalMessage(approval(id), "approve") }) } },
  });
  const registered = (minute: number, address: string, prevAddress: string | null, approverId = "cfo") => ({ kind: "approver.registered" as const, ts: ts(minute), data: { approverId, address, prevAddress } });
  const removed = (minute: number, prevAddress: string, approverId = "cfo") => ({ kind: "approver.removed" as const, ts: ts(minute), data: { approverId, prevAddress } });
  /** A bundle as the gateway exports it after the rotation: the current key in `approvers`, the history read from the chain. */
  const exported = (receipts: Receipt[], approvers: Record<string, string> = { cfo: cfoRotated.address }) => bundle({ receipts, approvers, approverHistory: approverKeyHistory(receipts) });
  const check = (r: Awaited<ReturnType<typeof verifyBundle>>, name: string) => r.checks.find((c) => c.check === name);

  it("verifies each approval against the key in force at its position, before and after a rotation", async () => {
    const receipts = await chain([
      registered(0, cfo.address, null),
      await granted("apr_1", 1, cfo),
      registered(2, cfoRotated.address, cfo.address),
      await granted("apr_2", 3, cfoRotated),
    ]);
    const r = await verifyBundle(exported(receipts));
    expect(r.ok, JSON.stringify(r.checks)).toBe(true);
    expect(check(r, "approvers.history")?.detail).toBe(`cfo: ${cfo.address.slice(0, 6)}…${cfo.address.slice(-4)} from #0, ${cfoRotated.address.slice(0, 6)}…${cfoRotated.address.slice(-4)} from #2`);
    expect(check(r, "approvals")?.detail).toBe("2 granted, 2 signature-verified");
    expect(exported(receipts).approverHistory.cfo?.map((k) => [k.address, k.seq, k.effectiveFrom])).toEqual([
      [cfo.address, 0, ts(0)],
      [cfoRotated.address, 2, ts(2)],
    ]);

    // the same approvals without key history: the old one is checked against today's key and fails (the live-run failure)
    const legacy = await chain([await granted("apr_1", 1, cfo), await granted("apr_2", 3, cfoRotated)]);
    const before = await verifyBundle(exported(legacy));
    expect(check(before, "approvers.history")).toMatchObject({ ok: true, detail: "none: signed approvals verify against the approvers map" });
    expect(check(before, "approvals")).toMatchObject({ ok: false });
    expect(check(before, "approvals")?.detail).toContain("r0: approver address mismatch");
  });

  it("rejects an old approval forged with the new key", async () => {
    // claims the new key: not the key in force at its position
    const claimsNew = await chain([registered(0, cfo.address, null), await granted("apr_1", 1, cfoRotated), registered(2, cfoRotated.address, cfo.address)]);
    const r1 = await verifyBundle(exported(claimsNew));
    expect(r1.ok).toBe(false);
    expect(check(r1, "approvals")?.detail).toContain("r1: approver address mismatch");

    // claims the old key but carries the new key's signature
    const claimsOld = await chain([registered(0, cfo.address, null), await granted("apr_1", 1, cfoRotated, "cfo", cfo.address), registered(2, cfoRotated.address, cfo.address)]);
    const r2 = await verifyBundle(exported(claimsOld));
    expect(r2.ok).toBe(false);
    expect(check(r2, "approvals")?.detail).toContain("r1: approver signature invalid");

    // the same forgery placed before the chain's key history is checked against the first registered key, not today's
    const beforeHistory = await chain([await granted("apr_1", 0, cfoRotated), registered(1, cfo.address, null), registered(2, cfoRotated.address, cfo.address)]);
    const r3 = await verifyBundle(exported(beforeHistory));
    expect(r3.ok).toBe(false);
    expect(check(r3, "approvals")?.detail).toContain("r0: approver address mismatch");
  });

  it("verifies approvals written before the chain had key history against the first registered key (an upgraded store)", async () => {
    const receipts = await chain([
      await granted("apr_1", 0, cfo), // an older gateway wrote this one: no registration precedes it
      registered(1, cfo.address, null), // the upgraded gateway registers the key it was started with
      registered(2, cfoRotated.address, cfo.address),
      await granted("apr_2", 3, cfoRotated),
    ]);
    const r = await verifyBundle(exported(receipts));
    expect(r.ok, JSON.stringify(r.checks)).toBe(true);
    expect(check(r, "approvals")?.detail).toBe("2 granted, 2 signature-verified; 1 from before key history");
  });

  it("gives a removed approver no key, and an approver missing from a chain with key history none either", async () => {
    const afterRemoval = await chain([registered(0, cfo.address, null), removed(1, cfo.address), await granted("apr_1", 2, cfo)]);
    const r1 = await verifyBundle(exported(afterRemoval, { cfo: cfo.address }));
    expect(r1.ok).toBe(false);
    expect(check(r1, "approvers.history")?.ok).toBe(true);
    expect(check(r1, "approvals")?.detail).toContain("r2: approver cfo was removed at #1");

    // the approvers map names the ceo, but the chain never registered a key for it once history had begun
    const unregistered = await chain([registered(0, cfo.address, null), await granted("apr_1", 1, ceo, "ceo")]);
    const r2 = await verifyBundle(exported(unregistered, { cfo: cfo.address, ceo: ceo.address }));
    expect(r2.ok).toBe(false);
    expect(check(r2, "approvals")?.detail).toContain("r1: approver ceo had no registered key at #1");
  });

  it("requires the exported history to match the receipts, and each registration to name the key it replaces", async () => {
    const receipts = await chain([registered(0, cfo.address, null), registered(1, cfoRotated.address, cfo.address)]);
    const tampered = exported(receipts);
    tampered.approverHistory.cfo![1]!.address = ceo.address;
    expect(check(await verifyBundle(tampered), "approvers.history")).toMatchObject({ ok: false, detail: "approverHistory.cfo does not match the receipts" });
    const dropped = bundle({ receipts, approverHistory: {} });
    expect(check(await verifyBundle(dropped), "approvers.history")?.ok).toBe(false);

    const skipped = await chain([registered(0, cfo.address, null), registered(1, cfoRotated.address, ceo.address)]);
    expect(check(await verifyBundle(exported(skipped)), "approvers.history")?.detail).toContain("r1: prevAddress is not the key cfo held before it");
    const malformed = await chain([registered(0, "0x1234", null)]);
    expect(check(await verifyBundle(exported(malformed)), "approvers.history")?.detail).toContain("r0: malformed approver.registered");
  });
});
