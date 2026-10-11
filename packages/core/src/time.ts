import { z } from "zod";

export const BudgetPeriodSchema = z.enum(["lifetime", "daily", "weekly", "monthly"]);
export type BudgetPeriod = z.infer<typeof BudgetPeriodSchema>;

/** UTC calendar window start for a budget period, or null for lifetime. Weeks start on Monday 00:00 UTC. */
export function periodStart(period: BudgetPeriod, now: Date): Date | null {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  switch (period) {
    case "lifetime":
      return null;
    case "daily":
      return new Date(Date.UTC(y, m, d));
    case "weekly": {
      const dow = (now.getUTCDay() + 6) % 7; // Monday = 0
      return new Date(Date.UTC(y, m, d - dow));
    }
    case "monthly":
      return new Date(Date.UTC(y, m, 1));
  }
}

export const DurationSchema = z.string().regex(/^\d+(ms|s|m|h|d|w)$/);

/** "30s" | "10m" | "1h" | "1d" | "2w" -> milliseconds */
export function parseDuration(s: string): number {
  const m = /^(\d+)(ms|s|m|h|d|w)$/.exec(s);
  if (!m) throw new Error(`bad duration: ${s}`);
  const n = Number(m[1]);
  const unit = m[2]!;
  const mult: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return n * mult[unit]!;
}

export function windowStart(duration: string, now: Date): Date {
  return new Date(now.getTime() - parseDuration(duration));
}
