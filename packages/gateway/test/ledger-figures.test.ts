import { describe, it, expect } from "vitest";
import type { SpendLedgerView } from "@spendmarshal/core";
import { decideOnFigures, type LedgerAnswer, type LedgerQuestion } from "../src/ledger-figures.js";

/** A ledger to fetch figures from, recording every round trip. */
function ledger(figures: Record<string, bigint>) {
  const trips: LedgerQuestion[][] = [];
  const fetch = async (qs: LedgerQuestion[]): Promise<LedgerAnswer[]> => {
    trips.push(qs);
    return qs.map((q) => ({ count: 1, amount: figures[`${q.kind}:${q.id}`] ?? 0n }));
  };
  return { trips, fetch };
}

describe("deciding on fetched ledger figures (ADR-0025)", () => {
  it("fetches every figure the decision asks for in one round trip, then decides on them", async () => {
    const { trips, fetch } = ledger({ "budget:org": 90n, "credential:root": 5n });
    const decide = (v: SpendLedgerView) => (v.spentByBudget("org") + 20n <= 100n && v.spentByCredential("root") <= 50n ? "allow" : "deny");
    expect(await decideOnFigures(decide, fetch)).toBe("deny"); // 90 + 20 is over the cap of 100
    expect(trips).toHaveLength(1);
    expect(trips[0]).toEqual([
      { kind: "budget", id: "org", since: null },
      { kind: "credential", id: "root", since: null },
    ]);
  });

  it("passes windows and activity scopes through as questions", async () => {
    const { trips, fetch } = ledger({});
    const since = new Date("2026-10-18T00:00:00.000Z");
    await decideOnFigures((v) => [v.spentByBudget("org", since), v.activity("agent", "a", since)], fetch);
    expect(trips[0]).toEqual([
      { kind: "budget", id: "org", since: "2026-10-18T00:00:00.000Z" },
      { kind: "activity", scope: "agent", id: "a", since: "2026-10-18T00:00:00.000Z" },
    ]);
  });

  it("fetches again when a figure leads the decision to ask a question it did not ask on zeros", async () => {
    const { trips, fetch } = ledger({ "budget:org": 500n, "budget:team": 7n });
    // asks about `team` only when `org` is large: on zeros it never does
    const decide = (v: SpendLedgerView) => (v.spentByBudget("org") > 100n ? v.spentByBudget("team") : -1n);
    expect(await decideOnFigures(decide, fetch)).toBe(7n);
    expect(trips.map((t) => t.map((q) => q.id))).toEqual([["org"], ["team"]]);
  });

  it("decides without a round trip when the decision asks nothing", async () => {
    const { trips, fetch } = ledger({});
    expect(await decideOnFigures(() => "allow", fetch)).toBe("allow");
    expect(trips).toHaveLength(0);
  });

  it("gives up on a decision that keeps asking for new figures", async () => {
    let n = 0;
    const { fetch } = ledger({});
    await expect(decideOnFigures((v) => v.spentByBudget(`b${n++}`), fetch)).rejects.toThrow("a ledger decision kept asking for new figures");
  });
});
