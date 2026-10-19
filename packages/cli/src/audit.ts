import { createHash } from "node:crypto";
import { parseDuration } from "@spendmarshal/core";

/**
 * `spendmarshal audit-logs`: a read-only diagnostic over a LiteLLM spend-log export, the stage 1 "exceptions report"
 * computed offline from the rows alone. Five deterministic detectors, each with its source rows and an honest label
 * when the data cannot support more. Metadata only: `messages`, `response` and `proxy_server_request` are never
 * printed; when `messages` is present it is hashed in memory to recognise repeated requests, and the hash is not
 * printed either.
 *
 * Accepted shapes: a JSON array of rows (`GET /spend/logs?summarize=false`), one `/spend/logs/v2` page
 * (`{ data: [...] }`), an array of such pages, or newline-delimited rows. Field names follow LiteLLM's
 * `LiteLLM_SpendLogs` table (schema.prisma, read 19 Oct 2026); anything missing is treated as unknown, never guessed.
 */

export interface SpendRow {
  id: string;
  /** startTime, ms since the epoch */
  at: number;
  end: number | null;
  /** model_group when present (the name the caller used), else model */
  model: string;
  /** model as deployed, for price-table lookups */
  rawModel: string | null;
  provider: string | null;
  callType: string;
  /** the hashed virtual key, or "(none)" */
  apiKey: string;
  keyAlias: string | null;
  team: string | null;
  endUser: string | null;
  agent: string | null;
  session: string | null;
  spend: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  status: string | null;
  cacheHit: boolean | null;
  /** how a repeated request is recognised; the weaker basis gets the weaker label */
  fingerprint: { value: string; basis: "cache_key" | "content" | "shape" };
  outcome: "ok" | "error" | "empty" | "unknown";
}

export type Detector = "repeated-requests" | "retry-storms" | "dead-spend" | "expensive-model-small-outputs" | "allowance-review";

export interface Finding {
  detector: Detector;
  title: string;
  /** what the data supports, in the words of the advisor design */
  label: string;
  /** spend the finding puts in question, in the export's currency; 0 for a review suggestion or an unknown outcome */
  amount: number;
  count: number;
  detail: string;
  nextStep: string;
  /** request ids, sessions or keys, truncated for display; never content */
  evidence: string[];
  /** how many items `evidence` was cut from (rows, sessions, storms or caps, whichever it lists) */
  evidenceTotal: number;
}

export interface Allowance {
  cap: number;
  /** LiteLLM budget_duration ("30d", "1mo", "24h"); null is a lifetime cap */
  duration: string | null;
  alias: string | null;
}

/** Caps from a `/key/list?return_full_object=true`, `/key/info` or `/team/list` export (or the raw tables). */
export interface Budgets {
  keys: Map<string, Allowance>;
  teams: Map<string, Allowance>;
}

export type PriceTable = Record<string, { input_cost_per_token?: number; output_cost_per_token?: number }>;

export interface AuditOptions {
  /** repeats of one request inside this window count (default 10 minutes) */
  windowMs?: number;
  /** a retry storm is at least this many consecutive failed or empty calls on one session within `stormWindowMs` */
  stormCalls?: number;
  stormWindowMs?: number;
  /** a model at or above this many dollars per million tokens (list price, else observed) counts as expensive */
  expensivePerMillion?: number;
  /** LiteLLM-style price table, model -> { input_cost_per_token, output_cost_per_token } */
  prices?: PriceTable;
  budgets?: Budgets;
  now?: Date;
}

export interface AuditReport {
  generatedAt: string;
  period: { from: string | null; to: string | null; days: number };
  coverage: {
    rowsRead: number;
    rowsSkipped: number;
    skippedReasons: Record<string, number>;
    unknownOutcomes: number;
    keys: number;
    sessions: number;
    agents: number;
    models: number;
    /** rows whose repeat fingerprint came from hashing `messages` in memory */
    contentHashed: number;
    capsForKeys: number;
    capsForTeams: number;
  };
  totals: { rows: number; spend: number; okSpend: number; errorSpend: number; emptySpend: number; unknownSpend: number };
  options: { windowMs: number; stormCalls: number; stormWindowMs: number; expensivePerMillion: number; smallOutputTokens: number; minCallsPerModel: number };
  findings: Finding[];
  /** failed and empty calls plus confirmed repeats, each row counted once; unknown outcomes and review suggestions excluded */
  avoidable: number;
}

const DEFAULTS = { windowMs: 10 * 60_000, stormCalls: 5, stormWindowMs: 60_000, expensivePerMillion: 5 };
const SMALL_OUTPUT_TOKENS = 40;
const MIN_CALLS_PER_MODEL = 20;
const EVIDENCE_ROWS = 10;

// ───────────────────────────── parsing ─────────────────────────────

/** Rows from any of the accepted export shapes. Rows that cannot be read are counted by reason, never guessed at. */
export function parseExport(text: string): { rows: SpendRow[]; skipped: Record<string, number>; contentHashed: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // newline-delimited rows; a bad line throws, which is the right answer for a corrupt file
    raw = text
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  }
  const candidates: unknown[] = [];
  const collect = (v: unknown): void => {
    if (Array.isArray(v)) for (const x of v) collect(x);
    else if (v && typeof v === "object" && Array.isArray((v as { data?: unknown }).data)) collect((v as { data: unknown[] }).data);
    else candidates.push(v);
  };
  collect(raw);
  const rows: SpendRow[] = [];
  const skipped: Record<string, number> = {};
  const seen = new Set<string>();
  let contentHashed = 0;
  const skip = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  candidates.forEach((c, i) => {
    const r = normalise(c, i);
    if ("skip" in r) skip(r.skip);
    else if (seen.has(r.row.id)) skip("duplicate row (same request_id)");
    else {
      seen.add(r.row.id);
      if (r.row.fingerprint.basis === "content") contentHashed++;
      rows.push(r.row);
    }
  });
  rows.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  return { rows, skipped, contentHashed };
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : 0;
const time = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v; // seconds or milliseconds
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
};
const bool = (v: unknown): boolean | null =>
  typeof v === "boolean" ? v : v === "True" || v === "true" ? true : v === "False" || v === "false" ? false : null;
const GENERATIVE = /completion|chat|responses|messages|generate/i;

function normalise(c: unknown, index: number): { row: SpendRow } | { skip: string } {
  if (!c || typeof c !== "object" || Array.isArray(c)) return { skip: "not an object" };
  const o = c as Record<string, unknown>;
  const at = time(o.startTime ?? o.start_time ?? o.created_at);
  if (at === null) return { skip: "no usable startTime" };
  const meta = (o.metadata && typeof o.metadata === "object" ? o.metadata : {}) as Record<string, unknown>;
  const rawModel = str(o.model);
  const model = str(o.model_group) ?? rawModel ?? "(unknown model)";
  const status = str(o.status);
  const callType = str(o.call_type) ?? "unknown";
  const completionTokens = num(o.completion_tokens);
  const promptTokens = num(o.prompt_tokens);
  const outcome: SpendRow["outcome"] =
    status === "failure" || status === "failed" || status === "error"
      ? "error"
      : status === "success"
        ? completionTokens === 0 && GENERATIVE.test(callType)
          ? "empty"
          : "ok"
        : "unknown";
  const cacheKey = str(o.cache_key);
  const messages = o.messages;
  const hasContent = messages !== undefined && messages !== null && !(typeof messages === "object" && Object.keys(messages as object).length === 0);
  const fingerprint: SpendRow["fingerprint"] = cacheKey
    ? { value: cacheKey, basis: "cache_key" }
    : hasContent
      ? { value: createHash("sha256").update(JSON.stringify([model, messages])).digest("hex"), basis: "content" } // in memory only
      : { value: `${model}|${callType}|${promptTokens}`, basis: "shape" };
  return {
    row: {
      id: str(o.request_id) ?? str(o.litellm_call_id) ?? `row-${index + 1}`,
      at,
      end: time(o.endTime ?? o.end_time),
      model,
      rawModel,
      provider: str(o.custom_llm_provider),
      callType,
      apiKey: str(o.api_key) ?? "(none)",
      keyAlias: str(meta.user_api_key_alias),
      team: str(o.team_id) ?? str(meta.user_api_key_team_id),
      endUser: str(o.end_user) ?? str(meta.user_api_key_end_user_id),
      agent: str(o.agent_id) ?? str(o.billing_agent_id),
      session: str(o.session_id),
      spend: num(o.spend),
      promptTokens,
      completionTokens,
      totalTokens: num(o.total_tokens) || promptTokens + completionTokens,
      status,
      cacheHit: bool(o.cache_hit),
      fingerprint,
      outcome,
    },
  };
}

/**
 * Caps from a LiteLLM key or team export. Any object with a numeric `max_budget` and a `token` is a key; one with a
 * `team_id` and no `token` is a team; everything else is searched recursively, so `/key/list?return_full_object=true`
 * pages, `/key/info` answers, `/team/list` arrays (keys nested in a team included) and raw table rows all work.
 * LiteLLM stores keys as sha256 hashes and spend logs carry the hash; a raw `sk-` key in the file is hashed here and
 * never printed.
 */
export function parseBudgets(text: string): Budgets {
  const budgets: Budgets = { keys: new Map(), teams: new Map() };
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const cap = typeof o.max_budget === "number" && Number.isFinite(o.max_budget) ? o.max_budget : null;
    const token = str(o.token);
    const team = str(o.team_id);
    if (cap !== null && token) {
      budgets.keys.set(keyId(token), { cap, duration: str(o.budget_duration), alias: str(o.key_alias) ?? str(o.key_name) });
      return;
    }
    if (cap !== null && !("token" in o) && team) budgets.teams.set(team, { cap, duration: str(o.budget_duration), alias: str(o.team_alias) });
    for (const x of Object.values(o)) walk(x);
  };
  walk(JSON.parse(text));
  return budgets;
}

export function mergeBudgets(list: readonly Budgets[]): Budgets {
  return list.reduce((a, b) => ({ keys: new Map([...a.keys, ...b.keys]), teams: new Map([...a.teams, ...b.teams]) }), { keys: new Map(), teams: new Map() });
}

const keyId = (token: string) => (token.startsWith("sk-") ? createHash("sha256").update(token).digest("hex") : token);

/** LiteLLM budget_duration -> ms; null for a lifetime cap; undefined when the format is not recognised */
export function budgetPeriod(duration: string | null): number | null | undefined {
  if (duration === null) return null;
  const m = /^(\d+)(s|m|h|d|mo)$/.exec(duration.trim());
  if (!m) return undefined;
  const mult: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, mo: 30 * 86_400_000 };
  const ms = Number(m[1]) * mult[m[2]!]!;
  return ms > 0 ? ms : undefined;
}

// ───────────────────────────── detectors ─────────────────────────────

interface Found {
  finding: Finding;
  rows: SpendRow[];
}

export const money = (n: number): string => `$${n >= 100 ? Math.round(n).toLocaleString("en-US") : n >= 0.01 || n === 0 ? n.toFixed(2) : n.toFixed(4)}`;
const pct = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "0%");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const short = (s: string) => (s.length > 20 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s);
const sum = (rows: readonly SpendRow[]) => rows.reduce((a, r) => a + r.spend, 0);
const scopeOf = (r: SpendRow) => r.session ?? r.agent ?? (r.endUser ? `${r.apiKey}:${r.endUser}` : r.apiKey);
const ids = (rows: readonly SpendRow[]) => rows.slice(0, EVIDENCE_ROWS).map((r) => r.id);
function group<K>(rows: readonly SpendRow[], by: (r: SpendRow) => K | null): Map<K, SpendRow[]> {
  const m = new Map<K, SpendRow[]>();
  for (const r of rows) {
    const k = by(r);
    if (k === null) continue;
    const g = m.get(k);
    if (g) g.push(r);
    else m.set(k, [r]);
  }
  return m;
}
export function describeWindow(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000} d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${ms / 1000} s`;
}
function topScopes(rows: readonly SpendRow[], n: number): string[] {
  const by = new Map<string, number>();
  for (const r of rows) by.set(scopeOf(r), (by.get(scopeOf(r)) ?? 0) + r.spend);
  return [...by.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([s, v]) => `${short(s)}: ${money(v)}`);
}

/** 1. Repeated requests: the same fingerprint, in the same session (or agent, or key), within the window; all but the first are in question. */
function repeatedRequests(rows: SpendRow[], windowMs: number): Found[] {
  const groups = group(
    rows.filter((r) => !r.cacheHit), // a cache hit cost nothing to repeat
    (r) => `${scopeOf(r)}\u0000${r.fingerprint.value}`,
  );
  const strong: SpendRow[] = [];
  const weak: SpendRow[] = [];
  for (const g of groups.values()) {
    let first = g[0]!;
    for (const r of g.slice(1)) {
      if (r.at - first.at <= windowMs) (r.fingerprint.basis === "shape" ? weak : strong).push(r);
      else first = r;
    }
  }
  const out: Found[] = [];
  if (strong.length)
    out.push({
      rows: strong,
      finding: {
        detector: "repeated-requests",
        title: `${plural(strong.length, "repeated request")} within ${describeWindow(windowMs)} cost ${money(sum(strong))}`,
        label: "repeated request (same cache key or content, same session or key)",
        amount: sum(strong),
        count: strong.length,
        detail: `${plural(strong.length, "call")} sent a request identical to an earlier one in the same session, agent or key within ${describeWindow(windowMs)}; the repeats cost ${money(sum(strong))}`,
        nextStep: "look for a loop that re-sends the same prompt; add an idempotency key or a short cache window on the client",
        evidence: ids(strong),
        evidenceTotal: strong.length,
      },
    });
  if (weak.length)
    out.push({
      rows: weak,
      finding: {
        detector: "repeated-requests",
        title: `${plural(weak.length, "possibly repeated request")} within ${describeWindow(windowMs)} cost ${money(sum(weak))}`,
        label: "possible repeated request (same model, call type and prompt size only; the export has no cache key or content)",
        amount: sum(weak),
        count: weak.length,
        detail: `${plural(weak.length, "call")} had the same shape as an earlier call in the same session, agent or key within ${describeWindow(windowMs)}, costing ${money(sum(weak))}; not counted as avoidable until confirmed`,
        nextStep: "re-export with cache_key populated or with messages included (hashed locally, never printed), or inspect the sessions listed",
        evidence: ids(weak),
        evidenceTotal: weak.length,
      },
    });
  return out;
}

/** 2. Retry storms: at least `calls` consecutive failed or empty calls (no successful call between them) on one scope inside the storm window. */
function retryStorms(rows: SpendRow[], calls: number, windowMs: number): Found[] {
  const storms: { scope: string; rows: SpendRow[] }[] = [];
  for (const [scope, list] of group(rows, scopeOf)) {
    let run: SpendRow[] = [];
    const flush = () => {
      for (const s of stormsIn(run, calls, windowMs)) storms.push({ scope, rows: s });
      run = [];
    };
    for (const r of list) {
      if (r.outcome === "error" || r.outcome === "empty") run.push(r);
      else flush(); // a successful or unclassified call is progress, or might be
    }
    flush();
  }
  if (!storms.length) return [];
  const stormRows = storms.flatMap((s) => s.rows);
  const scopes = new Set(storms.map((s) => s.scope));
  return [
    {
      rows: stormRows,
      finding: {
        detector: "retry-storms",
        title: `${plural(storms.length, "retry storm")} on ${plural(scopes.size, "session")} cost ${money(sum(stormRows))}`,
        label: "retry storm (consecutive failed or empty calls with nothing successful between them)",
        amount: sum(stormRows),
        count: stormRows.length,
        detail: `${plural(stormRows.length, "call")} in ${plural(storms.length, "burst")} of ${calls} or more failed or empty calls within ${describeWindow(windowMs)} on one session, agent or key; these rows are part of the failed-and-empty finding, so the two amounts overlap`,
        nextStep: "cap retries per session, back off on upstream errors, and stop the run when the same error repeats",
        evidence: storms
          .slice()
          .sort((a, b) => sum(b.rows) - sum(a.rows))
          .slice(0, EVIDENCE_ROWS)
          .map((s) => `${short(s.scope)}: ${plural(s.rows.length, "call")}, ${money(sum(s.rows))}`),
        evidenceTotal: storms.length,
      },
    },
  ];
}

/** windows of at least `calls` rows within `windowMs` inside one run of failures, overlapping windows merged */
function stormsIn(run: readonly SpendRow[], calls: number, windowMs: number): SpendRow[][] {
  const ranges: [number, number][] = [];
  let start = 0;
  for (let i = 0; i < run.length; i++) {
    while (run[i]!.at - run[start]!.at > windowMs) start++;
    if (i - start + 1 >= calls) {
      const last = ranges[ranges.length - 1];
      if (last && start <= last[1]) last[1] = i;
      else ranges.push([start, i]);
    }
  }
  return ranges.map(([s, e]) => run.slice(s, e + 1));
}

/** 3. Dead spend: calls that ended in error or returned nothing. Unknown outcomes are reported, never counted as waste. */
function deadSpend(rows: SpendRow[], totals: AuditReport["totals"]): Found[] {
  const out: Found[] = [];
  const dead = rows.filter((r) => r.outcome === "error" || r.outcome === "empty");
  if (dead.length) {
    const errors = rows.filter((r) => r.outcome === "error").length;
    out.push({
      rows: dead,
      finding: {
        detector: "dead-spend",
        title: `${money(sum(dead))} on ${plural(dead.length, "failed or empty call")} (${pct(sum(dead), totals.spend)} of spend)`,
        label: "failed run or empty response (billed, nothing usable returned)",
        amount: sum(dead),
        count: dead.length,
        detail: `${plural(errors, "call")} failed (${money(totals.errorSpend)}) and ${dead.length - errors} succeeded with no completion tokens (${money(totals.emptySpend)}); the sessions and keys below carry most of it`,
        nextStep: "retried failures are the storm finding; the rest is usually a broken tool, a bad prompt or a model that is down",
        evidence: topScopes(dead, 8),
        evidenceTotal: new Set(dead.map(scopeOf)).size,
      },
    });
  }
  const unknown = rows.filter((r) => r.outcome === "unknown");
  if (unknown.length)
    out.push({
      rows: [],
      finding: {
        detector: "dead-spend",
        title: `${plural(unknown.length, "call")} with no outcome recorded (${money(sum(unknown))}, ${pct(sum(unknown), totals.spend)} of spend)`,
        label: "outcome unknown (not counted as waste)",
        amount: 0,
        count: unknown.length,
        detail: `the export carries no status for these rows, so ${money(sum(unknown))} cannot be classified either way`,
        nextStep: "re-export from a LiteLLM version that records status, or accept that this share of spend is outside the report",
        evidence: ids(unknown),
        evidenceTotal: unknown.length,
      },
    });
  return out;
}

/** 4. An expensive model answering with consistently tiny outputs: a classifier or router running on a frontier model. */
function expensiveSmallOutputs(rows: SpendRow[], threshold: number, prices?: PriceTable): Found[] {
  const out: Found[] = [];
  const byModel = group(
    rows.filter((r) => r.outcome === "ok" && !r.cacheHit),
    (r) => r.model,
  );
  for (const [model, list] of [...byModel.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (list.length < MIN_CALLS_PER_MODEL) continue;
    const completions = list.map((r) => r.completionTokens).sort((a, b) => a - b);
    const median = completions[Math.floor(completions.length / 2)]!;
    const tokens = list.reduce((a, r) => a + r.totalTokens, 0);
    const listed = listPrice(list[0]!, prices);
    const perMillion = listed !== undefined ? listed * 1e6 : tokens ? (sum(list) / tokens) * 1e6 : 0;
    if (median > SMALL_OUTPUT_TOKENS || perMillion < threshold) continue;
    out.push({
      rows: [],
      finding: {
        detector: "expensive-model-small-outputs",
        title: `${model}: ${plural(list.length, "call")} at ${money(perMillion)} per million tokens with a median answer of ${plural(median, "token")} (${money(sum(list))})`,
        label: "expensive model on small outputs (a cheaper model may do; replay real calls before switching)",
        amount: 0,
        count: list.length,
        detail: `${money(sum(list))} went to ${model} for answers of ${plural(median, "token")} or fewer in half the calls (${listed !== undefined ? "list price" : "observed blended cost"} ${money(perMillion)} per million tokens); not counted as avoidable, because quality is not in the export`,
        nextStep: "replay ten of these calls on a cheaper model and compare against your own check; switch only if they match",
        evidence: ids(list),
        evidenceTotal: list.length,
      },
    });
  }
  return out;
}

function listPrice(r: SpendRow, prices?: PriceTable): number | undefined {
  if (!prices) return undefined;
  const names = [r.rawModel, r.model, r.provider && r.rawModel ? `${r.provider}/${r.rawModel}` : null, r.provider ? `${r.provider}/${r.model}` : null];
  for (const n of names) {
    const p = n ? prices[n]?.input_cost_per_token : undefined;
    if (typeof p === "number") return p;
  }
  return undefined;
}

/**
 * 5. Allowances against real use: caps far above or at their busiest period (needs --budgets), and keys whose busiest
 * day dwarfs their typical day. `coverageMs` is the export's coverage in whole days: a cap is called slack only when the
 * export covers a full period of it.
 */
function allowanceReview(rows: SpendRow[], budgets: Budgets | undefined, coverageMs: number): Found[] {
  const out: Found[] = [];
  const byKey = group(rows, (r) => r.apiKey);
  const byTeam = group(rows, (r) => r.team);
  const slack: string[] = [];
  const tight: string[] = [];
  let notInExport = 0;
  let unreadable = 0;
  const check = (kind: "key" | "team", id: string, list: SpendRow[] | undefined, a: Allowance) => {
    if (!list) {
      notInExport++;
      return;
    }
    const name = `${kind} ${a.alias ?? (kind === "key" ? list[0]!.keyAlias : null) ?? short(id)}`;
    const period = budgetPeriod(a.duration);
    if (period === undefined) {
      unreadable++;
      return;
    }
    if (period === null) {
      if (sum(list) >= 0.9 * a.cap) tight.push(`${name}: ${money(sum(list))} spent of a ${money(a.cap)} lifetime cap`);
      return;
    }
    const busiest = maxWindow(list, period);
    if (busiest >= 0.9 * a.cap) tight.push(`${name}: busiest ${describeWindow(period)} ${money(busiest)} against a ${money(a.cap)} cap`);
    else if (coverageMs >= period && a.cap > 5 * busiest) slack.push(`${name}: cap ${money(a.cap)} per ${describeWindow(period)}, busiest ${describeWindow(period)} ${money(busiest)}`);
  };
  for (const [id, a] of budgets?.keys ?? []) check("key", id, byKey.get(id), a);
  for (const [id, a] of budgets?.teams ?? []) check("team", id, byTeam.get(id), a);
  const notes = [
    notInExport ? `${notInExport} capped keys or teams had no rows in the export and were not assessed` : "",
    unreadable ? `${plural(unreadable, "cap")} had a budget_duration this tool does not read` : "",
  ]
    .filter(Boolean)
    .join("; ");
  if (slack.length)
    out.push({
      rows: [],
      finding: {
        detector: "allowance-review",
        title: `${plural(slack.length, "cap")} more than 5× the busiest period in the export`,
        label: "budget review suggestion (a cap far above use lets one bad night spend the whole allowance)",
        amount: 0,
        count: slack.length,
        detail: `compared with the busiest window of each cap's own period inside the export${notes ? `; ${notes}` : ""}`,
        nextStep: "lower each cap toward its busiest period, with an approval path for the rare legitimate spike",
        evidence: slack.slice(0, EVIDENCE_ROWS),
        evidenceTotal: slack.length,
      },
    });
  if (tight.length)
    out.push({
      rows: [],
      finding: {
        detector: "allowance-review",
        title: `${plural(tight.length, "cap")} reached 90% of the allowance`,
        label: "budget review suggestion (a cap this close to use will stop legitimate work soon, or already has)",
        amount: 0,
        count: tight.length,
        detail: `spend in the busiest window of the cap's own period, or the whole export for a lifetime cap${notes ? `; ${notes}` : ""}`,
        nextStep: "check whether failed calls in this key or team are budget refusals before raising the cap",
        evidence: tight.slice(0, EVIDENCE_ROWS),
        evidenceTotal: tight.length,
      },
    });
  const bursty: string[] = [];
  for (const [key, list] of [...byKey.entries()].sort((a, b) => sum(b[1]) - sum(a[1]))) {
    const perDay = new Map<string, number>();
    for (const r of list) {
      const d = new Date(r.at).toISOString().slice(0, 10);
      perDay.set(d, (perDay.get(d) ?? 0) + r.spend);
    }
    const days = [...perDay.values()].sort((a, b) => a - b);
    if (days.length < 7) continue;
    const median = days[Math.floor(days.length / 2)]!;
    const busiest = days[days.length - 1]!;
    if (busiest >= 5 && busiest > 10 * median) bursty.push(`key ${list[0]!.keyAlias ?? short(key)}: busiest day ${money(busiest)}, typical day ${money(median)}`);
  }
  if (bursty.length)
    out.push({
      rows: [],
      finding: {
        detector: "allowance-review",
        title: `${plural(bursty.length, "key")} whose busiest day was over 10× the typical day`,
        label: "budget review suggestion (bursts this large are where runaway loops hide)",
        amount: 0,
        count: bursty.length,
        detail: "daily spend per key over the days the key was used; typical is the median day",
        nextStep: "look at what ran on the busiest days; a per-session cap turns the next burst into a pause instead of a bill",
        evidence: bursty.slice(0, EVIDENCE_ROWS),
        evidenceTotal: bursty.length,
      },
    });
  return out;
}

/** the most spent in any window of `period` ms (rows sorted by time) */
function maxWindow(list: readonly SpendRow[], period: number): number {
  let best = 0;
  let acc = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    acc += list[i]!.spend;
    while (list[i]!.at - list[start]!.at >= period) {
      acc -= list[start]!.spend;
      start++;
    }
    if (acc > best) best = acc;
  }
  return best;
}

// ───────────────────────────── the report ─────────────────────────────

export function audit(text: string, options: AuditOptions = {}): AuditReport {
  const opts = { ...DEFAULTS, ...options };
  const { rows, skipped, contentHashed } = parseExport(text);
  const spendOf = (outcome: SpendRow["outcome"]) => sum(rows.filter((r) => r.outcome === outcome));
  const totals: AuditReport["totals"] = { rows: rows.length, spend: sum(rows), okSpend: spendOf("ok"), errorSpend: spendOf("error"), emptySpend: spendOf("empty"), unknownSpend: spendOf("unknown") };
  const first = rows[0]?.at ?? null;
  const last = rows[rows.length - 1]?.at ?? null;
  const dayOf = (ms: number) => Math.floor(ms / 86_400_000);
  const coveredDays = first === null || last === null ? 0 : dayOf(last) - dayOf(first) + 1; // whole UTC days the export touches
  const found = [
    ...repeatedRequests(rows, opts.windowMs),
    ...retryStorms(rows, opts.stormCalls, opts.stormWindowMs),
    ...deadSpend(rows, totals),
    ...expensiveSmallOutputs(rows, opts.expensivePerMillion, opts.prices),
    ...allowanceReview(rows, opts.budgets, coveredDays * 86_400_000),
  ];
  const avoidableRows = new Set<SpendRow>();
  for (const f of found) {
    if (f.finding.detector === "dead-spend" || (f.finding.detector === "repeated-requests" && f.finding.label.startsWith("repeated request"))) for (const r of f.rows) avoidableRows.add(r);
  }
  const findings = found.map((f) => f.finding).sort((a, b) => b.amount - a.amount || b.count - a.count || a.title.localeCompare(b.title));
  const skippedCount = Object.values(skipped).reduce((a, n) => a + n, 0);
  return {
    generatedAt: (opts.now ?? new Date()).toISOString(),
    period: {
      from: first === null ? null : new Date(first).toISOString(),
      to: last === null ? null : new Date(last).toISOString(),
      days: coveredDays,
    },
    coverage: {
      rowsRead: rows.length + skippedCount,
      rowsSkipped: skippedCount,
      skippedReasons: skipped,
      unknownOutcomes: rows.filter((r) => r.outcome === "unknown").length,
      keys: new Set(rows.map((r) => r.apiKey)).size,
      sessions: new Set(rows.map((r) => r.session).filter((s) => s !== null)).size,
      agents: new Set(rows.map((r) => r.agent).filter((s) => s !== null)).size,
      models: new Set(rows.map((r) => r.model)).size,
      contentHashed,
      capsForKeys: opts.budgets?.keys.size ?? 0,
      capsForTeams: opts.budgets?.teams.size ?? 0,
    },
    totals,
    options: { windowMs: opts.windowMs, stormCalls: opts.stormCalls, stormWindowMs: opts.stormWindowMs, expensivePerMillion: opts.expensivePerMillion, smallOutputTokens: SMALL_OUTPUT_TOKENS, minCallsPerModel: MIN_CALLS_PER_MODEL },
    findings,
    avoidable: sum([...avoidableRows]),
  };
}

// ───────────────────────────── rendering ─────────────────────────────

const CLOSING = "This report reads metadata only and prints no prompts or responses. Each finding says what the export supports; the labels are the limits.";

function summaryLines(r: AuditReport): string[] {
  const c = r.coverage;
  if (!r.totals.rows) return [`SpendMarshal audit-logs: no rows found (${c.rowsSkipped} skipped: ${reasons(c.skippedReasons)}); expected a JSON array of spend-log rows, a /spend/logs/v2 page, or newline-delimited rows`];
  const caps = c.capsForKeys || c.capsForTeams ? `caps supplied for ${plural(c.capsForKeys, "key")} and ${plural(c.capsForTeams, "team")}` : "no caps supplied (pass --budgets to check allowances)";
  return [
    `SpendMarshal audit-logs: ${r.period.from!.slice(0, 10)} to ${r.period.to!.slice(0, 10)} (${plural(r.period.days, "day")}), ${plural(r.totals.rows, "row")}, ${money(r.totals.spend)} spend`,
    `coverage: ${c.rowsRead} rows read, ${c.rowsSkipped} skipped${c.rowsSkipped ? ` (${reasons(c.skippedReasons)})` : ""}; ${c.unknownOutcomes} with unknown outcome (${pct(c.unknownOutcomes, r.totals.rows)} of rows); ${plural(c.keys, "key")}, ${plural(c.sessions, "session")}, ${plural(c.agents, "agent")}, ${plural(c.models, "model")}; ${caps}`,
    `spend by outcome: ok ${money(r.totals.okSpend)}, failed ${money(r.totals.errorSpend)}, empty ${money(r.totals.emptySpend)}, unknown ${money(r.totals.unknownSpend)} (sums to ${money(r.totals.spend)})`,
    `avoidable spend in question: ${money(r.avoidable)} (${pct(r.avoidable, r.totals.spend)} of spend: failed and empty calls plus confirmed repeats, each row once; unknown outcomes and review suggestions excluded)`,
  ];
}
const reasons = (s: Record<string, number>) =>
  Object.entries(s)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ") || "none";

export function formatAuditText(r: AuditReport): string {
  const lines = [...summaryLines(r), ""];
  if (!r.findings.length && r.totals.rows) lines.push("no findings: nothing repeated, no retry storms, no failed or empty spend, no expensive small-output models, no caps to review", "");
  r.findings.forEach((f, i) => {
    lines.push(`${i + 1}. ${f.title}`, `   label: ${f.label}`, `   ${f.detail}`, `   next: ${f.nextStep}`);
    if (f.evidence.length) lines.push(`   evidence: ${f.evidence.join("; ")}${f.evidenceTotal > f.evidence.length ? ` (+${f.evidenceTotal - f.evidence.length} more)` : ""}`);
    lines.push("");
  });
  lines.push(CLOSING);
  return lines.join("\n");
}

export function formatAuditHtml(r: AuditReport): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  const items = r.findings
    .map((f, i) => {
      const more = f.evidenceTotal > f.evidence.length ? ` (+${f.evidenceTotal - f.evidence.length} more)` : "";
      const evidence = f.evidence.length ? `<br><code>${esc(f.evidence.join("; "))}${more}</code>` : "";
      return `<li><strong>${i + 1}. ${esc(f.title)}</strong><br><em>${esc(f.label)}</em><br>${esc(f.detail)}<br>Next: ${esc(f.nextStep)}${evidence}</li>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SpendMarshal audit-logs report</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:860px;margin:32px auto;padding:0 16px;color:#1d1f21;background:#fff}pre{white-space:pre-wrap;background:#f6f5f1;padding:12px;border-radius:8px}li{margin:12px 0}code{font-size:14px}</style></head>
<body><h1>SpendMarshal audit-logs report</h1><pre>${esc(summaryLines(r).join("\n"))}</pre>${items ? `<ol>${items}</ol>` : "<p>No findings.</p>"}<p>${esc(CLOSING)}</p><p><small>generated ${esc(r.generatedAt)}</small></p></body></html>
`;
}

/** `--window` and `--storm-window` values: `10m`, `90s`, `1h`, `2d` */
export function parseWindow(s: string): number {
  return parseDuration(s);
}
