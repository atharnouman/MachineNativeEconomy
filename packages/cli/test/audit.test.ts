import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { audit, budgetPeriod, formatAuditHtml, formatAuditText, money, parseBudgets, parseExport, type AuditReport, type Finding } from "../src/audit.js";
import { main } from "../src/index.js";

const T0 = Date.parse("2026-09-01T09:00:00Z");
const NOW = new Date("2026-10-01T00:00:00Z");
const KEY = "a".repeat(64);
const DAY = 86_400_000;
const at = (minutes: number, seconds = 0) => new Date(T0 + minutes * 60_000 + seconds * 1000).toISOString();
const onDay = (d: number) => new Date(T0 + d * DAY).toISOString();
type Row = Record<string, unknown>;
let seq = 0;
/** a LiteLLM_SpendLogs row as /spend/logs/v2 returns it, with overrides */
function row(over: Row = {}): Row {
  seq++;
  return {
    request_id: `req-${String(seq).padStart(4, "0")}`,
    call_type: "acompletion",
    api_key: KEY,
    spend: 0.01,
    total_tokens: 120,
    prompt_tokens: 100,
    completion_tokens: 20,
    startTime: at(0),
    endTime: at(0, 1),
    model: "gpt-4o",
    model_group: "gpt-4o",
    custom_llm_provider: "openai",
    session_id: "s1",
    status: "success",
    cache_hit: "False",
    metadata: { user_api_key_alias: "agent-key" },
    ...over,
  };
}
const run = (rows: unknown, opts: Parameters<typeof audit>[1] = {}) => audit(JSON.stringify(rows), { now: NOW, ...opts });
const of = (r: AuditReport, detector: Finding["detector"], label?: string) => r.findings.filter((f) => f.detector === detector && (!label || f.label.startsWith(label)));

describe("parsing", () => {
  it("reads an array, a v2 page, an array of pages and newline-delimited rows", () => {
    const rows = [row(), row({ startTime: at(1) })];
    const counts = [
      parseExport(JSON.stringify(rows)),
      parseExport(JSON.stringify({ data: rows, total: 2, page: 1, page_size: 50, total_pages: 1 })),
      parseExport(JSON.stringify([{ data: [rows[0]] }, { data: [rows[1]] }])),
      parseExport(rows.map((r) => JSON.stringify(r)).join("\n")),
    ].map((p) => p.rows.length);
    expect(counts).toEqual([2, 2, 2, 2]);
  });

  it("counts rows it cannot read and duplicate request ids, reads seconds, and sorts by time", () => {
    const dup = row();
    const { rows, skipped } = parseExport(JSON.stringify([row({ startTime: at(5) }), { request_id: "x", spend: 1 }, "junk", dup, dup, row({ startTime: 1_756_717_200 })]));
    expect(skipped).toEqual({ "no usable startTime": 1, "not an object": 1, "duplicate row (same request_id)": 1 });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.at)).toEqual([...rows.map((r) => r.at)].sort((a, b) => a - b));
    expect(rows.some((r) => r.at === 1_756_717_200_000)).toBe(true);
  });

  it("takes the fingerprint from cache_key, then messages, then shape", () => {
    const messages = [{ role: "user", content: "x" }];
    const { rows, contentHashed } = parseExport(JSON.stringify([row({ cache_key: "ck", messages }), row({ messages }), row({ messages: {} }), row()]));
    expect(rows.map((r) => r.fingerprint.basis)).toEqual(["cache_key", "content", "shape", "shape"]);
    expect(rows[1]!.fingerprint.value).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHashed).toBe(1);
  });

  it("maps status, cache_hit, model_group and the key alias", () => {
    const { rows } = parseExport(JSON.stringify([row({ status: "failure" }), row({ cache_hit: "True", model_group: undefined, model: "openai/gpt-4o" }), row({ status: undefined }), row({ completion_tokens: 0 }), row({ call_type: "aembedding", completion_tokens: 0 })]));
    expect(rows.map((r) => r.outcome)).toEqual(["error", "ok", "unknown", "empty", "ok"]);
    expect(rows[0]).toMatchObject({ cacheHit: false, keyAlias: "agent-key", model: "gpt-4o", rawModel: "gpt-4o" });
    expect(rows[1]).toMatchObject({ cacheHit: true, model: "openai/gpt-4o", rawModel: "openai/gpt-4o" });
  });
});

describe("repeated requests", () => {
  it("counts repeats of one cache key in one session within the window, all but the first", () => {
    const rows = [0, 2, 4, 15].map((m) => row({ startTime: at(m), cache_key: "ck-1" }));
    const r = run(rows);
    const [f] = of(r, "repeated-requests", "repeated request");
    expect(f?.count).toBe(2);
    expect(f?.amount).toBeCloseTo(0.02, 10);
    expect(f?.evidence).toEqual([rows[1]!.request_id, rows[2]!.request_id]);
    expect(f?.title).toBe("2 repeated requests within 10 min cost $0.02");
    expect(r.avoidable).toBeCloseTo(0.02, 10);
  });

  it("ignores cache hits, other sessions and repeats outside the window", () => {
    const r = run([row({ cache_key: "ck-1" }), row({ cache_key: "ck-1", cache_hit: "True", startTime: at(1) }), row({ cache_key: "ck-1", session_id: "s2", startTime: at(2) }), row({ cache_key: "ck-1", startTime: at(11) })]);
    expect(of(r, "repeated-requests")).toEqual([]);
  });

  it("hashes messages in memory to recognise repeats and never prints them", () => {
    const messages = [{ role: "user", content: "SECRET PROMPT TEXT" }];
    const r = run([row({ messages }), row({ messages, startTime: at(1) })]);
    expect(of(r, "repeated-requests", "repeated request")[0]?.count).toBe(1);
    expect(r.coverage.contentHashed).toBe(2);
    expect(formatAuditText(r) + formatAuditHtml(r) + JSON.stringify(r)).not.toContain("SECRET PROMPT");
  });

  it("labels shape-only repeats as possible and keeps them out of the avoidable total", () => {
    const r = run([row(), row({ startTime: at(1) }), row({ startTime: at(2), prompt_tokens: 101 })]);
    const [f] = of(r, "repeated-requests", "possible repeated request");
    expect(f?.count).toBe(1);
    expect(of(r, "repeated-requests", "repeated request")).toEqual([]);
    expect(r.avoidable).toBe(0);
  });

  it("respects the window option", () => {
    const rows = [0, 2, 4].map((m) => row({ startTime: at(m), cache_key: "ck-1" }));
    expect(of(run(rows, { windowMs: 60_000 }), "repeated-requests")).toEqual([]);
    expect(of(run(rows, { windowMs: 5 * 60_000 }), "repeated-requests")[0]?.count).toBe(2);
  });
});

describe("retry storms", () => {
  const fail = (seconds: number, over: Row = {}) => row({ startTime: at(0, seconds), status: "failure", completion_tokens: 0, ...over });

  it("finds five consecutive failures within a minute on one session, counted once in the avoidable total", () => {
    const r = run([0, 10, 20, 30, 40].map((s) => fail(s)));
    const [f] = of(r, "retry-storms");
    expect(f?.count).toBe(5);
    expect(f?.title).toBe("1 retry storm on 1 session cost $0.05");
    expect(f?.evidence).toEqual(["s1: 5 calls, $0.05"]);
    expect(f?.evidenceTotal).toBe(1);
    expect(formatAuditText(r)).toContain("evidence: s1: 5 calls, $0.05\n");
    expect(r.avoidable).toBeCloseTo(0.05, 10);
  });

  it("merges overlapping windows into one storm", () => {
    const r = run([0, 10, 20, 30, 40, 70, 80].map((s) => fail(s)));
    expect(of(r, "retry-storms")[0]?.count).toBe(7);
    expect(of(r, "retry-storms")[0]?.title).toMatch(/^1 retry storm on 1 session/);
  });

  it("treats a successful call between failures as progress", () => {
    const r = run([fail(0), fail(10), fail(20), row({ startTime: at(0, 25) }), fail(30), fail(40)]);
    expect(of(r, "retry-storms")).toEqual([]);
  });

  it("needs the configured number of calls inside the storm window", () => {
    const four = [0, 10, 20, 30].map((s) => fail(s));
    expect(of(run(four), "retry-storms")).toEqual([]);
    expect(of(run(four, { stormCalls: 4 }), "retry-storms")[0]?.count).toBe(4);
    const spread = [0, 30, 60, 90, 120].map((s) => fail(s));
    expect(of(run(spread), "retry-storms")).toEqual([]);
    expect(of(run(spread, { stormWindowMs: 180_000 }), "retry-storms")[0]?.count).toBe(5);
  });

  it("groups by session, then agent, then key", () => {
    const r = run([0, 10, 20, 30, 40].map((s) => fail(s, { session_id: null, agent_id: "agent-7" })));
    expect(of(r, "retry-storms")[0]?.evidence).toEqual(["agent-7: 5 calls, $0.05"]);
    const byKey = run([0, 10, 20, 30, 40].map((s) => fail(s, { session_id: null })));
    expect(byKey.findings.find((f) => f.detector === "retry-storms")?.evidence[0]).toMatch(/^aaaaaaaaaa…aaaaaa: 5 calls/);
  });
});

describe("dead spend and unknown outcomes", () => {
  it("adds failed and empty calls and reports unknown outcomes without counting them", () => {
    const r = run([row(), row({ status: "failure", spend: 0.02, prompt_tokens: 7 }), row({ completion_tokens: 0, spend: 0.03, prompt_tokens: 8 }), row({ status: undefined, spend: 0.04, prompt_tokens: 9 })]);
    const [dead] = of(r, "dead-spend", "failed run");
    const [unknown] = of(r, "dead-spend", "outcome unknown");
    expect(dead).toMatchObject({ count: 2, title: "$0.05 on 2 failed or empty calls (50.0% of spend)", evidence: ["s1: $0.05"], evidenceTotal: 1 });
    expect(dead?.amount).toBeCloseTo(0.05, 10);
    expect(unknown).toMatchObject({ amount: 0, count: 1 });
    expect(r.totals).toMatchObject({ okSpend: 0.01, errorSpend: 0.02, emptySpend: 0.03, unknownSpend: 0.04 });
    expect(r.avoidable).toBeCloseTo(0.05, 10);
    expect(r.coverage.unknownOutcomes).toBe(1);
  });

  it("an embedding with no completion tokens is not empty", () => {
    const r = run([row({ call_type: "aembedding", completion_tokens: 0 })]);
    expect(r.totals.emptySpend).toBe(0);
    expect(of(r, "dead-spend")).toEqual([]);
  });
});

describe("expensive models on small outputs", () => {
  const calls = (model: string, spend: number, completion = 10, n = 25) =>
    Array.from({ length: n }, (_, i) => row({ model, model_group: model, spend, completion_tokens: completion, prompt_tokens: 900 + i, total_tokens: 1000, startTime: at(i) }));

  it("flags a model at or above the threshold with a median answer of 40 tokens or fewer", () => {
    const r = run(calls("claude-opus", 0.02)); // $20 per million tokens, observed
    const [f] = of(r, "expensive-model-small-outputs");
    expect(f).toMatchObject({ count: 25, amount: 0, title: "claude-opus: 25 calls at $20.00 per million tokens with a median answer of 10 tokens ($0.50)" });
    expect(f?.detail).toContain("observed blended cost");
    expect(r.avoidable).toBe(0);
  });

  it("leaves cheap models, long answers and small samples alone", () => {
    expect(of(run(calls("gpt-4o-mini", 0.0002)), "expensive-model-small-outputs")).toEqual([]);
    expect(of(run(calls("claude-opus", 0.02, 300)), "expensive-model-small-outputs")).toEqual([]);
    expect(of(run(calls("claude-opus", 0.02, 10, 19)), "expensive-model-small-outputs")).toEqual([]);
    expect(of(run(calls("claude-opus", 0.02), { expensivePerMillion: 25 }), "expensive-model-small-outputs")).toEqual([]);
  });

  it("uses the price table when given, by model, model_group or provider/model", () => {
    const cheapListed = run(calls("claude-opus", 0.02), { prices: { "claude-opus": { input_cost_per_token: 0.000001 } } });
    expect(of(cheapListed, "expensive-model-small-outputs")).toEqual([]);
    const listed = run(calls("gpt-4o-mini", 0.0002), { prices: { "openai/gpt-4o-mini": { input_cost_per_token: 0.00002 } } });
    expect(of(listed, "expensive-model-small-outputs")[0]?.detail).toContain("list price $20.00 per million tokens");
  });
});

describe("allowance review", () => {
  const daily = (days: number, spend = 2, over: Row = {}) => Array.from({ length: days }, (_, d) => row({ startTime: onDay(d), spend, prompt_tokens: 100 + d, ...over }));
  const budgets = (keys: unknown[] = [], teams: unknown[] = []) => parseBudgets(JSON.stringify({ keys, teams }));

  it("finds a cap more than five times the busiest period", () => {
    const r = run(daily(31), { budgets: budgets([{ token: KEY, key_alias: "finance-bot", max_budget: 1000, budget_duration: "30d" }]) });
    const [f] = of(r, "allowance-review", "budget review suggestion (a cap far above");
    expect(f).toMatchObject({ amount: 0, count: 1, evidence: ["key finance-bot: cap $1,000 per 30 d, busiest 30 d $60.00"] });
    expect(r.coverage.capsForKeys).toBe(1);
    expect(formatAuditText(r)).toContain("caps supplied for 1 key and 0 teams");
  });

  it("finds a cap within 10% of use, including lifetime caps", () => {
    const tight = run(daily(31), { budgets: budgets([{ token: KEY, max_budget: 65, budget_duration: "30d" }]) });
    expect(of(tight, "allowance-review", "budget review suggestion (a cap this close")[0]?.evidence).toEqual(["key agent-key: busiest 30 d $60.00 against a $65.00 cap"]);
    const lifetime = run(daily(31), { budgets: budgets([{ token: KEY, max_budget: 62 }]) });
    expect(of(lifetime, "allowance-review", "budget review suggestion (a cap this close")[0]?.evidence).toEqual(["key agent-key: $62.00 spent of a $62.00 lifetime cap"]);
  });

  it("does not judge slack from an export shorter than the budget period, counting coverage in whole days", () => {
    const r = run(daily(10), { budgets: budgets([{ token: KEY, max_budget: 1000, budget_duration: "30d" }]) });
    expect(of(r, "allowance-review")).toEqual([]);
    // rows inside 1 to 30 September cover 30 days even though the first and last timestamps are less than 30 days apart
    const inside = daily(30, 2).map((x, d) => ({ ...x, startTime: new Date(T0 + d * DAY + (d === 0 ? 3_600_000 : 0)).toISOString() }));
    const covered = run(inside, { budgets: budgets([{ token: KEY, max_budget: 1000, budget_duration: "30d" }]) });
    expect(covered.period.days).toBe(30);
    expect(of(covered, "allowance-review", "budget review suggestion (a cap far above")[0]?.evidence).toEqual(["key agent-key: cap $1,000 per 30 d, busiest 30 d $60.00"]);
  });

  it("reads team caps, hashes raw keys, and notes caps without rows or with unreadable durations", () => {
    const b = parseBudgets(
      JSON.stringify({
        keys: [
          { token: "sk-raw", max_budget: 1000, budget_duration: "30d" },
          { token: KEY, max_budget: 1000, budget_duration: "fortnight" },
        ],
        teams: [{ team_id: "team-a", team_alias: "Team A", max_budget: 5000, budget_duration: "1mo" }],
      }),
    );
    expect([...b.keys.keys()]).toEqual([createHash("sha256").update("sk-raw").digest("hex"), KEY]);
    const r = run(daily(31, 2, { team_id: "team-a" }), { budgets: b });
    const [f] = of(r, "allowance-review", "budget review suggestion (a cap far above");
    expect(f?.evidence).toEqual(["team Team A: cap $5,000 per 30 d, busiest 30 d $60.00"]);
    expect(f?.detail).toContain("1 capped keys or teams had no rows in the export and were not assessed");
    expect(f?.detail).toContain("1 cap had a budget_duration this tool does not read");
    expect(formatAuditText(r)).not.toContain("sk-raw");
  });

  it("accepts /key/info and /team/list shapes", () => {
    const info = parseBudgets(JSON.stringify({ key: "sk-x", info: { token: KEY, max_budget: 5, budget_duration: null, spend: 1 } }));
    expect(info.keys.get(KEY)).toEqual({ cap: 5, duration: null, alias: null });
    const teams = parseBudgets(JSON.stringify([{ team_id: "t1", team_alias: "T", max_budget: 10, keys: [{ token: KEY, max_budget: 3, key_alias: "k" }] }, { team_id: "t2", max_budget: null }]));
    expect(teams.teams.get("t1")).toEqual({ cap: 10, duration: null, alias: "T" });
    expect(teams.keys.get(KEY)).toEqual({ cap: 3, duration: null, alias: "k" });
    expect(teams.teams.has("t2")).toBe(false);
  });

  it("flags keys whose busiest day dwarfs their typical day, without caps", () => {
    const r = run([...daily(7, 1), row({ startTime: onDay(7), spend: 50 })]);
    expect(of(r, "allowance-review", "budget review suggestion (bursts")[0]?.evidence).toEqual(["key agent-key: busiest day $50.00, typical day $1.00"]);
    expect(of(run(daily(8, 1)), "allowance-review")).toEqual([]);
  });

  it("parses LiteLLM budget durations", () => {
    expect([budgetPeriod("30d"), budgetPeriod("1mo"), budgetPeriod("24h"), budgetPeriod("90m")]).toEqual([30 * DAY, 30 * DAY, DAY, 5_400_000]);
    expect(budgetPeriod(null)).toBeNull();
    expect(budgetPeriod("fortnight")).toBeUndefined();
    expect(budgetPeriod("0d")).toBeUndefined();
  });
});

describe("report and rendering", () => {
  it("prints coverage, outcome totals and the avoidable line, and sorts findings by amount", () => {
    const r = run([row(), row({ status: "failure", spend: 0.5, prompt_tokens: 7 }), row({ cache_key: "ck", startTime: at(1) }), row({ cache_key: "ck", startTime: at(2) })]);
    const text = formatAuditText(r);
    expect(text).toContain("SpendMarshal audit-logs: 2026-09-01 to 2026-09-01 (1 day), 4 rows, $0.53 spend");
    expect(text).toContain("coverage: 4 rows read, 0 skipped; 0 with unknown outcome (0.0% of rows); 1 key, 1 session, 0 agents, 1 model; no caps supplied (pass --budgets to check allowances)");
    expect(text).toContain("spend by outcome: ok $0.03, failed $0.50, empty $0.00, unknown $0.00 (sums to $0.53)");
    expect(text).toContain("avoidable spend in question: $0.51 (96.2% of spend");
    expect(text).toMatch(/\n1\. \$0\.50 on 1 failed or empty call \(94\.3% of spend\)\n   label: failed run or empty response/);
    expect(text).toMatch(/\n2\. 1 repeated request within 10 min cost \$0\.01\n/);
    expect(r.findings.map((f) => f.amount)).toEqual([...r.findings.map((f) => f.amount)].sort((a, b) => b - a));
    expect(text.endsWith("the labels are the limits.")).toBe(true);
  });

  it("renders html with escaped text and json that round-trips", () => {
    const r = run([row({ session_id: "<s>&", status: "failure" })]);
    const html = formatAuditHtml(r);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("&lt;s&gt;&amp;: $0.01");
    expect(html).not.toContain("<s>&");
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    expect(r.generatedAt).toBe(NOW.toISOString());
  });

  it("says so when the export has no rows, and when there is nothing to report", () => {
    expect(formatAuditText(run([]))).toContain("no rows found");
    expect(formatAuditText(run([row()]))).toContain("no findings:");
  });

  it("formats money", () => {
    expect([money(0), money(0.0012), money(0.5), money(12.346), money(1234.4)]).toEqual(["$0.00", "$0.0012", "$0.50", "$12.35", "$1,234"]);
  });
});

describe("spendmarshal audit-logs", () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-audit-"));
  const file = join(dir, "export.json");
  writeFileSync(file, JSON.stringify([row(), row({ status: "failure", startTime: at(1), prompt_tokens: 7 })]));
  const capture = async (args: string[]) => {
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
  };

  it("prints text by default and json or html on request", async () => {
    const text = await capture(["audit-logs", file]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("SpendMarshal audit-logs: 2026-09-01 to 2026-09-01 (1 day), 2 rows, $0.02 spend");
    const json = await capture(["audit-logs", file, "--format", "json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out).totals.rows).toBe(2);
    const html = await capture(["audit-logs", file, "--format", "html"]);
    expect(html.out.startsWith("<!doctype html>")).toBe(true);
  });

  it("writes --out, takes --budgets and --prices, and fails cleanly on bad input", async () => {
    const out = join(dir, "report.html");
    const budgets = join(dir, "keys.json");
    writeFileSync(budgets, JSON.stringify({ keys: [{ token: KEY, max_budget: 9 }] }));
    const prices = join(dir, "prices.json");
    writeFileSync(prices, JSON.stringify({ "gpt-4o": { input_cost_per_token: 0.0000025 } }));
    const r = await capture(["audit-logs", file, "--format", "html", "--out", out, "--budgets", budgets, "--prices", prices, "--window", "5m", "--storm-calls", "3"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`wrote ${out}`);
    expect(readFileSync(out, "utf8")).toContain("caps supplied for 1 key and 0 teams");
    expect((await capture(["audit-logs"])).code).toBe(1);
    expect((await capture(["audit-logs", file, "--format", "pdf"])).code).toBe(1);
    const badWindow = await capture(["audit-logs", file, "--window", "soon"]);
    expect(badWindow.code).toBe(2);
    expect(badWindow.err).toBe("audit-logs: bad duration: soon");
    expect((await capture(["audit-logs", file, "--storm-calls", "1"])).code).toBe(2);
    expect((await capture(["audit-logs", join(dir, "missing.json")])).code).toBe(2);
  });
});
