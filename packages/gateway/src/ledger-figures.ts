import type { SpendLedgerView } from "@spendmarshal/core";

/** One figure a ledger decision can ask for (ADR-0025). `since` is an ISO time, or null for all time. */
export type LedgerQuestion =
  | { kind: "credential"; id: string; since: string | null }
  | { kind: "budget"; id: string; since: string | null }
  | { kind: "activity"; scope: "credential" | "agent" | "principal"; id: string; since: string };

export interface LedgerAnswer {
  count: number;
  amount: bigint;
}

/**
 * Runs `decide` on figures fetched for it, for a store that cannot answer a ledger view synchronously (Postgres). The
 * first run gets zero for every figure and records what it asks; those figures are fetched in one round trip, and the
 * next run decides on them. A check fails sooner on real figures than on zeros, so that run normally asks nothing new; if
 * it does, the new figures are fetched and `decide` runs again. Inside one transaction the figures cannot change between
 * runs, so this ends. `decide` must be a pure function of the view.
 */
export async function decideOnFigures<T>(decide: (ledger: SpendLedgerView) => T, fetch: (questions: LedgerQuestion[]) => Promise<LedgerAnswer[]>, maxRounds = 6): Promise<T> {
  const answers = new Map<string, LedgerAnswer>();
  for (let round = 0; ; round++) {
    const missing = new Map<string, LedgerQuestion>();
    const ask = (q: LedgerQuestion): LedgerAnswer => {
      const key = JSON.stringify(q);
      const known = answers.get(key);
      if (known) return known;
      missing.set(key, q);
      return { count: 0, amount: 0n };
    };
    const result = decide({
      spentByCredential: (id, since) => ask({ kind: "credential", id, since: since?.toISOString() ?? null }).amount,
      spentByBudget: (id, since) => ask({ kind: "budget", id, since: since?.toISOString() ?? null }).amount,
      activity: (scope, id, since) => ({ ...ask({ kind: "activity", scope, id, since: since.toISOString() }) }),
    });
    if (missing.size === 0) return result;
    if (round >= maxRounds) throw new Error("a ledger decision kept asking for new figures");
    const questions = [...missing.values()];
    const got = await fetch(questions);
    questions.forEach((q, i) => answers.set(JSON.stringify(q), got[i]!));
  }
}
