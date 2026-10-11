import { describe, it, expect } from "vitest";
import {
  parsePolicyYaml,
  evaluate,
  diffPolicies,
  issueRoot,
  attenuate,
  credentialId,
  type PaymentIntent,
  type SpendLedgerView,
} from "../src/index.js";

const yaml = `
version: 1
principalId: org-acme
currency: { asset: USDC, decimals: 6 }
budgets:
  org:      { cap: "5.00" }
  research: { cap: "2.00", parent: org }
  daily:    { cap: "0.05", parent: research, period: daily }
agents:
  treasury: { budget: org }
  research-agent: { budget: research }
  daily-agent: { budget: daily }
velocity:
  - id: agent-burst
    scope: agent
    window: 10m
    max_count: 3
    agents: [research-agent]
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
const subCred = attenuate(
  rootCred,
  [
    { type: "per_tx_max", value: "20000" },
    { type: "spend_cap", value: "100000" },
    { type: "rate_limit", window: "10m", max_count: 2 },
  ],
  { agentId: "fetcher", nonce: "1" },
);

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

const zeroLedger: SpendLedgerView = { spentByCredential: () => 0n, spentByBudget: () => 0n, activity: () => ({ count: 0, amount: 0n }) };
const ledgerWith = (over: Partial<SpendLedgerView>): SpendLedgerView => ({ ...zeroLedger, ...over });

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
    const ledger = ledgerWith({ spentByCredential: (id) => (id === credentialId(rootCred) ? 995_000n : 0n) });
    const d = evaluate({ policy, intent: intent(), credential: subCred, amountBase: 10_000n, rail: "x402", ledger });
    expect(d.effect).toBe("deny");
    expect(d.reasons[0]).toMatch(/^LINEAGE_CAP:cred_r/);
  });

  it("denies when a budget ancestor is exhausted", () => {
    const ledger = ledgerWith({ spentByBudget: (b) => (b === "org" ? 4_995_000n : 0n) });
    const d = evaluate({ policy, intent: intent(), credential: subCred, amountBase: 10_000n, rail: "x402", ledger });
    expect(d.reasons).toContain("BUDGET:org");
  });

  it("applies budget periods: a daily cap resets at UTC midnight", () => {
    const dailyCred = issueRoot({ rootKey: ROOT_KEY, rootId: "cred_d", principalId: "org-acme", agentId: "daily-agent", nonce: "0" });
    const spentToday = new Map<string, bigint>();
    // 0.05 already spent since 2026-10-08T00:00Z; nothing earlier in the period
    const ledger = ledgerWith({
      spentByBudget: (b, since) => {
        if (b !== "daily") return 0n;
        return since && since.getTime() <= Date.UTC(2026, 9, 8, 0, 0, 0) ? 50_000n : (spentToday.get(b) ?? 0n);
      },
    });
    const late = evaluate({ policy, intent: intent({ agentId: "daily-agent", credentialId: credentialId(dailyCred) }), credential: dailyCred, amountBase: 10_000n, rail: "x402", ledger, now: new Date("2026-10-08T23:59:00Z") });
    expect(late.reasons).toContain("BUDGET:daily");
    expect(late.checks.find((c) => c.check === "budget:daily")?.detail).toContain("daily from 2026-10-08T00:00:00.000Z");
    // the next UTC day the window starts fresh (our fake ledger reports 0 for a window starting after midnight)
    const ledgerNextDay = ledgerWith({ spentByBudget: (b, since) => (b === "daily" && since && since.getTime() === Date.UTC(2026, 9, 9) ? 0n : 50_000n) });
    const next = evaluate({ policy, intent: intent({ agentId: "daily-agent", credentialId: credentialId(dailyCred) }), credential: dailyCred, amountBase: 10_000n, rail: "x402", ledger: ledgerNextDay, now: new Date("2026-10-09T00:00:30Z") });
    expect(next.effect).toBe("allow");
  });

  it("enforces a rate_limit caveat against the lineage node that set it", () => {
    const subId = credentialId(subCred);
    const ledger = ledgerWith({ activity: (scope, id) => (scope === "credential" && id === subId ? { count: 2, amount: 20_000n } : { count: 0, amount: 0n }) });
    const d = evaluate({ policy, intent: intent(), credential: subCred, amountBase: 10_000n, rail: "x402", ledger });
    expect(d.effect).toBe("deny");
    expect(d.reasons).toEqual([`CAVEAT:rate_limit:${subId}`]);
    // the parent credential has no rate limit, so the same activity does not affect it
    const p = evaluate({ policy, intent: intent({ agentId: "research-agent", credentialId: credentialId(rootCred) }), credential: rootCred, amountBase: 10_000n, rail: "x402", ledger });
    expect(p.effect).toBe("allow");
  });

  it("enforces policy velocity rules by scope and agent filter", () => {
    const ledger = ledgerWith({ activity: (scope, id) => (scope === "agent" && id === "research-agent" ? { count: 3, amount: 30_000n } : { count: 0, amount: 0n }) });
    const d = evaluate({ policy, intent: intent(), credential: subCred, amountBase: 10_000n, rail: "x402", ledger });
    expect(d.reasons).toEqual(["VELOCITY:agent-burst"]);
    const other = issueRoot({ rootKey: ROOT_KEY, rootId: "cred_t", principalId: "org-acme", agentId: "treasury", nonce: "0" });
    const t = evaluate({ policy, intent: intent({ agentId: "treasury", credentialId: credentialId(other) }), credential: other, amountBase: 10_000n, rail: "x402", ledger });
    expect(t.effect).toBe("allow"); // rule is filtered to research-agent
  });

  it("escalates large amounts, and an approval satisfies the escalation without skipping other checks", () => {
    const bigCred = issueRoot({ rootKey: ROOT_KEY, rootId: "cred_b", principalId: "org-acme", agentId: "research-agent", nonce: "0" });
    const big = intent({ agentId: "research-agent", credentialId: credentialId(bigCred) });
    const e = evaluate({ policy, intent: big, credential: bigCred, amountBase: 600_000n, rail: "x402", ledger: zeroLedger });
    expect(e.effect).toBe("escalate");
    expect(e.reasons).toEqual(["RULE_ESCALATE:escalate-big"]);
    const a = evaluate({ policy, intent: big, credential: bigCred, amountBase: 600_000n, rail: "x402", ledger: zeroLedger, approval: { id: "apr_1" } });
    expect(a.effect).toBe("allow");
    expect(a.approvalId).toBe("apr_1");
    expect(a.checks.find((c) => c.check === "rule:escalate-big")?.detail).toContain("apr_1");
    // an approval does not bypass budgets
    const exhausted = ledgerWith({ spentByBudget: (b) => (b === "research" ? 1_500_000n : 0n) });
    const still = evaluate({ policy, intent: big, credential: bigCred, amountBase: 600_000n, rail: "x402", ledger: exhausted, approval: { id: "apr_1" } });
    expect(still.effect).toBe("deny");
    expect(still.reasons).toContain("BUDGET:research");
  });

  it("honours the kill switch and default-denies when no allow rule matches", () => {
    const k = evaluate({ policy, intent: intent(), credential: subCred, amountBase: 1n, rail: "x402", ledger: zeroLedger, killSwitch: true });
    expect(k.reasons).toEqual(["KILL_SWITCH"]);
    const noAllow = { ...policy, rules: policy.rules.filter((r) => r.id !== "allow-data") };
    const e = evaluate({ policy: noAllow, intent: intent(), credential: subCred, amountBase: 1n, rail: "x402", ledger: zeroLedger });
    expect(e.reasons).toEqual(["DEFAULT_DENY"]);
  });

  it("diffs policy versions structurally", () => {
    const v2 = parsePolicyYaml(yaml.replace('cap: "2.00"', 'cap: "1.00"').replace("- id: deny-blocked", "- id: deny-blocked-v2"));
    const d = diffPolicies(policy, v2);
    expect(d.budgets).toEqual(["~research"]);
    expect(d.rules.sort()).toEqual(["+deny-blocked-v2", "-deny-blocked"]);
    expect(d.agents).toEqual([]);
  });
});
