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
  lineageSegments,
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
  fc
    .record({ window: fc.constantFrom("30s", "10m", "1h", "1d"), max_count: fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }), max_amount: fc.option(bigStr, { nil: undefined }) })
    .map((r) => ({ type: "rate_limit" as const, ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) }) as Extract<Caveat, { type: "rate_limit" }>),
  fc.constantFrom("A", "B", "C").map((x) => ({ type: "holder_key" as const, jwk: { kty: "OKP" as const, crv: "Ed25519" as const, x: `key-${x}` } })),
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

  it("splits the chain into per-node segments", () => {
    const c = root([{ type: "rate_limit", window: "1h", max_count: 5 }]);
    const child = attenuate(c, [{ type: "per_tx_max", value: "1" }, { type: "rate_limit", window: "10m", max_count: 2 }], { agentId: "sub", nonce: "n1" });
    const segs = lineageSegments(child);
    expect(segs.map((s) => s.agentId)).toEqual(["treasury", "sub"]);
    expect(segs[0]!.segment.map((x) => x.type)).toEqual(["delegate", "rate_limit"]);
    expect(segs[1]!.segment.map((x) => x.type)).toEqual(["delegate", "per_tx_max", "rate_limit"]);
    expect(effectiveLimits(child.caveats).rateLimits).toHaveLength(2);
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

  it("PROPERTY: effective limits are order-insensitive (except the positional holder binding) and idempotent under repetition", () => {
    fc.assert(
      fc.property(fc.array(caveatArb, { maxLength: 6 }), (cs) => {
        const a = effectiveLimits(cs);
        const b = effectiveLimits([...cs].reverse());
        const c = effectiveLimits([...cs, ...cs]);
        const norm = (e: ReturnType<typeof effectiveLimits>) => JSON.stringify({ ...e, holderKey: undefined }, (_k, v) => (v instanceof Set ? [...v].sort() : typeof v === "bigint" ? v.toString() : v));
        expect(norm(a)).toBe(norm(b));
        expect(norm(a)).toBe(norm(c));
        expect(c.holderKey).toEqual(a.holderKey); // repetition keeps the last binding
      }),
    );
  });

  it("holder binding can be replaced by delegation but never removed", () => {
    const bound = root([{ type: "holder_key", jwk: { kty: "OKP", crv: "Ed25519", x: "parent-key" } }]);
    const rebound = attenuate(bound, [{ type: "holder_key", jwk: { kty: "OKP", crv: "Ed25519", x: "child-key" } }], { agentId: "sub", nonce: "n" });
    expect(effectiveLimits(rebound.caveats).holderKey?.x).toBe("child-key");
    expect(isSubsetOf(effectiveLimits(rebound.caveats), effectiveLimits(bound.caveats)).ok).toBe(true);
    const unbound = effectiveLimits([{ type: "spend_cap", value: "1" }]);
    expect(isSubsetOf(unbound, effectiveLimits(bound.caveats)).violations).toContain("holderKey");
  });

  it("isSubsetOf detects a wider child (sanity for the verifier)", () => {
    const parent = effectiveLimits([{ type: "spend_cap", value: "100" }, { type: "allowed_payees", value: ["a"] }, { type: "rate_limit", window: "1h", max_count: 1 }]);
    const wider = effectiveLimits([{ type: "spend_cap", value: "200" }]);
    const r = isSubsetOf(wider, parent);
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual(["spendCap", "allowedPayees", "rateLimits"]);
  });
});
