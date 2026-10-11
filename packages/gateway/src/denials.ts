/** Denial receipts per credential before the throttle engages, and the window it applies to. */
export const DENIAL_LIMIT = 50;
export const DENIAL_WINDOW_MS = 10 * 60_000;

/**
 * Bounds how many `payment.denied` receipts one credential can produce: after `limit` denials inside a window the
 * receipts stop, and the first denial of the next window reports how many were suppressed. Every denial still
 * answers 403 and counts in metrics; only the receipt chain is protected from a looping or hostile agent.
 */
export class DenialThrottle {
  private readonly state = new Map<string, { windowStart: number; count: number; suppressed: number }>();

  constructor(
    private readonly limit = DENIAL_LIMIT,
    private readonly windowMs = DENIAL_WINDOW_MS,
  ) {}

  /** `null` = suppress this receipt; otherwise the number suppressed in the previous window (0 when none). */
  admit(key: string, now = Date.now()): { carried: number } | null {
    let s = this.state.get(key);
    let carried = 0;
    if (!s || now - s.windowStart >= this.windowMs) {
      carried = s?.suppressed ?? 0;
      s = { windowStart: now, count: 0, suppressed: 0 };
      this.state.set(key, s);
    }
    if (s.count >= this.limit) {
      s.suppressed++;
      return null;
    }
    s.count++;
    return { carried };
  }
}
