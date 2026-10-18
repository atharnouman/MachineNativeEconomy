import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { verifyBundle, verifyReceipt, parsePolicyYaml, policyHash, receiptHash, credentialId, issueRoot, attenuate, toPublic, type EvidenceBundle, type Receipt, type ReceiptBody, type Policy } from "../src/index.js";

// The evidence format v1 (docs/spec/evidence-v1.md, ADR-0026): every hash and equality check reads the bundle as given.

const gw = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const v1 = parsePolicyYaml(`
version: 1
principalId: org
budgets: { org: { cap: "1.00" } }
agents: { a: { budget: org } }
rules: [{ id: allow-all, effect: allow }]
`);

async function sign(body: ReceiptBody): Promise<Receipt> {
  const hash = receiptHash(body);
  return { ...body, hash, sig: await gw.signMessage({ message: { raw: hash } }) };
}

async function chain(items: Array<Partial<ReceiptBody> & { kind: Receipt["kind"] }>): Promise<Receipt[]> {
  const out: Receipt[] = [];
  let prev: string | null = null;
  for (let i = 0; i < items.length; i++) {
    const r = await sign({ v: 1, id: `r${i}`, principalId: "org", seq: i, prev: prev as ReceiptBody["prev"], ts: `2026-10-18T00:00:0${i}.000Z`, data: {}, ...items[i]! });
    out.push(r);
    prev = r.hash;
  }
  return out;
}

const bundle = (over: Partial<EvidenceBundle>): EvidenceBundle => ({
  v: 1,
  principalId: "org",
  exportedAt: "2026-10-18T01:00:00.000Z",
  gateway: { address: gw.address, chain: "eip155:31337" },
  gatewayKeyHistory: [],
  contracts: {},
  policy: { hash: policyHash(v1), document: v1 },
  policyVersions: [{ version: 1, hash: policyHash(v1), prevHash: null, activatedAt: "2026-10-17T00:00:00.000Z", document: v1 }],
  approvers: {},
  approverHistory: {},
  credentials: [],
  receipts: [],
  anchors: [],
  ...over,
});
const check = (r: Awaited<ReturnType<typeof verifyBundle>>, name: string) => r.checks.find((c) => c.check === name);
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("evidence format v1: checks read the bundle as given (ADR-0026)", () => {
  it("refuses a receipt that carries a member its signature does not cover", async () => {
    const [r] = await chain([{ kind: "external", data: { source: "test" } }]);
    const extended = { ...r!, note: "added after signing" } as Receipt;
    expect(await verifyReceipt(extended, gw.address)).toMatchObject({ ok: false });
    const report = await verifyBundle(bundle({ receipts: [extended] }));
    expect(check(report, "schema")?.ok).toBe(false);
    expect((await verifyBundle(bundle({ receipts: [r!] }))).ok).toBe(true);
  });

  it("hashes a policy document as given: an added member or a dropped default breaks its hash", async () => {
    const added = copy(v1) as Policy & { note?: string };
    added.note = "not part of the activated document";
    expect(check(await verifyBundle(bundle({ policy: { hash: policyHash(v1), document: added } })), "policy.hash")?.ok).toBe(false);

    const dropped = copy(v1) as unknown as { budgets: Record<string, { period?: string }> };
    delete dropped.budgets.org!.period; // the default ("lifetime") would come back if the verifier normalised first
    const versions = [{ version: 1, hash: policyHash(v1), prevHash: null, activatedAt: "2026-10-17T00:00:00.000Z", document: dropped as unknown as Policy }];
    const report = await verifyBundle(bundle({ policy: { hash: policyHash(v1), document: dropped as unknown as Policy }, policyVersions: versions }));
    expect(check(report, "policy.hash")?.ok).toBe(false);
    expect(check(report, "policy.versions")?.ok).toBe(false);
  });

  it("derives a credential id from its caveats as given", async () => {
    const root = issueRoot({ rootKey: "k", rootId: "root_1", principalId: "org", agentId: "a", nonce: "n1", caveats: [{ type: "spend_cap", value: "100" }] });
    const pub = toPublic(root);
    expect((await verifyBundle(bundle({ credentials: [pub] }))).ok).toBe(true);
    const padded = copy(pub);
    (padded.caveats[1] as unknown as Record<string, unknown>).extra = "x"; // the schema drops it; the id covers it
    expect(check(await verifyBundle(bundle({ credentials: [padded] })), "credentials.ids")?.ok).toBe(false);
    // a child must extend its parent's caveats exactly
    const child = toPublic(attenuate(root, [{ type: "per_tx_max", value: "10" }], { agentId: "b", nonce: "n2" }));
    expect(child.parentId).toBe(credentialId(root));
    expect((await verifyBundle(bundle({ credentials: [pub, child] }))).ok).toBe(true);
  });

  it("compares the exported gateway key history as given", async () => {
    const receipts = await chain([{ kind: "external", data: {} }]);
    const report = await verifyBundle(bundle({ receipts, gatewayKeyHistory: [{ address: gw.address, prevAddress: gw.address, seq: 0, effectiveFrom: "2026-10-18T00:00:00.000Z", receiptId: "r0", handedOver: true }] }));
    expect(check(report, "gateway.keys")?.ok).toBe(false);
  });

  it("requires a consumed approval to have been granted earlier in the chain", async () => {
    const granted = await chain([
      { kind: "approval.granted", approvalId: "apr_1", data: { approver: { id: "ops", method: "admin-token" } } },
      { kind: "approval.consumed", approvalId: "apr_1", data: {} },
    ]);
    expect(check(await verifyBundle(bundle({ receipts: granted })), "approvals")?.ok).toBe(true);
    const late = await chain([
      { kind: "approval.consumed", approvalId: "apr_1", data: {} },
      { kind: "approval.granted", approvalId: "apr_1", data: { approver: { id: "ops", method: "admin-token" } } },
    ]);
    expect(check(await verifyBundle(bundle({ receipts: late })), "approvals")?.ok).toBe(false);
  });

  it("requires every settlement to name its intent, with an allow decision for it earlier in the chain", async () => {
    const ok = await chain([
      { kind: "decision", intentId: "int_1", data: { effect: "allow" } },
      { kind: "payment.settled", intentId: "int_1", data: {} },
    ]);
    expect(check(await verifyBundle(bundle({ receipts: ok })), "settlements.have_allow_decision")?.ok).toBe(true);
    const late = await chain([
      { kind: "payment.settled", intentId: "int_1", data: {} },
      { kind: "decision", intentId: "int_1", data: { effect: "allow" } },
    ]);
    expect(check(await verifyBundle(bundle({ receipts: late })), "settlements.have_allow_decision")?.ok).toBe(false);
    const nameless = await chain([
      { kind: "decision", data: { effect: "allow" } },
      { kind: "payment.settled", data: {} },
    ]);
    expect(check(await verifyBundle(bundle({ receipts: nameless })), "settlements.have_allow_decision")?.ok).toBe(false);
  });
});
