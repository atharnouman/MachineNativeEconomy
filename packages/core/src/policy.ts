import { z } from "zod";
import YAML from "yaml";
import { toBase } from "./amount.js";
import { hashJson } from "./canonical.js";
import { effectiveLimits, lineage, lineageSegments, credentialId, type Credential, type Rail, type RateLimit } from "./credential.js";
import type { PaymentIntent } from "./intent.js";
import { BudgetPeriodSchema, DurationSchema, periodStart, windowStart, parseDuration } from "./time.js";

/**
 * Principal-level policy. Declarative, versioned, deterministic.
 *
 * Decision order:
 *   1. kill switch                        -> deny
 *   2. any matching `deny` rule           -> deny
 *   3. credential caveats (conjunction)   -> deny   (incl. rate_limit caveats, scoped to the node that set them)
 *   4. lineage spend caps                 -> deny
 *   5. budget tree with periods           -> deny
 *   6. velocity rules                     -> deny
 *   7. any matching `escalate` rule       -> escalate (unless an approval for this intent is presented)
 *   8. any matching `allow` rule          -> allow
 *   9. otherwise                          -> deny (default-deny)
 */

const Decimal = z.string().regex(/^\d+(\.\d+)?$/);

export const RuleSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  effect: z.enum(["allow", "deny", "escalate"]),
  match: z
    .object({
      payees: z.array(z.string()).optional(), // host or address, case-insensitive
      payees_not: z.array(z.string()).optional(),
      rails: z.array(z.enum(["x402", "mpp", "l402"])).optional(),
      purposes: z.array(z.string()).optional(),
      amount_gt: Decimal.optional(), // human units
      amount_lte: Decimal.optional(),
      resource_glob: z.string().optional(), // simple glob: * and ?
      agents: z.array(z.string()).optional(),
    })
    .default({}),
});
export type Rule = z.infer<typeof RuleSchema>;

export const VelocityRuleSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  scope: z.enum(["credential", "agent", "principal"]),
  window: DurationSchema,
  max_count: z.number().int().positive().optional(),
  max_amount: Decimal.optional(), // human units
  agents: z.array(z.string()).optional(), // restrict to these root agents
});
export type VelocityRule = z.infer<typeof VelocityRuleSchema>;

export const PolicySchema = z.object({
  version: z.literal(1),
  principalId: z.string().min(1),
  currency: z.object({ asset: z.string(), decimals: z.number().int().default(6) }).default({ asset: "USDC", decimals: 6 }),
  budgets: z.record(z.object({ cap: Decimal, parent: z.string().optional(), period: BudgetPeriodSchema.default("lifetime") })),
  agents: z.record(z.object({ budget: z.string() })), // agentId -> budgetId; sub-agents inherit via credential lineage
  velocity: z.array(VelocityRuleSchema).default([]),
  rules: z.array(RuleSchema).default([]),
});
export type Policy = z.infer<typeof PolicySchema>;

export function parsePolicyYaml(text: string): Policy {
  return PolicySchema.parse(YAML.parse(text));
}

export function policyHash(p: Policy): `0x${string}` {
  return hashJson(p);
}

export interface SpendLedgerView {
  /** settled + reserved attributed to a credential lineage node (descendants included), optionally since a time */
  spentByCredential(credentialId: string, since?: Date): bigint;
  /** settled + reserved attributed to a budget node, optionally since a time */
  spentByBudget(budgetId: string, since?: Date): bigint;
  /** number and amount of payments in a rolling window for a scope */
  activity(scope: "credential" | "agent" | "principal", id: string, since: Date): { count: number; amount: bigint };
}

export interface DecisionCheck {
  check: string;
  ok: boolean;
  detail?: string;
}

export interface Decision {
  effect: "allow" | "deny" | "escalate";
  reasons: string[];
  checks: DecisionCheck[];
  matchedRules: string[];
  budgetPath: string[]; // budget ids from agent's budget up to root
  policyHash: `0x${string}`;
  amount: string; // base units evaluated
  approvalId?: string; // when an approval satisfied the escalation
}

function globToRegex(g: string): RegExp {
  return new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
}

const hasAmountPredicate = (r: Rule) => r.match.amount_gt !== undefined || r.match.amount_lte !== undefined;

function ruleMatches(r: Rule, ctx: { intent: PaymentIntent; amountHuman: number; rail: Rail | "auto" }, ignoreAmount = false): boolean {
  const m = r.match;
  const host = ctx.intent.payee.host.toLowerCase();
  const addr = ctx.intent.payee.address?.toLowerCase();
  const payeeIn = (list: string[]) => list.some((p) => p.toLowerCase() === host || (addr && p.toLowerCase() === addr));
  if (m.payees && !payeeIn(m.payees)) return false;
  if (m.payees_not && payeeIn(m.payees_not)) return false;
  if (m.rails && ctx.rail !== "auto" && !m.rails.includes(ctx.rail)) return false;
  if (m.purposes && !m.purposes.includes(ctx.intent.purpose)) return false;
  if (!ignoreAmount && m.amount_gt !== undefined && !(ctx.amountHuman > Number(m.amount_gt))) return false;
  if (!ignoreAmount && m.amount_lte !== undefined && !(ctx.amountHuman <= Number(m.amount_lte))) return false;
  if (m.resource_glob && !globToRegex(m.resource_glob).test(ctx.intent.resource)) return false;
  if (m.agents && !m.agents.includes(ctx.intent.agentId)) return false;
  return true;
}

export function budgetPathFor(policy: Policy, agentId: string): string[] {
  const start = policy.agents[agentId]?.budget;
  if (!start) return [];
  const path: string[] = [];
  let cur: string | undefined = start;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    path.push(cur);
    cur = policy.budgets[cur]?.parent;
  }
  return path;
}

/** The agent named by the root delegate caveat: the one the policy's `agents` map keys on. */
export function rootAgentOf(c: Pick<Credential, "caveats">): string {
  const first = c.caveats[0];
  if (!first || first.type !== "delegate") throw new Error("malformed credential");
  return first.agentId;
}

export function evaluate(args: {
  policy: Policy;
  intent: PaymentIntent;
  credential: Credential;
  amountBase: bigint; // the amount actually being decided (quoted price, or maxAmount for a pre-check)
  rail: Rail | "auto";
  ledger: SpendLedgerView;
  now?: Date;
  killSwitch?: boolean;
  /** An approval granted for this intent: satisfies escalation rules (every other check still applies). */
  approval?: { id: string };
  /**
   * `structural` (before the price is known): rules with amount predicates are skipped for deny/escalate and
   * their amount predicates ignored for allow, so the pass answers "could this ever be allowed?" without
   * tripping on a price that does not exist yet. `binding` (default): everything, on the real amount.
   */
  stage?: "structural" | "binding";
}): Decision {
  const { policy, intent, credential, amountBase, rail, ledger } = args;
  const structural = args.stage === "structural";
  const now = args.now ?? new Date();
  const dec = policy.currency.decimals;
  const amountHuman = Number(amountBase) / 10 ** dec;
  const checks: DecisionCheck[] = [];
  const reasons: string[] = [];
  const matched: string[] = [];
  const ph = policyHash(policy);
  const rootAgent = rootAgentOf(credential);
  const budgetPath = budgetPathFor(policy, rootAgent);
  const finish = (effect: Decision["effect"]): Decision => ({
    effect,
    reasons,
    checks,
    matchedRules: matched,
    budgetPath,
    policyHash: ph,
    amount: amountBase.toString(),
    ...(args.approval && effect === "allow" ? { approvalId: args.approval.id } : {}),
  });

  // 1. kill switch
  if (args.killSwitch) {
    checks.push({ check: "kill_switch", ok: false, detail: "principal kill switch engaged" });
    reasons.push("KILL_SWITCH");
    return finish("deny");
  }
  checks.push({ check: "kill_switch", ok: true });

  // 2. deny rules (amount-conditioned ones wait for the binding stage)
  const ctx = { intent, amountHuman, rail };
  for (const r of policy.rules.filter((r) => r.effect === "deny" && !(structural && hasAmountPredicate(r)))) {
    if (ruleMatches(r, ctx)) {
      matched.push(r.id);
      checks.push({ check: `rule:${r.id}`, ok: false, detail: r.description ?? "deny rule matched" });
      reasons.push(`RULE_DENY:${r.id}`);
      return finish("deny");
    }
  }

  // 3. credential caveats
  const lim = effectiveLimits(credential.caveats);
  const host = intent.payee.host.toLowerCase();
  const addr = intent.payee.address?.toLowerCase();
  const cav = (name: string, ok: boolean, detail: string) => {
    checks.push({ check: `caveat:${name}`, ok, detail });
    if (!ok) reasons.push(`CAVEAT:${name}`);
    return ok;
  };
  let caveatsOk = true;
  caveatsOk &&= cav("per_tx_max", lim.perTxMax === null || amountBase <= lim.perTxMax, `amount ${amountBase} vs max ${lim.perTxMax}`);
  caveatsOk &&= cav("expires_at", lim.expiresAt === null || now <= lim.expiresAt, `now ${now.toISOString()} vs ${lim.expiresAt?.toISOString()}`);
  caveatsOk &&= cav("not_before", lim.notBefore === null || now >= lim.notBefore, `now ${now.toISOString()} vs ${lim.notBefore?.toISOString()}`);
  caveatsOk &&= cav(
    "allowed_payees",
    lim.allowedPayees === null || lim.allowedPayees.has(host) || (!!addr && lim.allowedPayees.has(addr)),
    `payee ${host}${addr ? "/" + addr : ""}`,
  );
  caveatsOk &&= cav("allowed_rails", rail === "auto" || lim.allowedRails === null || lim.allowedRails.has(rail), `rail ${rail}`);
  caveatsOk &&= cav("purposes", lim.purposes === null || lim.purposes.has(intent.purpose), `purpose ${intent.purpose}`);
  caveatsOk &&= cav("chains", lim.chains === null || lim.chains.has(intent.maxAmount.chain), `chain ${intent.maxAmount.chain}`);
  if (!caveatsOk) return finish("deny");

  // 3b. rate_limit caveats: each is evaluated against the activity of the lineage node that introduced it
  for (const seg of lineageSegments(credential)) {
    for (const rl of seg.segment.filter((c): c is RateLimit => c.type === "rate_limit")) {
      const since = windowStart(rl.window, now);
      const act = ledger.activity("credential", seg.id, since);
      const countOk = rl.max_count === undefined || act.count + 1 <= rl.max_count;
      const amountOk = rl.max_amount === undefined || act.amount + amountBase <= BigInt(rl.max_amount);
      const ok = countOk && amountOk;
      checks.push({
        check: `caveat:rate_limit:${seg.id}`,
        ok,
        detail: `window ${rl.window}: ${act.count}+1 payments vs ${rl.max_count ?? "∞"}, ${act.amount}+${amountBase} vs ${rl.max_amount ?? "∞"}`,
      });
      if (!ok) {
        reasons.push(`CAVEAT:rate_limit:${seg.id}`);
        return finish("deny");
      }
    }
  }

  // 4. lineage spend caps: every ancestor's cap bounds the total spent by it and all its descendants
  for (const node of lineage(credential)) {
    const nodeLim = effectiveLimits(node.caveats);
    if (nodeLim.spendCap === null) continue;
    const id = credentialId(node);
    const spent = ledger.spentByCredential(id);
    const ok = spent + amountBase <= nodeLim.spendCap;
    checks.push({ check: `lineage_cap:${id}`, ok, detail: `spent ${spent} + ${amountBase} vs cap ${nodeLim.spendCap}` });
    if (!ok) {
      reasons.push(`LINEAGE_CAP:${id}`);
      return finish("deny");
    }
  }

  // 5. budget tree with periods
  if (budgetPath.length === 0) {
    checks.push({ check: "budget", ok: false, detail: `no budget for agent ${rootAgent}` });
    reasons.push("NO_BUDGET");
    return finish("deny");
  }
  for (const b of budgetPath) {
    const budget = policy.budgets[b]!;
    const cap = toBase(budget.cap, dec);
    const since = periodStart(budget.period, now) ?? undefined;
    const spent = ledger.spentByBudget(b, since);
    const ok = spent + amountBase <= cap;
    checks.push({
      check: `budget:${b}`,
      ok,
      detail: `${budget.period}${since ? ` from ${since.toISOString()}` : ""}: spent ${spent} + ${amountBase} vs cap ${cap}`,
    });
    if (!ok) {
      reasons.push(`BUDGET:${b}`);
      return finish("deny");
    }
  }

  // 6. velocity rules
  for (const v of policy.velocity) {
    if (v.agents && !v.agents.includes(rootAgent)) continue;
    const scopeId = v.scope === "credential" ? intent.credentialId : v.scope === "agent" ? rootAgent : intent.principalId;
    const since = new Date(now.getTime() - parseDuration(v.window));
    const act = ledger.activity(v.scope, scopeId, since);
    const countOk = v.max_count === undefined || act.count + 1 <= v.max_count;
    const amountOk = v.max_amount === undefined || act.amount + amountBase <= toBase(v.max_amount, dec);
    const ok = countOk && amountOk;
    checks.push({
      check: `velocity:${v.id}`,
      ok,
      detail: `${v.scope} ${scopeId} in ${v.window}: ${act.count}+1 vs ${v.max_count ?? "∞"} payments, ${act.amount}+${amountBase} vs ${v.max_amount ? toBase(v.max_amount, dec) : "∞"}`,
    });
    if (!ok) {
      reasons.push(`VELOCITY:${v.id}`);
      return finish("deny");
    }
  }

  // 7. escalate rules (amount-conditioned ones wait for the binding stage)
  for (const r of policy.rules.filter((r) => r.effect === "escalate" && !(structural && hasAmountPredicate(r)))) {
    if (ruleMatches(r, ctx)) {
      matched.push(r.id);
      if (args.approval) {
        checks.push({ check: `rule:${r.id}`, ok: true, detail: `escalation satisfied by approval ${args.approval.id}` });
        continue;
      }
      checks.push({ check: `rule:${r.id}`, ok: false, detail: r.description ?? "escalation rule matched" });
      reasons.push(`RULE_ESCALATE:${r.id}`);
      return finish("escalate");
    }
  }

  // 8. allow rules (structural stage: an allow rule counts if it could match at some amount)
  for (const r of policy.rules.filter((r) => r.effect === "allow")) {
    if (ruleMatches(r, ctx, structural)) {
      matched.push(r.id);
      checks.push({ check: `rule:${r.id}`, ok: true, detail: r.description ?? "allow rule matched" });
      return finish("allow");
    }
  }

  // 9. default deny
  checks.push({ check: "default", ok: false, detail: "no allow rule matched" });
  reasons.push("DEFAULT_DENY");
  return finish("deny");
}

/** Structural diff between two policy versions, for `policy.updated` receipts. */
export function diffPolicies(a: Policy, b: Policy): { budgets: string[]; agents: string[]; rules: string[]; velocity: string[] } {
  const keys = <T extends Record<string, unknown>>(x: T, y: T) => new Set([...Object.keys(x), ...Object.keys(y)]);
  const changed = <T extends Record<string, unknown>>(x: T, y: T) =>
    [...keys(x, y)].filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k])).map((k) => (x[k] === undefined ? `+${k}` : y[k] === undefined ? `-${k}` : `~${k}`));
  const byId = (rs: { id: string }[]) => Object.fromEntries(rs.map((r) => [r.id, r]));
  return {
    budgets: changed(a.budgets, b.budgets),
    agents: changed(a.agents, b.agents),
    rules: changed(byId(a.rules), byId(b.rules)),
    velocity: changed(byId(a.velocity), byId(b.velocity)),
  };
}
