import { describe, it, expect } from "vitest";
import {
  encodeL402ChallengeHeader,
  decodeL402ChallengeHeader,
  encodeL402AuthorizationHeader,
  decodeL402AuthorizationHeader,
  encodeMppChallengeHeader,
  decodeMppChallengeHeader,
  mintL402Macaroon,
  verifyL402Macaroon,
  randomPreimage,
  preimageMatches,
  SubscriptionTermsSchema,
  MppCredentialSchema,
  type MppChallenge,
} from "../src/index.js";

describe("L402 wire format and macaroons", () => {
  it("parses an L402 challenge even when joined with an MPP challenge in one WWW-Authenticate value", () => {
    const mpp: MppChallenge = { id: "ch_1", realm: "p", expiresAt: new Date(Date.now() + 60_000).toISOString(), methods: [{ method: "evm-agent-account", chain: "eip155:31337", token: "0x01", amount: "1", payTo: "0x02" }] };
    const joined = `${encodeMppChallengeHeader(mpp)}, ${encodeL402ChallengeHeader("mac", "lnbc1")}`;
    expect(decodeMppChallengeHeader(joined)?.id).toBe("ch_1");
    expect(decodeL402ChallengeHeader(joined)).toEqual({ macaroon: "mac", invoice: "lnbc1" });
    expect(decodeL402ChallengeHeader("Bearer x")).toBeNull();
  });

  it("round-trips the authorization header and validates preimages", () => {
    const { preimage, paymentHash } = randomPreimage();
    const h = encodeL402AuthorizationHeader("mac-token", preimage);
    expect(decodeL402AuthorizationHeader(h)).toEqual({ macaroon: "mac-token", preimage });
    expect(preimageMatches(preimage, paymentHash)).toBe(true);
    expect(preimageMatches(preimage.replace(/.$/, "0"), paymentHash)).toBe(false);
    expect(decodeL402AuthorizationHeader("L402 mac:short")).toBeNull();
  });

  it("mints and verifies payment-bound macaroons", () => {
    const { paymentHash } = randomPreimage();
    const mac = mintL402Macaroon("payee-secret", paymentHash, 60);
    expect(verifyL402Macaroon("payee-secret", mac)).toEqual({ ok: true, paymentHash });
    expect(verifyL402Macaroon("other-secret", mac)).toMatchObject({ ok: false, reason: "macaroon signature invalid" });
    const expired = mintL402Macaroon("payee-secret", paymentHash, -1);
    expect(verifyL402Macaroon("payee-secret", expired)).toMatchObject({ ok: false, reason: "macaroon expired" });
  });
});

describe("subscription schemas", () => {
  it("validates terms and the MPP credential subscription block", () => {
    const terms = SubscriptionTermsSchema.parse({ kind: "metered", amountPerCharge: "5000", interval: "1s", unit: "token", unitPrice: "100", expiresAt: new Date().toISOString() });
    expect(terms.kind).toBe("metered");
    expect(() => SubscriptionTermsSchema.parse({ ...terms, interval: "soon" })).toThrow();
    const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
    const cred = MppCredentialSchema.parse({
      challengeId: "ch",
      method: "evm-agent-account",
      payload: { kind: "agent-account", account: addr(1), authorization: { token: addr(2), to: addr(3), amount: "1", intentHash: `0x${"ab".repeat(32)}`, validAfter: "0", validBefore: "1", nonce: `0x${"cd".repeat(32)}` }, signature: "0x00" },
      subscription: { id: "sub_1", chargeUrl: "http://gw/v1/subscriptions/sub_1/charges", token: "t", terms },
    });
    expect(cred.subscription?.terms.unit).toBe("token");
  });
});
