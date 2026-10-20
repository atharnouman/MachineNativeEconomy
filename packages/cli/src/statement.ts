import { receiptSigner, type EvidenceBundle, type Receipt, type VerifyReport } from "@spendmarshal/core";

/**
 * A per-client month-end statement, computed from an evidence bundle and nothing else: what was settled, by which
 * agent, to which payee, under which policy version, who approved what, what was refused, and (when the provider's
 * figure is given) how the two totals reconcile. Every number comes from a receipt; nothing is estimated. The statement
 * names the keys and the chain head so the client can verify the bundle offline with `spendmarshal verify`.
 */

export interface Period {
  from: string; // inclusive instant (RFC 3339)
  to: string; // exclusive instant
  label: string;
}

export interface StatementOptions {
  period?: Period;
  /** The provider's figure for the period, in human units of the statement currency (for example "0.18"). */
  providerTotal?: string;
  /** Restrict the reconciliation to one payee: the address or the exact payee string the receipts record. */
  payee?: string;
  /** Settlements this many days before or after the period count as boundary items (default 2). */
  boundaryDays?: number;
  sourceName?: string;
  sourceSha256?: string;
  /** The offline verification the CLI ran; null when it was skipped. */
  verification?: VerifyReport | null;
  generatedAt?: string;
}

export interface Line {
  key: string;
  count: number;
  total: string;
  detail?: string;
}

export interface ApprovalRow {
  id: string;
  at: string;
  outcome: "granted" | "rejected" | "expired" | "pending";
  amount: string | null;
  approver: { id: string; method: string; address: string | null } | null;
  payee: string | null;
  resource: string | null;
  policyVersion: number | null;
  consumed: boolean;
}

export interface Mandate {
  credentialId: string;
  agentId: string;
  delegatedBy: string | null;
  spendCap: string | null;
  perPaymentMax: string | null;
  expiresAt: string | null;
  payees: number | null;
  purposes: string[] | null;
  rails: string[] | null;
}

export interface UnsettledItem {
  intentId: string;
  at: string;
  agentId: string | null;
  amount: string | null;
  payee: string | null;
}

export type ComponentKey = "subscriptions" | "boundary" | "unsettled";

export interface Reconciliation {
  payee: string | null;
  statementCount: number;
  statementTotal: string;
  providerTotal: string;
  /** provider total minus statement total */
  difference: string;
  components: Array<{ key: ComponentKey; direction: "add" | "subtract"; count: number; total: string; text: string }>;
  verdict: "matches" | "explained" | "unexplained";
  explainedBy: ComponentKey[];
  remainder: string;
}

export interface Statement {
  generatedAt: string;
  client: string;
  period: Period & { given: boolean };
  currency: { asset: string; decimals: number };
  source: { name: string | null; sha256: string | null; exportedAt: string; receipts: number; inPeriod: number; chainHead: string | null; firstReceiptAt: string | null; lastReceiptAt: string | null };
  keys: { gateway: string; evidence: string | null; signed: string[] };
  anchor: { head: string; count: number; txHash: string; blockNumber: string; registry: string; party: string | null; coversPeriod: boolean } | null;
  verification: { ok: boolean; passed: number; total: number; failed: string[] } | null;
  settled: { count: number; total: string; byRail: Line[]; byAgent: Line[]; byPayee: Line[]; subscriptions: { count: number; total: string; ids: string[] } };
  approvals: ApprovalRow[];
  denials: Line[];
  notSettled: { count: number; total: string; items: UnsettledItem[] };
  reclaimed: { count: number; total: string };
  policyVersions: Array<{ version: number; activatedAt: string; activatedBy: string | null; hash: string }>;
  mandates: Mandate[];
  events: Array<{ at: string; text: string }>;
  reconciliation: Reconciliation | null;
  notes: string[];
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY = 86_400_000;

/** `--period`: `2026-10` (a calendar month, UTC) or `2026-10-01/2026-10-31` (both days inclusive, UTC). */
export function parsePeriod(s: string): Period {
  let m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) throw new Error(`--period ${s}: month must be 01 to 12`);
    return { from: new Date(Date.UTC(y, mo - 1, 1)).toISOString(), to: new Date(Date.UTC(y, mo, 1)).toISOString(), label: `${MONTHS[mo - 1]} ${y}` };
  }
  m = /^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (m) {
    const from = Date.parse(`${m[1]}T00:00:00Z`);
    const to = Date.parse(`${m[2]}T00:00:00Z`) + DAY;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error(`--period ${s}: not a valid date range`);
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), label: `${m[1]} to ${m[2]}` };
  }
  throw new Error("--period must be YYYY-MM or YYYY-MM-DD/YYYY-MM-DD (UTC)");
}

/** A human amount (`0.18`, `12`, `0.000001`) to base units, exactly; more decimals than the currency has is an error. */
export function parseAmount(s: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`${s}: not an amount`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`${s}: not an amount with at most ${decimals} decimals`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + (frac ? BigInt(frac.padEnd(decimals, "0")) : 0n);
}

/** Exact fixed-point rendering of base units: no rounding, every decimal place shown. */
export function human(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals);
  return `${neg ? "-" : ""}${int}${decimals ? `.${s.slice(s.length - decimals)}` : ""}`;
}

const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);
const base = (v: unknown): bigint | null => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : typeof v === "number" && Number.isInteger(v) && v >= 0 ? BigInt(v) : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const ms = (ts: string) => Date.parse(ts);

interface Money {
  count: number;
  total: bigint;
}
const add = (m: Money, v: bigint | null) => {
  m.count++;
  if (v !== null) m.total += v;
};
function tally<T extends Money>(map: Map<string, T>, key: string, make: () => T): T {
  let m = map.get(key);
  if (!m) {
    m = make();
    map.set(key, m);
  }
  return m;
}

export function buildStatement(bundle: EvidenceBundle, opts: StatementOptions = {}): Statement {
  const receipts = bundle.receipts;
  const currency = { asset: bundle.policy.document.currency?.asset ?? "USDC", decimals: bundle.policy.document.currency?.decimals ?? 6 };
  const money = (v: bigint) => human(v, currency.decimals);
  const notes: string[] = [];

  const first = receipts[0] ?? null;
  const last = receipts[receipts.length - 1] ?? null;
  const period: Statement["period"] = opts.period
    ? { ...opts.period, given: true }
    : { from: first ? first.ts : new Date(0).toISOString(), to: last ? new Date(ms(last.ts) + 1).toISOString() : new Date(0).toISOString(), label: "the whole record", given: false };
  if (!opts.period) notes.push("No period was given: the statement covers every receipt in the bundle.");
  const inPeriod = (r: Receipt) => ms(r.ts) >= ms(period.from) && ms(r.ts) < ms(period.to);
  const periodReceipts = receipts.filter(inPeriod);

  // policy versions, and the version in force at a time
  const versions = [...bundle.policyVersions].sort((a, b) => a.version - b.version);
  const versionAt = (ts: string): number | null => {
    let v: number | null = null;
    for (const p of versions) if (ms(p.activatedAt) <= ms(ts)) v = p.version;
    return v;
  };
  const policyVersions = versions
    .filter((p, i) => {
      const next = versions[i + 1];
      return ms(p.activatedAt) < ms(period.to) && (!next || ms(next.activatedAt) > ms(period.from));
    })
    .map((p) => ({ version: p.version, activatedAt: p.activatedAt, activatedBy: p.activatedBy ?? null, hash: p.hash }));

  // settlements
  const settledAll = receipts.filter((r) => r.kind === "payment.settled");
  const settledIntents = new Set(settledAll.map((r) => r.intentId).filter((x): x is string => !!x));
  const settled = settledAll.filter(inPeriod);
  const total: Money = { count: 0, total: 0n };
  const byRail = new Map<string, Money>();
  const byAgent = new Map<string, Money>();
  const byPayee = new Map<string, Money & { resources: Set<string>; lightning: boolean }>();
  const subs: Money & { ids: Set<string> } = { count: 0, total: 0n, ids: new Set() };
  let unreadable = 0;
  for (const r of settled) {
    const amount = base(r.data.amount);
    if (amount === null) unreadable++;
    add(total, amount);
    add(tally(byRail, r.rail ?? "unknown rail", () => ({ count: 0, total: 0n })), amount);
    add(tally(byAgent, r.agentId ?? "(no agent recorded)", () => ({ count: 0, total: 0n })), amount);
    const p = tally(byPayee, str(r.data.payee) ?? "(no payee recorded)", () => ({ count: 0, total: 0n, resources: new Set<string>(), lightning: false }));
    add(p, amount);
    const resource = str(r.data.resource);
    if (resource) p.resources.add(resource.split("?")[0]!);
    if (obj(r.data.lightning)) p.lightning = true;
    const sub = str(r.data.subscriptionId);
    if (sub) {
      add(subs, amount);
      subs.ids.add(sub);
    }
  }
  if (unreadable) notes.push(`${unreadable} settlement receipt(s) carry no readable amount; they are counted but add nothing to the totals.`);
  const lines = (m: Map<string, Money>, detail?: (k: string) => string | undefined): Line[] =>
    [...m.entries()]
      .sort((a, b) => (a[1].total === b[1].total ? b[1].count - a[1].count : a[1].total > b[1].total ? -1 : 1))
      .map(([key, v]) => {
        const d = detail?.(key);
        return d ? { key, count: v.count, total: money(v.total), detail: d } : { key, count: v.count, total: money(v.total) };
      });

  // approvals touched in the period
  const consumedIds = new Set(receipts.filter((r) => r.kind === "approval.consumed").map((r) => r.approvalId).filter((x): x is string => !!x));
  const approvals = new Map<string, ApprovalRow>();
  for (const r of periodReceipts) {
    if (!r.kind.startsWith("approval.") || r.kind === "approval.consumed" || !r.approvalId) continue;
    const a = obj(r.data.approval);
    const approver = obj(r.data.approver) ?? obj(a?.approver);
    const payee = obj(a?.payee);
    const amount = base(a?.amount);
    const row: ApprovalRow = {
      id: r.approvalId,
      at: r.ts,
      outcome: r.kind === "approval.granted" ? "granted" : r.kind === "approval.rejected" ? "rejected" : r.kind === "approval.expired" ? "expired" : "pending",
      amount: amount === null ? null : money(amount),
      approver: approver && str(approver.id) ? { id: str(approver.id)!, method: str(approver.method) ?? "unknown", address: str(approver.address) } : null,
      payee: str(payee?.host) ?? str(payee?.address) ?? null,
      resource: str(a?.resource),
      policyVersion: versionAt(r.ts),
      consumed: consumedIds.has(r.approvalId),
    };
    const prev = approvals.get(r.approvalId);
    // a resolution replaces the request, and a later resolution an earlier one
    if (!prev || row.outcome !== "pending") approvals.set(r.approvalId, { ...row, approver: row.approver ?? prev?.approver ?? null });
  }

  // denials by reason
  const denied = new Map<string, Money & { known: number }>();
  const deniedIntents = new Map<string, number>();
  for (const r of receipts) if ((r.kind === "payment.denied" || r.kind === "onchain.denied") && r.intentId) deniedIntents.set(r.intentId, ms(r.ts));
  for (const r of periodReceipts) {
    if (r.kind !== "payment.denied" && r.kind !== "onchain.denied") continue;
    const reasons = Array.isArray(r.data.reasons) ? r.data.reasons.filter((x): x is string => typeof x === "string") : [];
    const reason = r.kind === "onchain.denied" ? `account contract rejected: ${str(r.data.reason) ?? "no reason recorded"}` : (str(r.data.reason) ?? (reasons.length ? reasons.join(", ") : "no reason recorded"));
    const d = tally(denied, reason, () => ({ count: 0, total: 0n, known: 0 }));
    const amount = base(r.data.amount);
    add(d, amount);
    if (amount !== null) d.known++;
  }
  const denials: Line[] = [...denied.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([key, v]) => (v.known === v.count ? { key, count: v.count, total: money(v.total) } : { key, count: v.count, total: money(v.total), detail: v.known ? `amount recorded for ${v.known} of ${v.count}` : "amount not recorded" }));

  // allowed at the quote or charge stage, never settled, not denied afterwards
  const unsettledRaw: Array<UnsettledItem & { value: bigint | null }> = [];
  const seenIntent = new Set<string>();
  for (const r of periodReceipts) {
    if (r.kind !== "decision" || r.data.effect !== "allow" || !r.intentId) continue;
    const stage = str(r.data.stage);
    if (stage === "precheck" || stage === "simulate" || stage === "structural") continue;
    if (settledIntents.has(r.intentId) || seenIntent.has(r.intentId)) continue;
    const deniedAt = deniedIntents.get(r.intentId);
    if (deniedAt !== undefined && deniedAt >= ms(r.ts)) continue;
    seenIntent.add(r.intentId);
    const value = base(r.data.amount);
    unsettledRaw.push({ intentId: r.intentId, at: r.ts, agentId: r.agentId ?? null, amount: value === null ? null : money(value), payee: str(obj(r.data.quote)?.payTo), value });
  }
  const unsettledMoney: Money = { count: 0, total: 0n };
  for (const u of unsettledRaw) add(unsettledMoney, u.value);

  // reclaimed pre-approvals
  const reclaimed: Money = { count: 0, total: 0n };
  for (const r of periodReceipts) if (r.kind === "preapproval.reclaimed") add(reclaimed, base(r.data.value) ?? base(r.data.amount));

  // mandates: the public view of every credential
  const byId = new Map(bundle.credentials.map((c) => [c.id, c]));
  const mandates: Mandate[] = bundle.credentials.map((c) => {
    const find = (type: string) => c.caveats.find((v) => v.type === type) as Record<string, unknown> | undefined;
    const list = (type: string): string[] | null => {
      const v = find(type)?.value;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
    };
    const amountOf = (type: string) => {
      const v = base(find(type)?.value);
      return v === null ? null : money(v);
    };
    return {
      credentialId: c.id,
      agentId: c.agentId,
      delegatedBy: c.parentId ? (byId.get(c.parentId)?.agentId ?? c.parentId) : null,
      spendCap: amountOf("spend_cap"),
      perPaymentMax: amountOf("per_tx_max"),
      expiresAt: str(find("expires_at")?.value),
      payees: list("allowed_payees")?.length ?? null,
      purposes: list("purposes"),
      rails: list("allowed_rails"),
    };
  });

  // events worth a line
  const events: Statement["events"] = [];
  for (const r of periodReceipts) {
    const d = r.data;
    if (r.kind === "killswitch") events.push({ at: r.ts, text: `kill switch ${d.on === true ? "ON" : "off"}${str(d.reason) ? `: ${str(d.reason)}` : ""}` });
    else if (r.kind === "policy.updated") events.push({ at: r.ts, text: `policy version ${typeof d.version === "number" ? d.version : "?"} activated${str(d.activatedBy) ? ` by ${str(d.activatedBy)}` : ""}` });
    else if (r.kind === "approver.registered") events.push({ at: r.ts, text: `approver ${str(d.approverId) ?? "?"} key ${str(d.prevAddress) ? "rotated to" : "registered:"} ${short(str(d.address) ?? "?")}` });
    else if (r.kind === "approver.removed") events.push({ at: r.ts, text: `approver ${str(d.approverId) ?? "?"} removed` });
    else if (r.kind === "gateway.key.rotated") events.push({ at: r.ts, text: `gateway key rotated ${short(str(d.prevAddress) ?? "?")} to ${short(str(d.address) ?? "?")}${d.handover ? " with handover" : " without handover"}` });
    else if (r.kind === "evidence.anchored") events.push({ at: r.ts, text: `chain anchored on-chain: ${typeof d.count === "number" ? d.count : "?"} receipts, head ${short(str(d.head) ?? "?")}, block ${str(d.blockNumber) ?? "?"}` });
    else if (r.kind === "subscription.created") events.push({ at: r.ts, text: `subscription ${r.subscriptionId ?? "?"} created${r.agentId ? ` by ${r.agentId}` : ""}` });
    else if (r.kind === "subscription.cancelled") events.push({ at: r.ts, text: `subscription ${r.subscriptionId ?? "?"} cancelled` });
  }

  // keys, head, anchor
  let evidence: string | null = null;
  if (last) {
    try {
      evidence = receiptSigner(last);
    } catch {
      evidence = null;
    }
  }
  const signed = [...new Set([bundle.gateway.address, ...bundle.gatewayKeyHistory.flatMap((h) => [h.prevAddress, h.address])].map((a) => a.toLowerCase()))];
  const lastInPeriodIndex = receipts.reduce((idx, r, i) => (inPeriod(r) ? i : idx), -1);
  const top = [...bundle.anchors].sort((a, b) => b.count - a.count)[0];
  const anchor = top ? { head: top.head, count: top.count, txHash: top.txHash, blockNumber: top.blockNumber, registry: top.registry, party: top.party ?? null, coversPeriod: lastInPeriodIndex >= 0 && top.count - 1 >= lastInPeriodIndex } : null;
  if (!anchor) notes.push("The chain has no on-chain anchor: every receipt rests on the gateway's signature alone.");
  else if (!anchor.coversPeriod) notes.push("The last anchor does not cover the end of this period: receipts after it rest on the gateway's signature alone.");

  const verification =
    opts.verification === undefined || opts.verification === null
      ? null
      : { ok: opts.verification.ok, passed: opts.verification.checks.filter((c) => c.ok).length, total: opts.verification.checks.length, failed: opts.verification.checks.filter((c) => !c.ok).map((c) => c.check) };
  if (verification === null) notes.push("The bundle was not verified before this statement was produced.");
  else if (!verification.ok) notes.push(`NOT VERIFIED: the bundle failed ${verification.failed.join(", ")}. Treat every figure here as unconfirmed.`);

  const reconciliation = opts.providerTotal === undefined ? null : reconcile(settledAll, unsettledRaw, period, opts, currency.decimals, money, notes);

  notes.push(`Amounts are in ${currency.asset} with ${currency.decimals} decimals, exactly as the receipts record them; nothing is rounded or estimated.`);
  notes.push("Only what the bundle records appears here. Anyone holding the bundle can recompute this statement and verify the chain offline.");

  return {
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    client: bundle.principalId,
    period,
    currency,
    source: { name: opts.sourceName ?? null, sha256: opts.sourceSha256 ?? null, exportedAt: bundle.exportedAt, receipts: receipts.length, inPeriod: periodReceipts.length, chainHead: last?.hash ?? null, firstReceiptAt: first?.ts ?? null, lastReceiptAt: last?.ts ?? null },
    keys: { gateway: bundle.gateway.address, evidence, signed },
    anchor,
    verification,
    settled: {
      count: total.count,
      total: money(total.total),
      byRail: lines(byRail),
      byAgent: lines(byAgent),
      byPayee: lines(byPayee, (k) => {
        const p = byPayee.get(k)!;
        const parts = [...p.resources].sort();
        if (p.lightning) parts.push("lightning");
        return parts.length ? parts.join(", ") : undefined;
      }),
      subscriptions: { count: subs.count, total: money(subs.total), ids: [...subs.ids] },
    },
    approvals: [...approvals.values()],
    denials,
    notSettled: { count: unsettledMoney.count, total: money(unsettledMoney.total), items: unsettledRaw.map(({ value: _v, ...item }) => item) },
    reclaimed: { count: reclaimed.count, total: money(reclaimed.total) },
    policyVersions,
    mandates,
    events,
    reconciliation,
    notes,
  };
}

function reconcile(
  settledAll: Receipt[],
  unsettled: ReadonlyArray<UnsettledItem & { value: bigint | null }>,
  period: Period,
  opts: StatementOptions,
  decimals: number,
  money: (v: bigint) => string,
  notes: string[],
): Reconciliation {
  let provider: bigint;
  try {
    provider = parseAmount(opts.providerTotal!, decimals);
  } catch (e) {
    throw new Error(`--provider-total ${(e as Error).message}`);
  }
  const wanted = opts.payee?.toLowerCase() ?? null;
  const forPayee = (payee: string | null) => wanted === null || (payee ?? "").toLowerCase() === wanted;
  const inPeriod = (r: Receipt) => ms(r.ts) >= ms(period.from) && ms(r.ts) < ms(period.to);
  const statement: Money = { count: 0, total: 0n };
  const subscriptions: Money = { count: 0, total: 0n };
  const boundary: Money = { count: 0, total: 0n };
  const days = opts.boundaryDays ?? 2;
  const before = ms(period.from) - days * DAY;
  const after = ms(period.to) + days * DAY;
  for (const r of settledAll) {
    if (!forPayee(str(r.data.payee))) continue;
    const amount = base(r.data.amount);
    if (inPeriod(r)) {
      add(statement, amount);
      if (str(r.data.subscriptionId)) add(subscriptions, amount);
    } else if (days > 0 && ms(r.ts) >= before && ms(r.ts) < after) add(boundary, amount);
  }
  const notSettled: Money = { count: 0, total: 0n };
  for (const u of unsettled) if (forPayee(u.payee)) add(notSettled, u.value);

  const components: Reconciliation["components"] = [];
  const push = (key: ComponentKey, direction: "add" | "subtract", m: Money, text: string) => {
    if (m.count) components.push({ key, direction, count: m.count, total: money(m.total), text });
  };
  push("subscriptions", "subtract", subscriptions, "subscription charges, which a provider may invoice separately");
  push("boundary", "add", boundary, `settlements within ${days} day(s) before or after the period, which a provider may bill in this period`);
  push("unsettled", "add", notSettled, "payments allowed but never settled, which a provider may have delivered and billed anyway");

  const difference = provider - statement.total;
  let verdict: Reconciliation["verdict"] = difference === 0n ? "matches" : "unexplained";
  let explainedBy: ComponentKey[] = [];
  if (difference !== 0n) {
    const signed = components.map((c) => ({ key: c.key, value: (c.direction === "add" ? 1n : -1n) * parseAmount(c.total, decimals) }));
    for (let mask = 1; mask < 1 << signed.length && verdict === "unexplained"; mask++) {
      const chosen = signed.filter((_, i) => mask & (1 << i));
      if (chosen.reduce((s, c) => s + c.value, 0n) === difference) {
        verdict = "explained";
        explainedBy = chosen.map((c) => c.key);
      }
    }
  }
  if (verdict === "unexplained") notes.push(`The provider total differs from the statement by ${money(difference)} and the record does not account for it; the items under reconciliation are the places to look.`);
  return {
    payee: opts.payee ?? null,
    statementCount: statement.count,
    statementTotal: money(statement.total),
    providerTotal: money(provider),
    difference: money(difference),
    components,
    verdict,
    explainedBy,
    remainder: verdict === "unexplained" ? money(difference) : money(0n),
  };
}

// ───────────────────────────── rendering ─────────────────────────────

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function headerLines(s: Statement): string[] {
  const c = s.currency.asset;
  const v = s.verification;
  const out = [
    `SpendMarshal statement for ${s.client}: ${s.period.label}`,
    `period ${s.period.from} to ${s.period.to} (end exclusive); generated ${s.generatedAt}${s.source.name ? ` from ${s.source.name}` : ""}`,
    `record: ${plural(s.source.receipts, "receipt")} (${s.source.inPeriod} in the period), ${s.source.firstReceiptAt ?? "none"} to ${s.source.lastReceiptAt ?? "none"}, exported ${s.source.exportedAt}; chain head ${s.source.chainHead ? short(s.source.chainHead) : "none"}`,
    v === null ? "verification: not run" : v.ok ? `verification: ${v.passed}/${v.total} checks passed (offline)` : `verification: FAILED ${v.failed.join(", ")} (${v.passed}/${v.total} passed)`,
    `keys: gateway ${short(s.keys.gateway)}; last receipt signed by ${s.keys.evidence ? short(s.keys.evidence) : "unknown"}; every key that signed this chain: ${s.keys.signed.map(short).join(", ")}`,
    s.anchor
      ? `anchor: head ${short(s.anchor.head)} covering ${plural(s.anchor.count, "receipt")}, tx ${short(s.anchor.txHash)} at block ${s.anchor.blockNumber} (registry ${short(s.anchor.registry)}); ${s.anchor.coversPeriod ? "covers every receipt in this period" : "does not cover the end of this period"}`
      : "anchor: none",
    `currency: ${c}, ${s.currency.decimals} decimals`,
  ];
  return out;
}

const lineText = (l: Line, unit: string, word: string) => `${l.key}: ${plural(l.count, word)}, ${l.total} ${unit}${l.detail ? ` (${l.detail})` : ""}`;

export function formatStatementText(s: Statement): string {
  const u = s.currency.asset;
  const L: string[] = [...headerLines(s), ""];
  L.push(`SETTLED: ${plural(s.settled.count, "payment")}, ${s.settled.total} ${u}`);
  if (s.settled.count) {
    L.push(`  by rail: ${s.settled.byRail.map((l) => lineText(l, u, "payment")).join("; ")}`);
    L.push(`  by agent: ${s.settled.byAgent.map((l) => lineText(l, u, "payment")).join("; ")}`);
    L.push(`  by payee: ${s.settled.byPayee.map((l) => lineText({ ...l, key: short(l.key) }, u, "payment")).join("; ")}`);
    L.push(`  of which subscription charges: ${plural(s.settled.subscriptions.count, "charge")}, ${s.settled.subscriptions.total} ${u}${s.settled.subscriptions.ids.length ? ` (${s.settled.subscriptions.ids.map(short).join(", ")})` : ""}`);
  }
  L.push("");
  L.push(`APPROVALS: ${s.approvals.length}`);
  for (const a of s.approvals) {
    const who = a.approver ? ` by ${a.approver.id} (${a.approver.method}${a.approver.address ? `, ${short(a.approver.address)}` : ""})` : "";
    L.push(`  ${short(a.id)} ${a.outcome} ${a.at}${who} for ${a.amount ? `${a.amount} ${u}` : "an unrecorded amount"}${a.payee ? ` to ${a.payee}` : ""}${a.resource ? ` ${a.resource}` : ""}${a.policyVersion !== null ? `, policy v${a.policyVersion}` : ""}${a.consumed ? ", consumed" : ""}`);
  }
  L.push("");
  L.push(`DENIED: ${plural(s.denials.reduce((n, d) => n + d.count, 0), "attempt")}`);
  for (const d of s.denials) L.push(`  ${d.detail === "amount not recorded" ? `${d.key}: ${plural(d.count, "attempt")} (amount not recorded)` : lineText(d, u, "attempt")}`);
  L.push("");
  L.push(`ALLOWED BUT NOT SETTLED: ${s.notSettled.count ? `${plural(s.notSettled.count, "payment")}, ${s.notSettled.total} ${u}` : "none"}`);
  for (const i of s.notSettled.items) L.push(`  ${i.intentId} ${i.at}${i.agentId ? ` ${i.agentId}` : ""} ${i.amount ? `${i.amount} ${u}` : "amount not recorded"}${i.payee ? ` to ${short(i.payee)}` : ""}`);
  L.push(`RECLAIMED PRE-APPROVALS: ${s.reclaimed.count ? `${s.reclaimed.count}, ${s.reclaimed.total} ${u} restored` : "none"}`);
  L.push("");
  L.push(`POLICY: ${s.policyVersions.length ? s.policyVersions.map((p) => `v${p.version} from ${p.activatedAt}${p.activatedBy ? ` (${p.activatedBy})` : ""} ${short(p.hash)}`).join("; ") : "no version history in the bundle"}`);
  L.push(s.mandates.length ? "MANDATES:" : "MANDATES: none recorded");
  for (const m of s.mandates) {
    L.push(
      `  ${m.agentId}${m.delegatedBy ? ` (delegated by ${m.delegatedBy})` : ""}: cap ${m.spendCap ? `${m.spendCap} ${u}` : "none"}, per payment ${m.perPaymentMax ? `${m.perPaymentMax} ${u}` : "none"}, ${m.payees === null ? "any payee" : plural(m.payees, "payee")}, purposes ${m.purposes?.join("/") ?? "any"}, rails ${m.rails?.join("/") ?? "any"}, until ${m.expiresAt ?? "no expiry"} [${short(m.credentialId)}]`,
    );
  }
  L.push(s.events.length ? "EVENTS:" : "EVENTS: none");
  for (const e of s.events) L.push(`  ${e.at} ${e.text}`);
  L.push("");
  const r = s.reconciliation;
  if (r) {
    L.push(`RECONCILIATION against the provider total${r.payee ? ` for payee ${short(r.payee)}` : ""}`);
    L.push(`  settled in the period${r.payee ? " to this payee" : ""}: ${plural(r.statementCount, "payment")}, ${r.statementTotal} ${u}`);
    L.push(`  provider total given: ${r.providerTotal} ${u}`);
    L.push(`  difference (provider minus statement): ${r.difference} ${u}`);
    L.push(`  verdict: ${reconciliationVerdict(r, u)}`);
    for (const c of r.components) L.push(`  item to check: ${c.key}, ${c.count}, ${c.direction === "add" ? "+" : "-"}${c.total} ${u}: ${c.text}`);
    L.push("");
  }
  L.push(`VERIFY: spendmarshal verify ${s.source.name ?? "<bundle.json>"}${s.keys.signed.map((k) => ` --gateway-key ${k}`).join("")}${s.source.sha256 ? `; SHA-256 of the file as received: ${s.source.sha256}` : ""}`);
  for (const n of s.notes) L.push(n);
  return L.join("\n");
}

function reconciliationVerdict(r: Reconciliation, u: string): string {
  if (r.verdict === "matches") return "the provider total matches the statement";
  if (r.verdict === "explained") {
    const parts = r.explainedBy.map((k) => {
      const c = r.components.find((x) => x.key === k)!;
      return `${c.direction === "add" ? "plus" : "minus"} ${c.key} (${c.count}, ${c.total} ${u})`;
    });
    return `the difference equals ${parts.join(" ")}; confirm with the provider that its figure treats these that way`;
  }
  return `unexplained: ${r.remainder} ${u} is not accounted for by the record`;
}

export function formatStatementHtml(s: Statement): string {
  const esc = (x: string) => x.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  const u = esc(s.currency.asset);
  const table = (head: string[], rows: string[][]) =>
    rows.length ? `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>` : "<p>none</p>";
  const lineRows = (ls: Line[]) => ls.map((l) => [l.key, String(l.count), l.detail === "amount not recorded" ? "not recorded" : `${l.total} ${s.currency.asset}`, l.detail === "amount not recorded" ? "" : (l.detail ?? "")]);
  const v = s.verification;
  const banner = v === null ? `<p class="warn">Not verified before this statement was produced.</p>` : v.ok ? `<p class="ok">Verified offline: ${v.passed} of ${v.total} checks passed.</p>` : `<p class="bad">NOT VERIFIED: failed ${esc(v.failed.join(", "))} (${v.passed} of ${v.total} passed). Treat every figure as unconfirmed.</p>`;
  const r = s.reconciliation;
  const reconciliation = r
    ? `<h2>Reconciliation${r.payee ? ` for payee ${esc(short(r.payee))}` : ""}</h2>
<table><tbody>
<tr><th>Settled in the period${r.payee ? " to this payee" : ""}</th><td>${r.statementCount} payments, ${esc(r.statementTotal)} ${u}</td></tr>
<tr><th>Provider total given</th><td>${esc(r.providerTotal)} ${u}</td></tr>
<tr><th>Difference (provider minus statement)</th><td>${esc(r.difference)} ${u}</td></tr>
<tr><th>Verdict</th><td>${esc(reconciliationVerdict(r, s.currency.asset))}</td></tr>
</tbody></table>
${r.components.length ? `<p>Items to check:</p>${table(["item", "count", "amount", "why it may differ"], r.components.map((c) => [c.key, String(c.count), `${c.direction === "add" ? "+" : "-"}${c.total} ${s.currency.asset}`, c.text]))}` : ""}`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Statement for ${esc(s.client)}: ${esc(s.period.label)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:900px;margin:32px auto;padding:0 16px;color:#1d1f21;background:#fff}h1{font-size:22px}h2{font-size:17px;margin-top:28px}table{border-collapse:collapse;width:100%;margin:8px 0}th,td{text-align:left;vertical-align:top;padding:6px 8px;border-bottom:1px solid #e4e2dc;font-size:14px}th{font-weight:600;background:#f6f5f1}pre{white-space:pre-wrap;background:#f6f5f1;padding:12px;border-radius:8px;font-size:13px}.ok{color:#1b6b2e}.bad{color:#9b1c1c;font-weight:600}.warn{color:#8a5a00}.notes{font-size:13px;color:#4a4d50}code{font-size:13px}</style></head>
<body>
<h1>Statement for ${esc(s.client)}: ${esc(s.period.label)}</h1>
<pre>${esc(headerLines(s).slice(1).join("\n"))}</pre>
${banner}
<h2>Settled: ${s.settled.count} payments, ${esc(s.settled.total)} ${u}</h2>
<h3>By agent</h3>${table(["agent", "payments", "amount", ""], lineRows(s.settled.byAgent))}
<h3>By payee</h3>${table(["payee", "payments", "amount", "resources"], lineRows(s.settled.byPayee))}
<h3>By rail</h3>${table(["rail", "payments", "amount", ""], lineRows(s.settled.byRail))}
<p>Of which subscription charges: ${s.settled.subscriptions.count}, ${esc(s.settled.subscriptions.total)} ${u}${s.settled.subscriptions.ids.length ? ` (${esc(s.settled.subscriptions.ids.join(", "))})` : ""}.</p>
<h2>Approvals: ${s.approvals.length}</h2>
${table(
  ["approval", "outcome", "when", "approver", "amount", "payee and resource", "policy", "consumed"],
  s.approvals.map((a) => [a.id, a.outcome, a.at, a.approver ? `${a.approver.id} (${a.approver.method}${a.approver.address ? `, ${a.approver.address}` : ""})` : "", a.amount ? `${a.amount} ${s.currency.asset}` : "not recorded", [a.payee, a.resource].filter(Boolean).join(" "), a.policyVersion !== null ? `v${a.policyVersion}` : "", a.consumed ? "yes" : "no"]),
)}
<h2>Denied: ${s.denials.reduce((n, d) => n + d.count, 0)} attempts</h2>
${table(["reason", "attempts", "amount", ""], lineRows(s.denials))}
<h2>Allowed but not settled: ${s.notSettled.count ? `${s.notSettled.count}, ${esc(s.notSettled.total)} ${u}` : "none"}</h2>
${s.notSettled.items.length ? table(["intent", "when", "agent", "amount", "payee"], s.notSettled.items.map((i) => [i.intentId, i.at, i.agentId ?? "", i.amount ? `${i.amount} ${s.currency.asset}` : "not recorded", i.payee ?? ""])) : ""}
<p>Reclaimed pre-approvals: ${s.reclaimed.count ? `${s.reclaimed.count}, ${esc(s.reclaimed.total)} ${u} restored` : "none"}.</p>
<h2>Policy and mandates</h2>
${table(["policy version", "in force from", "activated by", "hash"], s.policyVersions.map((p) => [`v${p.version}`, p.activatedAt, p.activatedBy ?? "", p.hash]))}
${table(
  ["agent", "delegated by", "spend cap", "per payment", "payees", "purposes", "rails", "until", "credential"],
  s.mandates.map((m) => [m.agentId, m.delegatedBy ?? "", m.spendCap ? `${m.spendCap} ${s.currency.asset}` : "none", m.perPaymentMax ? `${m.perPaymentMax} ${s.currency.asset}` : "none", m.payees === null ? "any" : String(m.payees), m.purposes?.join(", ") ?? "any", m.rails?.join(", ") ?? "any", m.expiresAt ?? "no expiry", m.credentialId]),
)}
<h2>Events</h2>
${table(["when", "event"], s.events.map((e) => [e.at, e.text]))}
${reconciliation}
<h2>Verify this statement</h2>
<p>Anyone holding the bundle can check it offline:</p>
<pre>spendmarshal verify ${esc(s.source.name ?? "<bundle.json>")}${s.keys.signed.map((k) => ` --gateway-key ${esc(k)}`).join("")}</pre>
${s.source.sha256 ? `<p>SHA-256 of the bundle file as received: <code>${esc(s.source.sha256)}</code></p>` : ""}
<ul class="notes">${s.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
<p><small>generated ${esc(s.generatedAt)}</small></p>
</body></html>
`;
}
