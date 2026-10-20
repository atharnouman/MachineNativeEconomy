import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidenceBundle } from "@spendmarshal/core";
import { buildStatement, formatStatementHtml, formatStatementText, human, parseAmount, parsePeriod, type Statement } from "../src/statement.js";
import { main } from "../src/index.js";

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const VECTOR_NAMES = ["01-basic.json", "11-policy-versions.json", "15-approval-signed.json", "19-approver-key-rotated.json", "20-approval-legacy-map.json", "21-credentials-delegated.json", "24-gateway-key-handover.json", "32-anchors-evidence-key.json"];
const vector = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as { bundle: EvidenceBundle; expected: { ok: boolean } };

type Row = Record<string, unknown>;
let seq = 0;
/** a receipt of the synthetic chain; hashes and signatures are placeholders, since the builder never checks them (the CLI verifies first) */
function receipt(kind: string, ts: string, data: Row = {}, top: Row = {}): Row {
  const n = seq++;
  return { v: 1, id: `rcpt_${String(n).padStart(4, "0")}`, principalId: "client-a", seq: n, prev: n ? `0x${"a".repeat(64)}` : null, ts, kind, data, hash: `0x${"b".repeat(64)}`, sig: `0x${"c".repeat(130)}`, ...top };
}
const settled = (ts: string, amount: string, over: Row = {}, top: Row = {}) =>
  receipt("payment.settled", ts, { txHash: `0x${"d".repeat(64)}`, blockNumber: "1", amount, payee: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", resource: "/v1/quote?symbol=ETH", subscriptionId: null, approvalId: null, ...over }, { agentId: "research-agent", rail: "x402", intentId: `int_${seq}`, ...top });
const denied = (ts: string, data: Row, top: Row = {}) => receipt("payment.denied", ts, data, { agentId: "research-agent", ...top });
const allowQuote = (ts: string, intentId: string, amount: string, payTo = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC") => receipt("decision", ts, { stage: "quote", effect: "allow", amount, quote: { payTo } }, { agentId: "research-agent", intentId });

function bundle(receipts: Row[], extra: Row = {}): EvidenceBundle {
  seq = 0;
  return {
    v: 1,
    principalId: "client-a",
    exportedAt: "2026-11-01T00:00:00.000Z",
    gateway: { address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", chain: "eip155:31337" },
    gatewayKeyHistory: [],
    contracts: {},
    policy: { hash: `0x${"e".repeat(64)}`, document: { version: 1, principalId: "client-a", currency: { asset: "USDC", decimals: 6 }, budgets: {}, agents: {}, rules: [] } },
    policyVersions: [],
    approvers: {},
    approverHistory: {},
    credentials: [],
    receipts: receipts.map((r, i) => ({ ...r, seq: i, prev: i ? `0x${"a".repeat(64)}` : null })),
    anchors: [],
    ...extra,
  } as unknown as EvidenceBundle;
}
const OCT = parsePeriod("2026-10");
const build = (b: EvidenceBundle, opts: Parameters<typeof buildStatement>[1] = {}) => buildStatement(b, { period: OCT, generatedAt: "2026-11-01T00:00:00.000Z", ...opts });

describe("periods and amounts", () => {
  it("parses a month and a date range in UTC, and rejects anything else", () => {
    expect(OCT).toEqual({ from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z", label: "October 2026" });
    expect(parsePeriod("2026-09-15/2026-10-14")).toEqual({ from: "2026-09-15T00:00:00.000Z", to: "2026-10-15T00:00:00.000Z", label: "2026-09-15 to 2026-10-14" });
    expect(() => parsePeriod("2026-13")).toThrow(/month/);
    expect(() => parsePeriod("2026-10-20/2026-10-10")).toThrow(/range/);
    expect(() => parsePeriod("October")).toThrow(/YYYY-MM/);
  });

  it("renders base units exactly, with every decimal place", () => {
    expect(human(0n, 6)).toBe("0.000000");
    expect(human(10000n, 6)).toBe("0.010000");
    expect(human(1234567n, 6)).toBe("1.234567");
    expect(human(-13000n, 6)).toBe("-0.013000");
    expect(human(5n, 0)).toBe("5");
  });

  it("reads a human amount exactly and refuses more decimals than the currency has", () => {
    expect(parseAmount("0.18", 6)).toBe(180000n);
    expect(parseAmount("12", 6)).toBe(12000000n);
    expect(parseAmount("0.000001", 6)).toBe(1n);
    expect(parseAmount(" 1.5 ", 2)).toBe(150n);
    expect(() => parseAmount("0.0000001", 6)).toThrow(/at most 6 decimals/);
    expect(() => parseAmount("-1", 6)).toThrow(/not an amount/);
    expect(() => parseAmount("1e3", 6)).toThrow(/not an amount/);
  });
});

describe("statements from the specification vectors", () => {
  it("builds a statement from every valid vector", () => {
    for (const name of VECTOR_NAMES) {
      const v = vector(name);
      expect(v.expected.ok).toBe(true);
      const s = buildStatement(v.bundle, { generatedAt: "2026-11-01T00:00:00.000Z" });
      expect(s.client).toBe(v.bundle.principalId);
      expect(s.period.given).toBe(false);
      expect(formatStatementText(s)).toContain("SETTLED:");
      expect(formatStatementHtml(s)).toContain("<h2>Settled:");
    }
  });

  it("sums the settlements of 01-basic and names the key that signed the last receipt", () => {
    const v = vector("01-basic.json");
    const s = buildStatement(v.bundle, {});
    const expected = v.bundle.receipts.filter((r) => r.kind === "payment.settled").reduce((t, r) => t + BigInt(String(r.data.amount)), 0n);
    expect(s.settled.count).toBe(2);
    expect(s.settled.total).toBe(human(expected, 6));
    expect(s.keys.evidence?.toLowerCase()).toBe(v.bundle.gateway.address.toLowerCase());
    expect(s.keys.signed).toEqual([v.bundle.gateway.address.toLowerCase()]);
  });

  it("reads a signed approval: who approved, how much, under which policy version, and that it was consumed", () => {
    const s = buildStatement(vector("15-approval-signed.json").bundle, {});
    expect(s.approvals).toHaveLength(1);
    const a = s.approvals[0]!;
    expect(a.outcome).toBe("granted");
    expect(a.approver).toEqual({ id: "cfo", method: "signature", address: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" });
    expect(a.amount).toBe("0.040000");
    expect(a.policyVersion).toBe(1);
    expect(a.consumed).toBe(true);
    expect(formatStatementText(s)).toContain("granted 2026-10-18T09:09:");
  });

  it("lists mandates with delegation, caps in human units, and the anchor's coverage", () => {
    const m = buildStatement(vector("21-credentials-delegated.json").bundle, {}).mandates;
    expect(m.length).toBeGreaterThan(1);
    const child = m.find((x) => x.delegatedBy !== null)!;
    expect(child.delegatedBy).toBe(m.find((x) => x.credentialId === vector("21-credentials-delegated.json").bundle.credentials.find((c) => c.id === child.credentialId)!.parentId)!.agentId);
    expect(child.spendCap === null || /^\d+\.\d{6}$/.test(child.spendCap)).toBe(true);
    const v32 = vector("32-anchors-evidence-key.json").bundle;
    const anchored = buildStatement(v32, {});
    expect(anchored.anchor).not.toBeNull();
    // the anchoring receipt itself, and anything after it, lie beyond the anchored head
    const top = [...v32.anchors].sort((a, b) => b.count - a.count)[0]!;
    expect(anchored.anchor!.coversPeriod).toBe(top.count - 1 >= v32.receipts.length - 1);
    expect(anchored.notes.some((n) => n.includes("no on-chain anchor"))).toBe(false);
    const upToAnchor = buildStatement(v32, { period: { from: v32.receipts[0]!.ts, to: v32.receipts[top.count - 1]!.ts.replace(/\.\d{3}Z$/, ".001Z"), label: "up to the anchor" } });
    expect(upToAnchor.anchor!.coversPeriod).toBe(true);
  });
});

describe("the period and the split", () => {
  const b = bundle([
    settled("2026-09-30T23:30:00.000Z", "50000"),
    settled("2026-10-02T10:00:00.000Z", "10000"),
    settled("2026-10-03T10:00:00.000Z", "20000", { payee: "0x0000000000000000000000000000000000000000", resource: "/v1/lightning-quote", lightning: { amountSats: "32" } }, { agentId: "ops-agent", rail: "l402" }),
    settled("2026-10-04T10:00:00.000Z", "3000", { subscriptionId: "sub_1", resource: "/v1/feed" }, { rail: "mpp" }),
    settled("2026-11-01T00:00:00.000Z", "70000"),
  ]);

  it("counts only the period's settlements and splits them by rail, agent and payee without double counting subscriptions", () => {
    const s = build(b);
    expect(s.source.receipts).toBe(5);
    expect(s.source.inPeriod).toBe(3);
    expect(s.settled.count).toBe(3);
    expect(s.settled.total).toBe("0.033000");
    expect(s.settled.byRail).toEqual([
      { key: "l402", count: 1, total: "0.020000" },
      { key: "x402", count: 1, total: "0.010000" },
      { key: "mpp", count: 1, total: "0.003000" },
    ]);
    expect(s.settled.byAgent.map((l) => [l.key, l.count])).toEqual([
      ["ops-agent", 1],
      ["research-agent", 2],
    ]);
    expect(s.settled.byPayee[0]).toEqual({ key: "0x0000000000000000000000000000000000000000", count: 1, total: "0.020000", detail: "/v1/lightning-quote, lightning" });
    expect(s.settled.byPayee[1]).toEqual({ key: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", count: 2, total: "0.013000", detail: "/v1/feed, /v1/quote" });
    expect(s.settled.subscriptions).toEqual({ count: 1, total: "0.003000", ids: ["sub_1"] });
  });

  it("covers the whole record when no period is given, and says so", () => {
    const s = buildStatement(b, {});
    expect(s.settled.count).toBe(5);
    expect(s.period.label).toBe("the whole record");
    expect(s.notes[0]).toMatch(/No period was given/);
  });

  it("names the policy versions in force during the period and the version each approval ran under", () => {
    const versions = [
      { version: 1, hash: `0x${"1".repeat(64)}`, prevHash: null, activatedAt: "2026-08-01T00:00:00.000Z", activatedBy: "config", document: {} },
      { version: 2, hash: `0x${"2".repeat(64)}`, prevHash: `0x${"1".repeat(64)}`, activatedAt: "2026-09-15T00:00:00.000Z", activatedBy: "alice", document: {} },
      { version: 3, hash: `0x${"3".repeat(64)}`, prevHash: `0x${"2".repeat(64)}`, activatedAt: "2026-10-20T00:00:00.000Z", document: {} },
      { version: 4, hash: `0x${"4".repeat(64)}`, prevHash: `0x${"3".repeat(64)}`, activatedAt: "2026-11-05T00:00:00.000Z", document: {} },
    ];
    const approval = { id: "apr_1", principalId: "client-a", intentHash: `0x${"f".repeat(64)}`, amount: "40000", payee: { host: "api.example.com" }, resource: "/v1/report" };
    const s = build(
      bundle(
        [
          receipt("approval.requested", "2026-10-10T00:00:00.000Z", { approval }, { approvalId: "apr_1" }),
          receipt("approval.rejected", "2026-10-10T00:01:00.000Z", { approval, approver: { id: "cfo", method: "signature", address: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", signature: "0x00" } }, { approvalId: "apr_1" }),
          receipt("approval.requested", "2026-10-25T00:00:00.000Z", { approval: { ...approval, id: "apr_2" } }, { approvalId: "apr_2" }),
        ],
        { policyVersions: versions },
      ),
    );
    expect(s.policyVersions.map((p) => p.version)).toEqual([2, 3]);
    expect(s.approvals.map((a) => [a.id, a.outcome, a.policyVersion, a.approver?.id ?? null, a.payee, a.consumed])).toEqual([
      ["apr_1", "rejected", 2, "cfo", "api.example.com", false],
      ["apr_2", "pending", 3, null, "api.example.com", false],
    ]);
  });
});

describe("denials, unsettled allows, reclaims and events", () => {
  it("groups denials by reason and says when the amount was not recorded", () => {
    const s = build(
      bundle([
        denied("2026-10-02T00:00:00.000Z", { stage: "precheck", effect: "deny", reasons: ["CAVEAT:rate_limit", "BUDGET:daily"] }),
        denied("2026-10-02T00:01:00.000Z", { stage: "quote", effect: "deny", reasons: ["BUDGET:daily"], amount: "10000" }),
        denied("2026-10-02T00:02:00.000Z", { stage: "quote", effect: "deny", reasons: ["BUDGET:daily"] }),
        denied("2026-10-02T00:03:00.000Z", { stage: "probe", reason: "payee unreachable: timeout" }),
        receipt("onchain.denied", "2026-10-02T00:04:00.000Z", { reason: "SpendLimit" }, { agentId: "ops-agent" }),
      ]),
    );
    expect(s.denials).toEqual([
      { key: "BUDGET:daily", count: 2, total: "0.010000", detail: "amount recorded for 1 of 2" },
      { key: "CAVEAT:rate_limit, BUDGET:daily", count: 1, total: "0.000000", detail: "amount not recorded" },
      { key: "payee unreachable: timeout", count: 1, total: "0.000000", detail: "amount not recorded" },
      { key: "account contract rejected: SpendLimit", count: 1, total: "0.000000", detail: "amount not recorded" },
    ]);
    expect(formatStatementText(s)).toContain("DENIED: 5 attempts");
  });

  it("lists payments allowed at the quote stage that never settled, ignoring prechecks and intents denied afterwards", () => {
    const s = build(
      bundle([
        receipt("decision", "2026-10-02T00:00:00.000Z", { stage: "precheck", effect: "allow", amount: "0" }, { intentId: "int_pre" }),
        allowQuote("2026-10-02T00:01:00.000Z", "int_lost", "25000"),
        allowQuote("2026-10-02T00:02:00.000Z", "int_paid", "10000"),
        settled("2026-10-02T00:02:30.000Z", "10000", {}, { intentId: "int_paid" }),
        allowQuote("2026-10-02T00:03:00.000Z", "int_then_denied", "5000"),
        denied("2026-10-02T00:03:30.000Z", { stage: "probe", reason: "payee unreachable: timeout" }, { intentId: "int_then_denied" }),
        receipt("preapproval.reclaimed", "2026-10-09T00:00:00.000Z", { value: "1000" }),
      ]),
    );
    expect(s.notSettled).toEqual({ count: 1, total: "0.025000", items: [{ intentId: "int_lost", at: "2026-10-02T00:01:00.000Z", agentId: "research-agent", amount: "0.025000", payee: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" }] });
    expect(s.reclaimed).toEqual({ count: 1, total: "0.001000" });
  });

  it("turns kill switches, policy activations, approver keys and anchors into event lines", () => {
    const s = build(
      bundle([
        receipt("policy.updated", "2026-10-01T00:00:00.000Z", { version: 2, activatedBy: "alice@client-a" }),
        receipt("killswitch", "2026-10-05T00:00:00.000Z", { on: true, reason: "suspected compromise" }),
        receipt("killswitch", "2026-10-05T01:00:00.000Z", { on: false }),
        receipt("approver.registered", "2026-10-06T00:00:00.000Z", { approverId: "cfo", address: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", prevAddress: null }),
        receipt("evidence.anchored", "2026-10-31T00:00:00.000Z", { head: `0x${"9".repeat(64)}`, count: 5, blockNumber: "36", txHash: `0x${"8".repeat(64)}` }),
      ]),
    );
    expect(s.events.map((e) => e.text)).toEqual([
      "policy version 2 activated by alice@client-a",
      "kill switch ON: suspected compromise",
      "kill switch off",
      "approver cfo key registered: 0x15d3…6A65",
      "chain anchored on-chain: 5 receipts, head 0x9999…9999, block 36",
    ]);
    expect(s.notes).toContain("The chain has no on-chain anchor: every receipt rests on the gateway's signature alone.");
  });
});

describe("reconciliation", () => {
  const b = () =>
    bundle([
      settled("2026-09-30T23:00:00.000Z", "50000"), // boundary: within two days before the period
      settled("2026-09-01T00:00:00.000Z", "999999"), // outside the boundary window
      settled("2026-10-02T10:00:00.000Z", "10000"),
      settled("2026-10-03T10:00:00.000Z", "20000"),
      settled("2026-10-04T10:00:00.000Z", "3000", { subscriptionId: "sub_1", resource: "/v1/feed" }, { rail: "mpp" }),
      settled("2026-10-05T10:00:00.000Z", "7000", { payee: "0x0000000000000000000000000000000000000000", resource: "/v1/other" }, { rail: "l402" }),
      allowQuote("2026-10-06T00:00:00.000Z", "int_lost", "25000"),
      settled("2026-11-02T12:00:00.000Z", "4000"), // boundary: within two days after the period
    ]);
  const rec = (providerTotal: string, extra: Parameters<typeof buildStatement>[1] = {}) => build(b(), { providerTotal, ...extra }).reconciliation!;

  it("reports a match", () => {
    const r = rec("0.040000");
    expect(r.statementCount).toBe(4);
    expect(r.statementTotal).toBe("0.040000");
    expect(r.difference).toBe("0.000000");
    expect(r.verdict).toBe("matches");
    expect(r.remainder).toBe("0.000000");
    expect(r.components.map((c) => [c.key, c.direction, c.count, c.total])).toEqual([
      ["subscriptions", "subtract", 1, "0.003000"],
      ["boundary", "add", 2, "0.054000"],
      ["unsettled", "add", 1, "0.025000"],
    ]);
  });

  it("explains a difference that equals one component or a combination, with fixed directions", () => {
    expect(rec("0.037000")).toMatchObject({ verdict: "explained", explainedBy: ["subscriptions"], difference: "-0.003000", remainder: "0.000000" });
    expect(rec("0.094000")).toMatchObject({ verdict: "explained", explainedBy: ["boundary"] });
    expect(rec("0.065000")).toMatchObject({ verdict: "explained", explainedBy: ["unsettled"] });
    expect(rec("0.116000")).toMatchObject({ verdict: "explained", explainedBy: ["subscriptions", "boundary", "unsettled"] });
    expect(formatStatementText(build(b(), { providerTotal: "0.116" }))).toContain("the difference equals minus subscriptions (1, 0.003000 USDC) plus boundary (2, 0.054000 USDC) plus unsettled (1, 0.025000 USDC)");
  });

  it("calls everything else unexplained and keeps the whole difference as the remainder", () => {
    const s = build(b(), { providerTotal: "0.040001" });
    expect(s.reconciliation).toMatchObject({ verdict: "unexplained", explainedBy: [], difference: "0.000001", remainder: "0.000001" });
    expect(s.notes.some((n) => n.startsWith("The provider total differs from the statement by 0.000001"))).toBe(true);
    expect(rec("0.043000").verdict).toBe("unexplained"); // adding subscriptions is not a permitted direction
    expect(rec("0.000000").verdict).toBe("unexplained");
  });

  it("reconciles one payee when named, with the boundary and unsettled items of that payee only", () => {
    const r = rec("0.033000", { payee: "0x3c44cddDb6a900fa2b585dd299e03d12fa4293bc" });
    expect(r.payee).toBe("0x3c44cddDb6a900fa2b585dd299e03d12fa4293bc");
    expect(r.statementCount).toBe(3);
    expect(r.verdict).toBe("matches");
    const other = rec("0.007000", { payee: "0x0000000000000000000000000000000000000000" });
    expect(other.statementCount).toBe(1);
    expect(other.components).toEqual([]);
    expect(other.verdict).toBe("matches");
  });

  it("honours --boundary-days and rejects a provider total it cannot read", () => {
    expect(rec("0.040000", { boundaryDays: 0 }).components.map((c) => c.key)).toEqual(["subscriptions", "unsettled"]);
    expect(rec("0.040000", { boundaryDays: 40 }).components.find((c) => c.key === "boundary")).toMatchObject({ count: 3, total: "1.053999" });
    expect(() => rec("0.0000001")).toThrow(/at most 6 decimals/);
    expect(() => rec("abc")).toThrow(/not an amount/);
  });
});

describe("rendering", () => {
  it("writes the figures, the verify command and the notes to text and html, escaping what the record says", () => {
    const s = build(bundle([settled("2026-10-02T10:00:00.000Z", "10000"), denied("2026-10-02T10:01:00.000Z", { reason: "<script>alert(1)</script>" })]), {
      sourceName: "client-a.json",
      sourceSha256: "ab".repeat(32),
      verification: { ok: true, checks: [{ check: "schema", ok: true }, { check: "receipts.chain", ok: true }] },
    });
    const text = formatStatementText(s);
    expect(text).toContain("SpendMarshal statement for client-a: October 2026");
    expect(text).toContain("verification: 2/2 checks passed (offline)");
    expect(text).toContain("SETTLED: 1 payment, 0.010000 USDC");
    expect(text).toContain("VERIFY: spendmarshal verify client-a.json --gateway-key 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266; SHA-256 of the file as received: " + "ab".repeat(32));
    expect(text).toContain("<script>alert(1)</script>: 1 attempt");
    const html = formatStatementHtml(s);
    expect(html).toContain("<title>Statement for client-a: October 2026</title>");
    expect(html).toContain("Verified offline: 2 of 2 checks passed.");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("spendmarshal verify client-a.json --gateway-key 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
  });

  it("marks a statement produced from a bundle that failed verification", () => {
    const s = build(bundle([settled("2026-10-02T10:00:00.000Z", "10000")]), { verification: { ok: false, checks: [{ check: "schema", ok: true }, { check: "receipts.chain", ok: false, detail: "seq 1 not intact" }] } });
    expect(s.verification).toEqual({ ok: false, passed: 1, total: 2, failed: ["receipts.chain"] });
    expect(formatStatementText(s)).toContain("verification: FAILED receipts.chain (1/2 passed)");
    expect(formatStatementHtml(s)).toContain("NOT VERIFIED: failed receipts.chain");
    expect(s.notes.some((n) => n.startsWith("NOT VERIFIED"))).toBe(true);
  });
});

describe("the command", () => {
  async function run(args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    });
    const error = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      err.push(a.join(" "));
    });
    try {
      return { code: await main(args), out: out.join("\n"), err: err.join("\n") };
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "spendmarshal-statement-"));
  const file = (name: string, content: unknown) => {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(content));
    return p;
  };

  it("verifies the bundle, then prints the statement in text, html or json", async () => {
    const good = file("good.json", vector("01-basic.json").bundle);
    const text = await run(["statement", good]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("SETTLED: 2 payments");
    expect(text.out).toContain("verification: ");
    expect(text.out).toContain("SHA-256 of the file as received: ");
    const out = join(dir, "statement.html");
    const html = await run(["statement", good, "--format", "html", "--out", out]);
    expect(html.code).toBe(0);
    expect(html.out).toBe(`wrote ${out}`);
    expect(readFileSync(out, "utf8")).toContain("<h2>Settled: 2 payments");
    const json = await run(["statement", good, "--format", "json", "--provider-total", "0.03", "--period", "2026-10"]);
    expect(json.code).toBe(0);
    const s = JSON.parse(json.out) as Statement;
    expect(s.period.label).toBe("October 2026");
    expect(s.reconciliation?.providerTotal).toBe("0.030000");
    expect(s.source.name).toBe("good.json");
  });

  it("refuses a bundle that does not verify unless --unverified is passed, and then marks the statement", async () => {
    const bad = file("bad.json", vector("02-receipt-data-edited.json").bundle);
    const refused = await run(["statement", bad]);
    expect(refused.code).toBe(2);
    expect(refused.out).toContain("FAILED");
    expect(refused.err).toContain("does not verify");
    const marked = await run(["statement", bad, "--unverified"]);
    expect(marked.code).toBe(0);
    expect(marked.out).toContain("verification: FAILED");
    expect(marked.out).toContain("NOT VERIFIED: the bundle failed");
  });

  it("rejects what it cannot read with exit code 2 and a message", async () => {
    const good = file("good2.json", vector("01-basic.json").bundle);
    expect(await run(["statement", good, "--period", "last-month"])).toMatchObject({ code: 2, err: expect.stringContaining("--period must be") });
    expect(await run(["statement", good, "--provider-total", "x"])).toMatchObject({ code: 2, err: expect.stringContaining("not an amount") });
    expect(await run(["statement", good, "--boundary-days=-1"])).toMatchObject({ code: 2, err: expect.stringContaining("--boundary-days") });
    expect(await run(["statement", good, "--provider-total", "0.0000001"])).toMatchObject({ code: 2, err: expect.stringContaining("at most 6 decimals") });
    expect(await run(["statement", file("notabundle.json", { hello: 1 })])).toMatchObject({ code: 2, err: expect.stringContaining("not an evidence bundle") });
    expect((await run(["statement"])).code).toBe(1);
  });
});
