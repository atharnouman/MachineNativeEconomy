import { describe, it, expect } from "vitest";
import type { PublicClient } from "viem";
import { waitForInclusion } from "../src/index.js";

/** A client whose receipt can arrive while the chain's latest block is still behind it (a preconfirmation). */
function fakeClient(receiptBlock: bigint, heads: bigint[]) {
  let calls = 0;
  const client = {
    waitForTransactionReceipt: async () => ({ status: "success", blockNumber: receiptBlock, logs: [] }),
    getBlockNumber: async () => heads[Math.min(calls++, heads.length - 1)]!,
  } as unknown as PublicClient;
  return { client, calls: () => calls };
}

describe("waitForInclusion", () => {
  it("returns at once when the receipt's block is already the latest, as on a local chain", async () => {
    const f = fakeClient(10n, [10n]);
    expect((await waitForInclusion(f.client, "0x01")).blockNumber).toBe(10n);
    expect(f.calls()).toBe(1);
  });

  it("waits until the latest block reaches a preconfirmed receipt's block", async () => {
    const f = fakeClient(10n, [9n, 9n, 10n]);
    await waitForInclusion(f.client, "0x01");
    expect(f.calls()).toBe(3);
  });

  it("returns the receipt after the timeout when the chain never catches up", async () => {
    const f = fakeClient(10n, [9n]);
    const t0 = Date.now();
    expect((await waitForInclusion(f.client, "0x01", 300)).blockNumber).toBe(10n);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});
