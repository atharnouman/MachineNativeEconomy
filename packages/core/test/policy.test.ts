import { describe, it, expect } from "vitest";
import { parsePolicyYaml, evaluate, issueRoot, attenuate, credentialId, type PaymentIntent, type SpendLedgerView } from "../src/index.js";

const yaml = `
version: 1
principalId: org-acme
currency: { asset: USDC, decimals: 6 }
budgets:
  org:      { cap: "5.00" }
  research: { cap: "2.00", parent: org }
agents:
  treasury: { budget: org }
  research-agent: { budget: research }
rules:
  - id: deny-blocked
    effect: deny
    match: { payees: [evil.example] }
  - id: escalate-big
    effect: escalate
    match: { amount_gt: "0.50" }
  - id: allow-data
    effect: allow
    match: { purposes: [research], rails: [x402, mpp] }
`;

const policy = parsePolicyYaml(yaml);
const ROOT_KEY = "k";
const rootCred = issueRoot({
  rootKey: ROOT_KEY,
  rootId: "cred_r",
  principalId: "org-acme",
  agentId: "research-agent",
  nonce: "0",
  caveats: [
    { type: "spend_cap", value: "1000000" },
    { type: "per_tx_max", value: "300000" },
    { type: "allowed_payees", value: ["data.example"] },
  ],
});
const subCred = attenuate(rootCred, [{ type: "per_tx_max", value: "20000" }, { type: "spend_cap", value: "100000" }], { agentId: "fetcher", nonce: "1" });

function intent(over: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    v: 1,
    id: "int_1",
    principalId: "org-acme",
    agentId: "fetcher",
    credentialId: credentialId(subCred),
    payee: { url: "http://data.example/v1/quote", host: "data.example" },
    resource: "/v1/quote",
    maxAmount: { asset: "USDC", chain: "eip155:31337", token: "0x0000000000000000000000000000000000000001", value: "10000", decimals: 6 },
    purpose: "research",
    rail: "x402",
    createdAt: new Date().toISOString(),
    ...over,
  };
}

const zeroLedger: SpendLedgerView = { spentByCredential: () => 0n, spentByBudget: () => 0n };

describe("policy evaluation", () => {
  it("allows a conforming payment", () => {
    const d = evaluate({ policy, intent: intent(), credential: subCred, amountBase: 10_000n, rail: "x402", ledger: zeroLedger });
    expect(d.effect).toBe("allow");
    expect(d.matchedRules).toEqual(["allow-data"]);
    expect(d.budgetPath).toEqual(["research", "org"]);
  });

  it("denies when the sub-agent caveat is exceeded even though the parent would allow", () => {
    const d = evaluate({ policy, intent: intent(), credential: subCred, amountBase: 40_000n, rail: "x402", ledger: zeroLedger });
    expect(d.effect).toBe("deny");
    expect(d.reasons).toContain("CAVEAT:per_tx_max");
    const parentDecision = evaluate({ policy, intent: intent({ agentId: "research-agent" }), credential: rootCred, amountBase: 40_000n, rail: "x402", ledger: zeroLedger });
    expect(parentDecision.effect).toBe("allow");
  });

  it("denies on payee not in caveat allowlist and on deny rule", () => {
    const d1 = evaluate({ policy, intent: intent({ payee: { url: "http://other.example/x", host: "other.example" } }), credential: subCred, amountBase: 1n, rail: "x402", ledger: zeroLedger });
    expect(d1.reasons).toContain("CAVEAT:allowed_payees");
    const d2 = evaluate({ policy, intent: intent({ payee: { url: "http://evil.example/x", host: "evil.example" } }), credential: subCred, amountBase: 1n, rail: "x402", ledger: zeroLedger });
    expect(d2.reasons).toContain("RULE_DENY:deny-blocked");
  });

  it("charges lineage caps: the parent's cap bounds the child's spend", () => {
    const ledger: SpendLedgerView = {
      spentByCredential: (id) => (id === credentialId(rootCred) ? 995_000n : 0n),
      spentByBudget: () => 0n,
    };
    const d = evaluate({ policy, intent: intent(), credential: subCred, amountBase: 10_000n, rail: "x402", ledger });
    expect(d.effect).toBe("deny");
    expect(d.reasons[0]).toMatch(/^LINEAGE_CAP:cred_r/);
  });

  it("denies when a budget ancestor is exhausted", () => {
    const ledger: SpendLedgerView = { spentByCredential: () => 0n, spentByBudget: (b) => (b === "org" ? 4_995_000n : 0n) };
    const d = evaluate({ policy, intent: intent(), credential: subCred, amountBase: 10_000n, rail: "x402", ledger });
    expect(d.reasons).toContain("BUDGET:org");
  });

  it("escalates large amounts and honours the kill switch", () => {
    const d = evaluate({ policy, intent: intent({ agentId: "research-agent" }), credential: rootCred, amountBase: 600_000n, rail: "x402", ledger: zeroLedger });
    expect(d.effect).toBe("deny"); // per_tx_max 300000 beats escalate
    const bigCred = issueRoot({ rootKey: ROOT_KEY, rootId: "cred_b", principalId: "org-acme", agentId: "research-agent", nonce: "0" });
    const e = evaluate({ policy, intent: intent({ agentId: "research-agent" }), credential: bigCred, amountBase: 600_000n, rail: "x402", ledger: zeroLedger });
    expect(e.effect).toBe("escalate");
    const k = evaluate({ policy, intent: intent(), credential: subCred, amountBase: 1n, rail: "x402", ledger: zeroLedger, killSwitch: true });
    expect(k.effect).toBe("deny");
    expect(k.reasons).toEqual(["KILL_SWITCH"]);
  });

  it("default-denies when no allow rule matches", () => {
    const d = evaluate({ policy, intent: intent({ purpose: "research" }), credential: subCred, amountBase: 1n, rail: "x402", ledger: zeroLedger, now: new Date() });
    expect(d.effect).toBe("allow");
    const noPurposePolicy = { ...policy, rules: policy.rules.filter((r) => r.id !== "allow-data") };
    const e = evaluate({ policy: noPurposePolicy, intent: intent(), credential: subCred, amountBase: 1n, rail: "x402", ledger: zeroLedger });
    expect(e.reasons).toEqual(["DEFAULT_DENY"]);
  });
});
