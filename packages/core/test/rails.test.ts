import { describe, it, expect } from "vitest";
import {
  encodeMppChallengeHeader,
  decodeMppChallengeHeader,
  encodeMppCredentialHeader,
  decodeMppCredentialHeader,
  encodeX402,
  decodeX402,
  X402RequiredSchema,
  type MppChallenge,
} from "../src/index.js";

describe("rail wire formats", () => {
  it("round-trips an MPP challenge and credential", () => {
    const c: MppChallenge = {
      id: "ch_1",
      realm: "data.example",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      methods: [{ method: "evm-agent-account", chain: "eip155:31337", token: "0x01", amount: "10000", payTo: "0x02" }],
    };
    const h = encodeMppChallengeHeader(c);
    expect(h.startsWith('Payment realm="data.example", challenge="')).toBe(true);
    expect(decodeMppChallengeHeader(h)).toEqual(c);
    expect(decodeMppChallengeHeader('Bearer realm="x"')).toBeNull();
    const cred = {
      challengeId: "ch_1",
      method: "evm-agent-account" as const,
      payload: {
        kind: "agent-account" as const,
        account: "0x0000000000000000000000000000000000000001",
        authorization: { token: "0x01", to: "0x02", amount: "10000", intentHash: "0x" + "ab".repeat(32), validAfter: "0", validBefore: "1", nonce: "0x" + "cd".repeat(32) },
        signature: "0xdeadbeef",
      },
    };
    expect(decodeMppCredentialHeader(encodeMppCredentialHeader(cred))).toEqual(cred);
  });

  it("round-trips an x402 PAYMENT-REQUIRED header", () => {
    const req = {
      x402Version: 2 as const,
      accepts: [{ scheme: "exact" as const, network: "eip155:31337", amount: "10000", asset: "0x01", payTo: "0x02", maxTimeoutSeconds: 60, resource: { url: "http://x/y" } }],
    };
    expect(decodeX402(X402RequiredSchema, encodeX402(req))).toEqual(req);
    expect(decodeX402(X402RequiredSchema, "garbage")).toBeNull();
  });
});
