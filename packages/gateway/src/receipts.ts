import { randomId, nowIso, receiptHash, type Receipt, type ReceiptBody, type ReceiptKind } from "@apgw/core";
import type { Store } from "./store.js";
import type { Signer } from "./signer.js";
import type { Metrics } from "./metrics.js";

/** Append-only, hash-chained, gateway-signed receipt log. One chain per principal. */
export class ReceiptLog {
  private chain = Promise.resolve(); // serialises appends so seq/prev are never raced

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
      const prevReceipts = this.store.receiptsFor(principalId);
      const last = prevReceipts[prevReceipts.length - 1];
      const body: ReceiptBody = {
        v: 1,
        id: randomId("rcpt"),
        principalId,
        seq: last ? last.seq + 1 : 0,
        prev: last ? (last.hash as ReceiptBody["prev"]) : null,
        ts: nowIso(),
        kind,
        ...stripUndefined(meta),
        data: sanitize(data),
      };
      const hash = receiptHash(body);
      const sig = await this.signer.signReceiptHash(hash);
      const receipt: Receipt = { ...body, hash, sig };
      this.store.appendReceipt(receipt);
      this.metrics?.receipts.inc({ kind });
      return receipt;
    };
    const p = this.chain.then(run, run);
    this.chain = p.then(() => undefined, () => undefined);
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
