import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  issueRoot,
  attenuate,
  verifyCredential,
  effectiveLimits,
  isSubsetOf,
  credentialId,
  agentIdOf,
  lineage,
  parentOf,
  toPublic,
  encodeCredential,
  decodeCredential,
  type Caveat,
} from "../src/index.js";

const ROOT_KEY = "test-root-key";

function root(caveats: Exclude<Caveat, { type: "delegate" }>[] = []) {
  return issueRoot({ rootKey: ROOT_KEY, rootId: "cred_root", principalId: "org", agentId: "treasury", nonce: "n0", caveats });
}

// Arbitrary non-delegate caveats
const bigStr = fc.bigUintN(40).map((b) => b.toString());
const isoDate = fc.integer({ min: 1_600_000_000_000, max: 1_900_000_000_000 }).map((ms) => new Date(ms).toISOString());
const list = (items: string[]) => fc.subarray(items, { minLength: 1 });
const caveatArb: fc.Arbitrary<Exclude<Caveat, { type: "delegate" }>> = fc.oneof(
  bigStr.map((value) => ({ type: "spend_cap" as const, value })),
  bigStr.map((value) => ({ type: "per_tx_max" as const, value })),
  isoDate.map((value) => ({ type: "expires_at" as const, value })),
  isoDate.map((value) => ({ type: "not_before" as const, value })),
  list(["a.example", "b.example", "c.example", "0xabc"]).map((value) => ({ type: "allowed_payees" as const, value })),
  list(["x402", "mpp"] as const).map((value) => ({ type: "allowed_rails" as const, value: [...value] })),
  list(["research", "ops", "infra"]).map((value) => ({ type: "purposes" as const, value })),
  list(["eip155:1", "eip155:8453", "eip155:31337"]).map((value) => ({ type: "chains" as const, value })),
);

describe("credential chain", () => {
  it("verifies a root credential and rejects tampering", () => {
    const c = root([{ type: "spend_cap", value: "1000000" }]);
    expect(verifyCredential(ROOT_KEY, c)).toEqual({ ok: true });
    const tampered = { ...c, caveats: [...c.caveats, { type: "spend_cap", value: "999999999" } as Caveat] };
    expect(verifyCredential(ROOT_KEY, tampered).ok).toBe(false);
    const widened = { ...c, caveats: [c.caveats[0]!] }; // removing a caveat
    expect(verifyCredential(ROOT_KEY, widened).ok).toBe(false);
    expect(verifyCredential("wrong-key", c).ok).toBe(false);
  });

  it("attenuates offline and still verifies", () => {
    const c = root([{ type: "spend_cap", value: "1000000" }, { type: "per_tx_max", value: "300000" }]);
    const child = attenuate(c, [{ type: "per_tx_max", value: "50000" }], { agentId: "research", nonce: "n1" });
    expect(verifyCredential(ROOT_KEY, child)).toEqual({ ok: true });
    expect(agentIdOf(child)).toBe("research");
    expect(parentOf(child)).not.toBeNull();
    expect(credentialId(parentOf(child)!)).toBe(credentialId(c));
    expect(lineage(child).length).toBe(2);
    const pub = toPublic(child);
    expect(pub.parentId).toBe(credentialId(c));
    expect((pub as Record<string, unknown>).sig).toBeUndefined();
    expect(decodeCredential(encodeCredential(child))).toEqual(child);
  });

  it("PROPERTY: attenuation is monotonic — a child's effective limits are always a subset of its parent's", () => {
    fc.assert(
      fc.property(fc.array(caveatArb, { maxLength: 6 }), fc.array(caveatArb, { maxLength: 6 }), (parentCaveats, added) => {
        const parent = root(parentCaveats);
        const child = attenuate(parent, added, { agentId: "sub", nonce: "n" });
        const r = isSubsetOf(effectiveLimits(child.caveats), effectiveLimits(parent.caveats));
        expect(r.ok, r.violations.join(",")).toBe(true);
        expect(verifyCredential(ROOT_KEY, child).ok).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("PROPERTY: effective limits are order-insensitive and idempotent under repetition", () => {
    fc.assert(
      fc.property(fc.array(caveatArb, { maxLength: 6 }), (cs) => {
        const a = effectiveLimits(cs);
        const b = effectiveLimits([...cs].reverse());
        const c = effectiveLimits([...cs, ...cs]);
        const norm = (e: ReturnType<typeof effectiveLimits>) => JSON.stringify(e, (_k, v) => (v instanceof Set ? [...v].sort() : typeof v === "bigint" ? v.toString() : v));
        expect(norm(a)).toBe(norm(b));
        expect(norm(a)).toBe(norm(c));
      }),
    );
  });

  it("isSubsetOf detects a wider child (sanity for the verifier)", () => {
    const parent = effectiveLimits([{ type: "spend_cap", value: "100" }, { type: "allowed_payees", value: ["a"] }]);
    const wider = effectiveLimits([{ type: "spend_cap", value: "200" }]);
    const r = isSubsetOf(wider, parent);
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual(["spendCap", "allowedPayees"]);
  });
});
