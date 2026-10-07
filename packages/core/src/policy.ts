import { z } from "zod";
import YAML from "yaml";
import { toBase } from "./amount.js";
import { hashJson } from "./canonical.js";
import { effectiveLimits, lineage, credentialId, type Credential, type Rail } from "./credential.js";
import type { PaymentIntent } from "./intent.js";

/**
 * Principal-level policy. Declarative, versioned, deterministic.
 *
 * Decision order:
 *   1. kill switch                      -> deny
 *   2. any matching `deny` rule         -> deny
 *   3. credential caveats (conjunction) -> deny
 *   4. lineage spend caps               -> deny
 *   5. budget tree (agent -> ... root)  -> deny
 *   6. any matching `escalate` rule     -> escalate (human approval required)
 *   7. any matching `allow` rule        -> allow
 *   8. otherwise                        -> deny (default-deny)
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
      rails: z.array(z.enum(["x402", "mpp"])).optional(),
      purposes: z.array(z.string()).optional(),
      amount_gt: Decimal.optional(), // human units
      amount_lte: Decimal.optional(),
      resource_glob: z.string().optional(), // simple glob: * and ?
      agents: z.array(z.string()).optional(),
    })
    .default({}),
});
export type Rule = z.infer<typeof RuleSchema>;

export const PolicySchema = z.object({
  version: z.literal(1),
  principalId: z.string().min(1),
  currency: z.object({ asset: z.string(), decimals: z.number().int().default(6) }).default({ asset: "USDC", decimals: 6 }),
  budgets: z.record(z.object({ cap: Decimal, parent: z.string().optional() })),
  agents: z.record(z.object({ budget: z.string() })), // agentId -> budgetId; sub-agents inherit via credential lineage
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
  /** total already spent (settled + reserved) attributed to a credential lineage node, by credentialId */
  spentByCredential(credentialId: string): bigint;
  /** total already spent attributed to a budget node, by budgetId */
  spentByBudget(budgetId: string): bigint;
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
}

function globToRegex(g: string): RegExp {
  return new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
}

function ruleMatches(r: Rule, ctx: { intent: PaymentIntent; amountHuman: number; rail: Rail | "auto" }): boolean {
  const m = r.match;
  const host = ctx.intent.payee.host.toLowerCase();
  const addr = ctx.intent.payee.address?.toLowerCase();
  const payeeIn = (list: string[]) => list.some((p) => p.toLowerCase() === host || (addr && p.toLowerCase() === addr));
  if (m.payees && !payeeIn(m.payees)) return false;
  if (m.payees_not && payeeIn(m.payees_not)) return false;
  if (m.rails && ctx.rail !== "auto" && !m.rails.includes(ctx.rail)) return false;
  if (m.purposes && !m.purposes.includes(ctx.intent.purpose)) return false;
  if (m.amount_gt !== undefined && !(ctx.amountHuman > Number(m.amount_gt))) return false;
  if (m.amount_lte !== undefined && !(ctx.amountHuman <= Number(m.amount_lte))) return false;
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

export function evaluate(args: {
  policy: Policy;
  intent: PaymentIntent;
  credential: Credential;
  amountBase: bigint; // the amount actually being decided (quoted price, or maxAmount for a pre-check)
  rail: Rail | "auto";
  ledger: SpendLedgerView;
  now?: Date;
  killSwitch?: boolean;
}): Decision {
  const { policy, intent, credential, amountBase, rail, ledger } = args;
  const now = args.now ?? new Date();
  const dec = policy.currency.decimals;
  const amountHuman = Number(amountBase) / 10 ** dec;
  const checks: DecisionCheck[] = [];
  const reasons: string[] = [];
  const matched: string[] = [];
  const ph = policyHash(policy);
  const budgetPath = budgetPathFor(policy, rootAgentOf(credential));
  const finish = (effect: Decision["effect"]): Decision => ({
    effect,
    reasons,
    checks,
    matchedRules: matched,
    budgetPath,
    policyHash: ph,
    amount: amountBase.toString(),
  });

  // 1. kill switch
  if (args.killSwitch) {
    checks.push({ check: "kill_switch", ok: false, detail: "principal kill switch engaged" });
    reasons.push("KILL_SWITCH");
    return finish("deny");
  }
  checks.push({ check: "kill_switch", ok: true });

  // 2. deny rules
  const ctx = { intent, amountHuman, rail };
  for (const r of policy.rules.filter((r) => r.effect === "deny")) {
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

  // 5. budget tree
  if (budgetPath.length === 0) {
    checks.push({ check: "budget", ok: false, detail: `no budget for agent ${rootAgentOf(credential)}` });
    reasons.push("NO_BUDGET");
    return finish("deny");
  }
  for (const b of budgetPath) {
    const cap = toBase(policy.budgets[b]!.cap, dec);
    const spent = ledger.spentByBudget(b);
    const ok = spent + amountBase <= cap;
    checks.push({ check: `budget:${b}`, ok, detail: `spent ${spent} + ${amountBase} vs cap ${cap}` });
    if (!ok) {
      reasons.push(`BUDGET:${b}`);
      return finish("deny");
    }
  }

  // 6. escalate rules
  for (const r of policy.rules.filter((r) => r.effect === "escalate")) {
    if (ruleMatches(r, ctx)) {
      matched.push(r.id);
      checks.push({ check: `rule:${r.id}`, ok: false, detail: r.description ?? "escalation rule matched" });
      reasons.push(`RULE_ESCALATE:${r.id}`);
      return finish("escalate");
    }
  }

  // 7. allow rules
  for (const r of policy.rules.filter((r) => r.effect === "allow")) {
    if (ruleMatches(r, ctx)) {
      matched.push(r.id);
      checks.push({ check: `rule:${r.id}`, ok: true, detail: r.description ?? "allow rule matched" });
      return finish("allow");
    }
  }

  // 8. default deny
  checks.push({ check: "default", ok: false, detail: "no allow rule matched" });
  reasons.push("DEFAULT_DENY");
  return finish("deny");
}

/** The agent named by the root delegate caveat: the one the policy's `agents` map keys on. */
export function rootAgentOf(c: Pick<Credential, "caveats">): string {
  const first = c.caveats[0];
  if (!first || first.type !== "delegate") throw new Error("malformed credential");
  return first.agentId;
}
