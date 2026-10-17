import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  verifyBundle,
  verifyChain,
  parsePolicyYaml,
  policyHash,
  receiptHash,
  receiptSigner,
  gatewayKeyAt,
  gatewayKeyHandoverMessage,
  gatewayKeyHistory,
  type EvidenceBundle,
  type Receipt,
  type ReceiptBody,
} from "../src/index.js";

// four gateway keys (anvil dev keys): three generations and an attacker's
const k1 = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const k2 = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const k3 = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const mallory = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");
type Key = typeof k1;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const policy = parsePolicyYaml(`
version: 1
principalId: org
budgets: { org: { cap: "1.00" } }
agents: { a: { budget: org } }
rules: [{ id: allow-all, effect: allow }]
`);

/** A receipt, or a rotation to `to` with a handover signed by `handover` (null: none; `{ sig }`: that signature as is). */
type Step = { by: Key; kind?: Receipt["kind"]; data?: Record<string, unknown> } | { rotate: { from: Key; to: Key; handover: Key | null | { sig: unknown }; by?: Key } };

async function chain(steps: Step[], principalId = "org"): Promise<Receipt[]> {
  const out: Receipt[] = [];
  let prev: string | null = null;
  for (const [seq, s] of steps.entries()) {
    let by: Key;
    let kind: Receipt["kind"];
    let data: Record<string, unknown>;
    if ("rotate" in s) {
      const { from, to, handover } = s.rotate;
      const message = gatewayKeyHandoverMessage({ principalId, seq, prev, prevAddress: from.address, address: to.address });
      by = s.rotate.by ?? to;
      kind = "gateway.key.rotated";
      data = { prevAddress: from.address, address: to.address, handover: handover === null ? null : "sig" in handover ? handover.sig : await handover.signMessage({ message }) };
    } else {
      by = s.by;
      kind = s.kind ?? "decision";
      data = s.data ?? { effect: "allow" };
    }
    const body: ReceiptBody = { v: 1, id: `r${seq}`, principalId, seq, prev: prev as ReceiptBody["prev"], ts: new Date(Date.UTC(2026, 9, 17, 9, seq)).toISOString(), kind, data };
    const hash = receiptHash(body);
    out.push({ ...body, hash, sig: await by.signMessage({ message: { raw: hash } }) });
    prev = hash;
  }
  return out;
}

/** The bundle a gateway exports: the key the chain ends with, and its rotations. */
function bundle(receipts: Receipt[], over: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    v: 1,
    principalId: "org",
    exportedAt: new Date().toISOString(),
    gateway: { address: receipts.length ? receiptSigner(receipts[receipts.length - 1]!) : k1.address, chain: "eip155:31337" },
    gatewayKeyHistory: gatewayKeyHistory(receipts),
    contracts: {},
    policy: { hash: policyHash(policy), document: policy },
    policyVersions: [],
    approvers: {},
    approverHistory: {},
    credentials: [],
    receipts,
    anchors: [],
    ...over,
  };
}

const check = (r: Awaited<ReturnType<typeof verifyBundle>>, name: string) => r.checks.find((c) => c.check === name);

// k1 signs #0-#1, hands over to k2 at #2, k2 signs #3, k3 takes over at #4 without a handover (k2 was lost), k3 signs #5
const generations = (): Promise<Receipt[]> =>
  chain([
    { by: k1 },
    { by: k1 },
    { rotate: { from: k1, to: k2, handover: k1 } },
    { by: k2 },
    { rotate: { from: k2, to: k3, handover: null } },
    { by: k3 },
  ]);

/** The `gateway.trusted` check of a chain's bundle, with the given keys pinned (none: the default report). */
const trustCheck = async (receipts: Receipt[], keys?: string[]) => check(await verifyBundle(bundle(receipts), keys ? { trustedGatewayKeys: keys } : {}), "gateway.trusted");
const unlinked = (from: number, to: number, key: Key) => `receipts #${from}–#${to} were signed by ${short(key.address)}, which is neither trusted nor linked to a trusted key by handovers`;

describe("gateway key history", () => {
  it("verifies each receipt against the key in force at its position", async () => {
    const receipts = await generations();
    const v = await verifyChain(receipts, k3.address);
    expect(v.ok, v.problems.join("; ")).toBe(true);
    expect(v.keys).toEqual([
      { address: k2.address, prevAddress: k1.address, seq: 2, effectiveFrom: receipts[2]!.ts, receiptId: "r2", handedOver: true },
      { address: k3.address, prevAddress: k2.address, seq: 4, effectiveFrom: receipts[4]!.ts, receiptId: "r4", handedOver: false },
    ]);
    const report = await verifyBundle(JSON.parse(JSON.stringify(bundle(receipts))));
    expect(check(report, "receipts.chain")?.ok).toBe(true);
    expect(check(report, "gateway.keys")?.detail).toBe(`${short(k1.address)} from #0; ${short(k2.address)} from #2 (handed over); ${short(k3.address)} from #4 (no handover)`);
    // the rotation at #4 has no handover, so without pinned keys the bundle does not verify (ADR-0022)
    expect(report.ok).toBe(false);
    expect(check(report, "gateway.trusted")).toEqual({ check: "gateway.trusted", ok: false, detail: `rotation without a handover at #4 (${short(k2.address)} → ${short(k3.address)}): pin the gateway keys you trust` });
    // handovers alone need no pin, and add no check
    const handedOver = await verifyBundle(bundle(await chain([{ by: k1 }, { rotate: { from: k1, to: k2, handover: k1 } }, { by: k2 }])));
    expect(handedOver.ok, JSON.stringify(handedOver.checks)).toBe(true);
    expect(check(handedOver, "gateway.trusted")).toBeUndefined();
  });

  it("fails the same keys without rotation receipts, as the live run did before key history", async () => {
    const receipts = await chain([{ by: k1 }, { by: k1 }, { by: k2 }, { by: k2 }]);
    const v = await verifyChain(receipts, k2.address);
    expect(v.ok).toBe(false);
    expect(v.problems).toEqual([`r0: signer ${k1.address} is not gateway`, `r1: signer ${k1.address} is not gateway`]);
  });

  it("reports a bundle without rotations exactly as before gateway key history", async () => {
    const report = await verifyBundle(bundle(await chain([{ by: k1 }, { by: k1 }])));
    expect(report.ok).toBe(true);
    // no gateway.keys check: the list is the one from before ADR-0020 (approvers.history comes from ADR-0019)
    expect(report.checks.map((c) => c.check)).toEqual(["schema", "policy.hash", "policy.versions", "receipts.chain", "receipts.policyHash", "credentials.ids", "credentials.monotonic", "anchors.match", "settlements.have_allow_decision", "approvers.history", "approvals"]);
    expect(check(report, "receipts.chain")?.detail).toBe("2 receipts");
  });

  it("trusts a chain only when every key that signed it is pinned or linked to a pinned key by handovers", async () => {
    // a handover links the keys on both sides, whichever of them is pinned
    const handedOver = await chain([{ by: k1 }, { rotate: { from: k1, to: k2, handover: k1 } }, { by: k2 }]);
    expect(await trustCheck(handedOver, [k1.address.toLowerCase()])).toEqual({ check: "gateway.trusted", ok: true, detail: `trusted ${short(k1.address)}; handed over ${short(k2.address)}` });
    expect(await trustCheck(handedOver, [k2.address])).toEqual({ check: "gateway.trusted", ok: true, detail: `trusted ${short(k2.address)}; handed over ${short(k1.address)}` });

    // a rotation without a handover links neither side: both have to be pinned
    const receipts = await generations();
    expect((await trustCheck(receipts, [k1.address]))?.detail).toBe(unlinked(4, 5, k3));
    expect((await trustCheck(receipts, [k2.address]))?.detail).toBe(unlinked(4, 5, k3));
    expect((await trustCheck(receipts, [k3.address]))?.detail).toBe(unlinked(0, 1, k1));
    expect(await trustCheck(receipts, [k1.address, k3.address])).toEqual({ check: "gateway.trusted", ok: true, detail: `trusted ${short(k1.address)}, ${short(k3.address)}; handed over ${short(k2.address)}` });

    // a chain without rotations: the pin is the old manual comparison with the gateway address
    const single = await chain([{ by: k1 }, { by: k1 }]);
    expect((await trustCheck(single, [k1.address]))?.ok).toBe(true);
    expect((await trustCheck(single, [k2.address]))?.detail).toBe(unlinked(0, 1, k1));
  });

  it("fails a chain someone extended under a key of their own, unpinned or pinned to the gateway's key", async () => {
    // someone with a copy of the store but no gateway key continues the chain under their own key
    const honest = await chain([{ by: k1 }, { by: k1 }]);
    const forged = await chain([{ by: k1 }, { by: k1 }, { rotate: { from: k1, to: mallory, handover: null } }, { by: mallory, kind: "payment.settled", data: {} }]);
    expect(forged.slice(0, 2)).toEqual(honest);
    const unpinned = await verifyBundle(bundle(forged));
    expect(check(unpinned, "receipts.chain")?.ok).toBe(true); // consistent on its own terms, as a chain under any one key always was
    expect(unpinned.ok).toBe(false);
    expect(check(unpinned, "gateway.trusted")?.detail).toBe(`rotation without a handover at #2 (${short(k1.address)} → ${short(mallory.address)}): pin the gateway keys you trust`);
    expect((await trustCheck(forged, [k1.address]))?.detail).toBe(unlinked(2, 3, mallory));
  });

  it("does not let a pinned key that took over a foreign head cover the receipts before it (the review's attack on ADR-0020)", async () => {
    // an attacker's receipts in the middle, then a gateway that continued the chain without checking its head
    const laundered = await chain([
      { by: k1 },
      { by: k1 },
      { rotate: { from: k1, to: mallory, handover: null } },
      { by: mallory },
      { by: mallory, kind: "payment.settled", data: {} },
      { rotate: { from: mallory, to: k1, handover: null } },
      { by: k1 },
    ]);
    expect(await trustCheck(laundered, [k1.address])).toEqual({ check: "gateway.trusted", ok: false, detail: unlinked(2, 4, mallory) });
    expect((await trustCheck(laundered))?.ok).toBe(false);
    expect((await trustCheck(laundered, [k1.address, mallory.address]))?.ok).toBe(true); // only an auditor who trusts both keys accepts it
    // the same when the attacker's receipts open the chain
    const adopted = await chain([{ by: mallory }, { by: mallory }, { rotate: { from: mallory, to: k1, handover: null } }, { by: k1 }]);
    expect((await trustCheck(adopted, [k1.address]))?.detail).toBe(unlinked(0, 1, mallory));
  });

  it("carries trust through every handover a pinned key signs, whoever receives it", async () => {
    // a stolen key can hand over to its thief: rotate away from a key, with a handover, as soon as it may have leaked
    const handedToThief = await chain([{ by: k1 }, { rotate: { from: k1, to: mallory, handover: k1 } }, { by: mallory }]);
    expect(await trustCheck(handedToThief, [k1.address])).toEqual({ check: "gateway.trusted", ok: true, detail: `trusted ${short(k1.address)}; handed over ${short(mallory.address)}` });
  });

  it("rejects rotations that misname the key in force, forge or replay a handover, or keep signing with the old key", async () => {
    const problems = async (steps: Step[], gateway: string) => (await verifyChain(await chain(steps), gateway)).problems.join("; ");

    // a rotation must name the key it replaces; misnaming the first one disowns every receipt before it
    expect(await problems([{ by: k1 }, { rotate: { from: k1, to: k2, handover: k1 } }, { rotate: { from: mallory, to: k3, handover: mallory } }], k3.address)).toBe(`r2: hands over from ${mallory.address}, but ${k2.address} was in force`);
    expect(await problems([{ by: k1 }, { rotate: { from: mallory, to: k2, handover: mallory } }], k2.address)).toBe(`r0: signer ${k1.address} is not gateway`);
    // the handover must be the previous key's signature: the new key cannot sign its own
    expect(await problems([{ by: k1 }, { rotate: { from: k1, to: mallory, handover: mallory } }, { by: mallory }], mallory.address)).toBe(`r1: handover is not signed by ${k1.address}`);
    // a real handover only holds at its own position: replayed one receipt later, or in another principal's chain, it fails
    const real = (await chain([{ by: k1 }, { rotate: { from: k1, to: k2, handover: k1 } }]))[1]!.data.handover;
    expect(await problems([{ by: k1 }, { by: k1 }, { rotate: { from: k1, to: k2, handover: { sig: real } } }], k2.address)).toBe(`r2: handover is not signed by ${k1.address}`);
    expect((await verifyChain(await chain([{ by: k1 }, { rotate: { from: k1, to: k2, handover: { sig: real } } }], "globex"), k2.address)).problems).toEqual([`r1: handover is not signed by ${k1.address}`]);
    // after a rotation the old key no longer signs, and the rotation itself is signed by the new key
    expect(await problems([{ by: k1 }, { rotate: { from: k1, to: k2, handover: k1 } }, { by: k1 }], k2.address)).toBe(`r2: signer ${k1.address} is not gateway`);
    expect(await problems([{ by: k1 }, { rotate: { from: k1, to: k2, handover: k1, by: k1 } }, { by: k2 }], k2.address)).toBe(`r1: signer ${k1.address} is not gateway`);
    // the bundle must name the key the chain ends with
    expect(await problems([{ by: k1 }, { rotate: { from: k1, to: k2, handover: k1 } }], k1.address)).toBe(`chain ends with gateway key ${k2.address}, expected ${k1.address}`);
    // a rotation to the key already in force, and one without its fields, are malformed history
    expect(await problems([{ by: k1 }, { rotate: { from: k1, to: k1, handover: null } }], k1.address)).toBe("r1: rotates to the key already in force");
    expect(await problems([{ by: k1 }, { by: k2, kind: "gateway.key.rotated", data: { prevAddress: k1.address, address: k2.address } }], k2.address)).toContain("r1: malformed gateway.key.rotated");
  });

  it("requires the exported history to match the receipts", async () => {
    const receipts = await generations();
    const flipped = bundle(receipts);
    flipped.gatewayKeyHistory[1]!.handedOver = true;
    expect(check(await verifyBundle(flipped), "gateway.keys")).toEqual({ check: "gateway.keys", ok: false, detail: "gatewayKeyHistory does not match the receipts" });
    const { gatewayKeyHistory: _omitted, ...missing } = bundle(receipts);
    expect(check(await verifyBundle(missing as EvidenceBundle), "gateway.keys")?.ok).toBe(false);
    const invented = bundle(await chain([{ by: k1 }]), { gatewayKeyHistory: gatewayKeyHistory(receipts) });
    expect(check(await verifyBundle(invented), "gateway.keys")?.ok).toBe(false);
  });

  it("requires an anchor that names its sender to name the key that signed the anchored receipt", async () => {
    const receipts = await generations();
    const anchor = (count: number, party?: string) => ({ head: receipts[count - 1]!.hash, count, txHash: "0x1", blockNumber: "1", registry: "0x9", ...(party ? { party } : {}) });
    const ok = await verifyBundle(bundle(receipts, { anchors: [anchor(2, k1.address), anchor(4, k2.address), anchor(6, k3.address), anchor(6)] }));
    expect(check(ok, "anchors.match")).toEqual({ check: "anchors.match", ok: true, detail: "4 anchors" });
    const wrong = await verifyBundle(bundle(receipts, { anchors: [anchor(4, k1.address)] }));
    expect(check(wrong, "anchors.match")?.detail).toBe(`anchor ${receipts[3]!.hash.slice(0, 10)} was sent by ${k1.address}, not by the key that signed receipt #4`);
  });

  it("names the key that signed any position, which is the sender of an anchor that records none", async () => {
    const keys = gatewayKeyHistory(await generations());
    expect([0, 1, 2, 3, 4, 5].map((seq) => gatewayKeyAt(keys, k3.address, seq))).toEqual([k1, k1, k2, k2, k3, k3].map((k) => k.address));
    expect(gatewayKeyAt([], k1.address, 7)).toBe(k1.address);
  });

  it("recovers a receipt's signer synchronously", async () => {
    const [r0, r1] = await chain([{ by: k1 }, { rotate: { from: k1, to: k2, handover: k1 } }]);
    expect(receiptSigner(r0!)).toBe(k1.address);
    expect(receiptSigner(r1!)).toBe(k2.address);
    expect(() => receiptSigner({ hash: r0!.hash, sig: "0x1234" })).toThrow("not 65 bytes");
  });
});
