import { describe, it, expect } from "vitest";
import { parseSignature, size } from "viem";
import { PREAPPROVED_SIGNATURE } from "../src/index.js";

describe("PREAPPROVED_SIGNATURE", () => {
  it("is 65 bytes a secp256k1 parser accepts, so a facilitator can split it into v, r, s", () => {
    expect(size(PREAPPROVED_SIGNATURE)).toBe(65);
    const sig = parseSignature(PREAPPROVED_SIGNATURE);
    expect(BigInt(sig.r)).toBeGreaterThan(0n);
    expect(BigInt(sig.s)).toBe(1n);
    expect(sig.v).toBe(27n);
  });

  it("is needed: the same parser refuses an all-zero placeholder", () => {
    expect(() => parseSignature(`0x${"00".repeat(65)}`)).toThrow();
  });
});
