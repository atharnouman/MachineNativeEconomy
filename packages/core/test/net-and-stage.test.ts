import { describe, it, expect } from "vitest";
import { isPrivateHost, classifyHost, checkOutboundUrl, parsePolicyYaml, evaluate, issueRoot, credentialId, NonceWindow, type PaymentIntent, type SpendLedgerView } from "../src/index.js";

describe("outbound URL hygiene", () => {
  it("classifies private and loopback hosts", () => {
    for (const h of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "localhost", "api.internal", "::1", "fd00::1", "100.64.0.1"]) expect(isPrivateHost(h), h).toBe(true);
    for (const h of ["8.8.8.8", "data.example", "172.32.0.1", "2001:db8::1"]) expect(isPrivateHost(h), h).toBe(false);
    expect(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"].map(classifyHost)).toEqual(["loopback", "loopback", "loopback", "loopback"]);
    expect(["169.254.169.254", "10.0.0.1", "fd00::1", "api.internal"].map(classifyHost)).toEqual(["private", "private", "private", "private"]);
  });

  it("loopback can be allowed without opening private and link-local ranges", () => {
    expect(checkOutboundUrl("http://127.0.0.1:4403/v1/quote", { allowLoopback: true }).ok).toBe(true);
    expect(checkOutboundUrl("http://169.254.169.254/latest/meta-data/", { allowLoopback: true })).toMatchObject({ ok: false, reason: expect.stringContaining("private") });
    expect(checkOutboundUrl("http://10.0.0.5/", { allowLoopback: true }).ok).toBe(false);
    expect(checkOutboundUrl("http://10.0.0.5/", { allowPrivate: true }).ok).toBe(true);
  });

  it("blocks private destinations unless allowed, and enforces an allowlist", () => {
    expect(checkOutboundUrl("http://169.254.169.254/latest/meta-data").ok).toBe(false);
    expect(checkOutboundUrl("http://127.0.0.1:4403/v1/quote", { allowPrivate: true }).ok).toBe(true);
    expect(checkOutboundUrl("ftp://data.example/x").ok).toBe(false);
    expect(checkOutboundUrl("https://user:pw@data.example/x").ok).toBe(false);
    expect(checkOutboundUrl("https://api.data.example/x", { allowedHosts: ["*.data.example"] }).ok).toBe(true);
    expect(checkOutboundUrl("https://evil.example/x", { allowedHosts: ["*.data.example"] })).toMatchObject({ ok: false, reason: expect.stringContaining("allowlist") });
  });

  it("nonce window remembers and evicts", () => {
    const w = new NonceWindow(2);
    expect(w.seenBefore("a", "k")).toBe(false);
    expect(w.seenBefore("a", "k")).toBe(true);
    w.seenBefore("b", "k");
    w.seenBefore("c", "k"); // evicts a
    expect(w.seenBefore("a", "k")).toBe(false);
  });
});

describe("structural policy stage", () => {
  const policy = parsePolicyYaml(`
version: 1
principalId: org
budgets: { org: { cap: "5.00" } }
agents: { a: { budget: org } }
rules:
  - { id: deny-dust, effect: deny, match: { amount_lte: "0.001" } }
  - { id: deny-evil, effect: deny, match: { payees: [evil.example] } }
  - { id: escalate-big, effect: escalate, match: { amount_gt: "1.00" } }
  - { id: allow-small-research, effect: allow, match: { purposes: [research], amount_lte: "0.50" } }
`);
  const cred = issueRoot({ rootKey: "k", rootId: "cred_a", principalId: "org", agentId: "a", nonce: "0" });
  const ledger: SpendLedgerView = { spentByCredential: () => 0n, spentByBudget: () => 0n, activity: () => ({ count: 0, amount: 0n }) };
  const intent = (host = "data.example"): PaymentIntent => ({ v: 1, id: "i", principalId: "org", agentId: "a", credentialId: credentialId(cred), payee: { url: `http://${host}/x`, host }, resource: "/x", maxAmount: { asset: "USDC", chain: "eip155:1", token: "0x0000000000000000000000000000000000000001", value: "0", decimals: 6 }, purpose: "research", rail: "auto", createdAt: new Date().toISOString() });

  it("does not trip amount-conditioned deny rules, still applies structural ones, and lets amount-conditioned allow rules count", () => {
    const s = evaluate({ policy, intent: intent(), credential: cred, amountBase: 0n, rail: "auto", ledger, stage: "structural" });
    expect(s.effect).toBe("allow");
    expect(s.matchedRules).toEqual(["allow-small-research"]);
    const evil = evaluate({ policy, intent: intent("evil.example"), credential: cred, amountBase: 0n, rail: "auto", ledger, stage: "structural" });
    expect(evil.reasons).toEqual(["RULE_DENY:deny-evil"]);
  });

  it("binding stage applies the amount predicates", () => {
    expect(evaluate({ policy, intent: intent(), credential: cred, amountBase: 500n, rail: "x402", ledger }).reasons).toEqual(["RULE_DENY:deny-dust"]);
    expect(evaluate({ policy, intent: intent(), credential: cred, amountBase: 2_000_000n, rail: "x402", ledger }).effect).toBe("escalate");
    expect(evaluate({ policy, intent: intent(), credential: cred, amountBase: 100_000n, rail: "x402", ledger }).effect).toBe("allow");
    expect(evaluate({ policy, intent: intent(), credential: cred, amountBase: 600_000n, rail: "x402", ledger }).reasons).toEqual(["DEFAULT_DENY"]);
  });
});
