import { randomId } from "@spendmarshal/core";
import type { Store } from "./store.js";

/** How long a running request holds its key, and how long a duplicate waits for its outcome before 409. */
export const IDEMPOTENCY_LEASE_MS = 10 * 60_000;
export const IDEMPOTENCY_WAIT_MS = 2 * 60_000;

/** Reads and validates the client's Idempotency-Key header (1-128 characters). */
export function idempotencyKeyOf(req: { headers: Record<string, unknown> }): string | undefined {
  const v = req.headers["idempotency-key"];
  const raw = Array.isArray(v) ? v[0] : v;
  if (raw === undefined) return undefined;
  const key = String(raw).trim();
  if (!key || key.length > 128) throw Object.assign(new Error("Idempotency-Key must be 1 to 128 characters"), { statusCode: 400 });
  return key;
}

/**
 * Same credential + same key = same outcome, for 24 hours. Final outcomes (settled, pending approval, denied) are
 * stored and replayed; transient failures (payee unreachable, settlement error) are not, so a retry tries again.
 * Concurrent duplicates share one execution: in this process through the in-flight map, across gateway instances
 * through a lease on the key, whose holder runs the request while a duplicate waits for the stored outcome (ADR-0025).
 */
export class IdempotencyGuard {
  private readonly inflight = new Map<string, Promise<{ result: unknown; replayed: boolean }>>();
  constructor(private readonly store: Store) {}

  async run<T extends { ok: boolean; status: number }>(scope: string, key: string | undefined, fn: () => Promise<T>): Promise<{ result: T; replayed: boolean }> {
    if (!key) return { result: await fn(), replayed: false };
    const hit = await this.store.getIdempotent(scope, key);
    if (hit) return { result: hit.body as T, replayed: true };
    const k = `${scope}\u0000${key}`;
    const running = this.inflight.get(k);
    if (running) return { result: (await running).result as T, replayed: true };
    const p = this.runLeased(scope, key, fn).finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return (await p) as { result: T; replayed: boolean };
  }

  private async runLeased<T extends { ok: boolean; status: number }>(scope: string, key: string, fn: () => Promise<T>): Promise<{ result: T; replayed: boolean }> {
    const lease = `idempotency:${scope}:${key}`;
    const holder = randomId("idem");
    const deadline = Date.now() + IDEMPOTENCY_WAIT_MS;
    while (!(await this.store.acquireLease(lease, holder, IDEMPOTENCY_LEASE_MS))) {
      // another instance runs this request: replay its outcome once stored, or run it if it ended without one
      const done = await this.store.getIdempotent(scope, key);
      if (done) return { result: done.body as T, replayed: true };
      if (Date.now() >= deadline) throw Object.assign(new Error("a request with this Idempotency-Key is still in progress"), { statusCode: 409 });
      await new Promise((r) => setTimeout(r, 200));
    }
    try {
      const done = await this.store.getIdempotent(scope, key); // finished between the first look and the lease
      if (done) return { result: done.body as T, replayed: true };
      const result = await fn();
      const status = result.ok ? 200 : result.status;
      if (result.ok || status === 202 || status === 403) await this.store.putIdempotent({ scope, key, status, body: result, createdAt: new Date().toISOString() });
      return { result, replayed: false };
    } finally {
      await this.store.releaseLease(lease, holder);
    }
  }
}
