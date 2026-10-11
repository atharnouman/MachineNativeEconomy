import type { Store } from "./store.js";

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
 * Concurrent duplicates share one in-flight execution.
 */
export class IdempotencyGuard {
  private readonly inflight = new Map<string, Promise<unknown>>();
  constructor(private readonly store: Store) {}

  async run<T extends { ok: boolean; status: number }>(scope: string, key: string | undefined, fn: () => Promise<T>): Promise<{ result: T; replayed: boolean }> {
    if (!key) return { result: await fn(), replayed: false };
    const hit = this.store.getIdempotent(scope, key);
    if (hit) return { result: hit.body as T, replayed: true };
    const k = `${scope}\u0000${key}`;
    const running = this.inflight.get(k);
    if (running) return { result: (await running) as T, replayed: true };
    const p = (async () => {
      const result = await fn();
      const status = result.ok ? 200 : result.status;
      if (result.ok || status === 202 || status === 403) this.store.putIdempotent({ scope, key, status, body: result, createdAt: new Date().toISOString() });
      return result;
    })().finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return { result: (await p) as T, replayed: false };
  }
}
