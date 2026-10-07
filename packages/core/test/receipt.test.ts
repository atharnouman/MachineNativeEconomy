import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { receiptHash, verifyChain, verifyReceipt, type Receipt, type ReceiptBody } from "../src/index.js";

const gw = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

async function sign(body: ReceiptBody): Promise<Receipt> {
  const hash = receiptHash(body);
  const sig = await gw.signMessage({ message: { raw: hash } });
  return { ...body, hash, sig };
}

function body(seq: number, prev: string | null, kind: Receipt["kind"] = "decision"): ReceiptBody {
  return { v: 1, id: `rcpt_${seq}`, principalId: "org", seq, prev: prev as ReceiptBody["prev"], ts: new Date().toISOString(), kind, data: { effect: "allow" } };
}

describe("receipts", () => {
  it("signs, verifies, and chains", async () => {
    const r0 = await sign(body(0, null));
    const r1 = await sign(body(1, r0.hash, "payment.settled"));
    expect(await verifyReceipt(r0, gw.address)).toEqual({ ok: true });
    const chain = await verifyChain([r0, r1], gw.address);
    expect(chain.ok).toBe(true);
    expect(chain.head).toBe(r1.hash);
  });

  it("detects tampering, wrong signer, and broken links", async () => {
    const r0 = await sign(body(0, null));
    const r1 = await sign(body(1, r0.hash));
    const tampered = { ...r1, data: { effect: "deny" } };
    expect((await verifyReceipt(tampered, gw.address)).ok).toBe(false);
    expect((await verifyReceipt(r1, "0x0000000000000000000000000000000000000001")).ok).toBe(false);
    const broken = await verifyChain([r0, { ...r1, prev: null }], gw.address);
    expect(broken.ok).toBe(false);
    expect(broken.problems.some((p) => p.includes("prev link"))).toBe(true);
  });
});
