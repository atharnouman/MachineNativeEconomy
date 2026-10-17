import type { Address } from "viem";
import { randomId, nowIso, receiptHash, receiptSigner, gatewayKeyHandoverMessage, type GatewayKeyRotatedData, type Receipt, type ReceiptBody, type ReceiptKind } from "@spendmarshal/core";
import type { Store } from "./store.js";
import type { Signer } from "./signer.js";
import type { Metrics } from "./metrics.js";

type ReceiptMeta = Partial<Pick<Receipt, "agentId" | "credentialId" | "intentId" | "intentHash" | "approvalId" | "subscriptionId" | "rail" | "policyHash">>;

/**
 * Append-only, hash-chained, gateway-signed receipt log. One chain per principal.
 *
 * Every receipt is signed by the gateway key in force at its position (ADR-0020). When another key signed a chain's head,
 * the first thing this log writes into that chain is a `gateway.key.rotated` receipt, signed by this gateway's key and
 * carrying the earlier key's handover signature when the signer still holds that key.
 */
export class ReceiptLog {
  /** one append queue per principal: chains never race, and principals never wait for each other */
  private readonly chains = new Map<string, Promise<void>>();
  /** chain head per principal, seeded from the store once; an append never reads the chain. `key` signed the head. */
  private readonly heads = new Map<string, { seq: number; hash: string; key: Address }>();

  constructor(
    private readonly store: Store,
    private readonly signer: Signer,
    private readonly metrics?: Metrics,
  ) {}

  append(principalId: string, kind: ReceiptKind, data: Record<string, unknown>, meta: ReceiptMeta = {}): Promise<Receipt> {
    return this.enqueue(principalId, async () => {
      await this.adoptKey(principalId);
      return this.write(principalId, kind, data, meta);
    });
  }

  /**
   * Hands the principal's chain over to this gateway's key if another key signed its head; returns the rotation receipt,
   * or null when nothing changed. Every append does this first; startup and anchoring call it on their own.
   */
  handOver(principalId: string): Promise<Receipt | null> {
    return this.enqueue(principalId, () => this.adoptKey(principalId));
  }

  private enqueue<T>(principalId: string, run: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(principalId) ?? Promise.resolve();
    const p = prev.then(run, run);
    this.chains.set(principalId, p.then(() => undefined, () => undefined));
    return p;
  }

  private head(principalId: string) {
    let head = this.heads.get(principalId);
    if (!head) {
      const last = this.store.lastReceipt(principalId);
      if (last) {
        // a head whose signature does not even parse cannot name a key; appending then works as before key history
        let key = this.signer.address;
        try {
          key = receiptSigner(last);
        } catch {
          /* keep this gateway's key: the verifier reports the broken receipt */
        }
        head = { seq: last.seq, hash: last.hash, key };
        this.heads.set(principalId, head);
      }
    }
    return head;
  }

  private async adoptKey(principalId: string): Promise<Receipt | null> {
    const head = this.head(principalId);
    if (!head || head.key.toLowerCase() === this.signer.address.toLowerCase()) return null;
    const message = gatewayKeyHandoverMessage({ principalId, seq: head.seq + 1, prev: head.hash, prevAddress: head.key, address: this.signer.address });
    const handover = (await this.signer.signKeyHandover?.(head.key, message)) ?? null;
    const data: GatewayKeyRotatedData = { prevAddress: head.key, address: this.signer.address, handover };
    return this.write(principalId, "gateway.key.rotated", { ...data }, {});
  }

  private async write(principalId: string, kind: ReceiptKind, data: Record<string, unknown>, meta: ReceiptMeta): Promise<Receipt> {
    const head = this.head(principalId);
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
    this.heads.set(principalId, { seq: receipt.seq, hash: receipt.hash, key: this.signer.address });
    this.metrics?.receipts.inc({ kind });
    return receipt;
  }
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** bigint -> string, drop undefined, so the receipt is plain JSON. */
function sanitize(v: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))) as Record<string, unknown>;
}
