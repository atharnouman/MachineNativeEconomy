import { randomId, nowIso, receiptHash, type Receipt, type ReceiptBody, type ReceiptKind } from "@spendmarshal/core";
import type { Store } from "./store.js";
import type { Signer } from "./signer.js";
import type { Metrics } from "./metrics.js";

/** Append-only, hash-chained, gateway-signed receipt log. One chain per principal. */
export class ReceiptLog {
  /** one append queue per principal: chains never race, and principals never wait for each other */
  private readonly chains = new Map<string, Promise<void>>();
  /** chain head per principal, seeded from the store once; an append never reads the chain */
  private readonly heads = new Map<string, { seq: number; hash: string }>();

  constructor(
    private readonly store: Store,
    private readonly signer: Signer,
    private readonly metrics?: Metrics,
  ) {}

  append(
    principalId: string,
    kind: ReceiptKind,
    data: Record<string, unknown>,
    meta: Partial<Pick<Receipt, "agentId" | "credentialId" | "intentId" | "intentHash" | "approvalId" | "subscriptionId" | "rail" | "policyHash">> = {},
  ): Promise<Receipt> {
    const run = async (): Promise<Receipt> => {
      let head = this.heads.get(principalId);
      if (!head) {
        const last = this.store.lastReceipt(principalId);
        if (last) head = { seq: last.seq, hash: last.hash };
      }
      const body: ReceiptBody = {
        v: 1,
        id: randomId("rcpt"),
        principalId,
        seq: head ? head.seq + 1 : 0,
        prev: head ? (head.hash as ReceiptBody["prev"]) : null,
        ts: nowIso(),
        kind,
        ...stripUndefined(meta),
        data: sanitize(data),
      };
      const hash = receiptHash(body);
      const sig = await this.signer.signReceiptHash(hash);
      const receipt: Receipt = { ...body, hash, sig };
      this.store.appendReceipt(receipt);
      this.heads.set(principalId, { seq: receipt.seq, hash: receipt.hash });
      this.metrics?.receipts.inc({ kind });
      return receipt;
    };
    const prev = this.chains.get(principalId) ?? Promise.resolve();
    const p = prev.then(run, run);
    this.chains.set(principalId, p.then(() => undefined, () => undefined));
    return p;
  }
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** bigint -> string, drop undefined, so the receipt is plain JSON. */
function sanitize(v: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))) as Record<string, unknown>;
}
