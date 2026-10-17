import type { Address } from "viem";
import { randomId, nowIso, receiptHash, receiptSigner, gatewayKeyHandoverMessage, type GatewayKeyRotatedData, type Receipt, type ReceiptBody, type ReceiptKind } from "@spendmarshal/core";
import type { Store } from "./store.js";
import type { Signer } from "./signer.js";
import type { Metrics } from "./metrics.js";

type ReceiptMeta = Partial<Pick<Receipt, "agentId" | "credentialId" | "intentId" | "intentHash" | "approvalId" | "subscriptionId" | "rail" | "policyHash">>;

export interface ReceiptLogOptions {
  /**
   * Earlier gateway addresses the operator vouches for without holding their keys (a lost key). A chain whose head one of
   * them signed is continued with a rotation that has no handover (ADR-0022).
   */
  previousGatewayAddresses?: readonly string[];
  /** Where key rotations and refused chains are reported; the gateway passes its logger. */
  log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

/**
 * Append-only, hash-chained, gateway-signed receipt log. One chain per principal.
 *
 * Every receipt is signed by the gateway key in force at its position (ADR-0020). When another key signed a chain's head,
 * the first thing this log writes into that chain is a `gateway.key.rotated` receipt, signed by this gateway's key. It
 * carries the earlier key's handover signature when the signer holds that key; without one, the earlier address must be
 * one the operator declared. A chain signed by any other key is refused: continuing it would put this gateway's signature
 * over receipts nobody here wrote (ADR-0022).
 */
export class ReceiptLog {
  /** one append queue per principal: chains never race, and principals never wait for each other */
  private readonly chains = new Map<string, Promise<void>>();
  /** chain head per principal, seeded from the store once; an append never reads the chain. `key` signed the head. */
  private readonly heads = new Map<string, { seq: number; hash: string; key: Address }>();
  private readonly declared: Set<string>;

  constructor(
    private readonly store: Store,
    private readonly signer: Signer,
    private readonly metrics?: Metrics,
    private readonly opts: ReceiptLogOptions = {},
  ) {
    this.declared = new Set((opts.previousGatewayAddresses ?? []).map((a) => a.toLowerCase()));
  }

  append(principalId: string, kind: ReceiptKind, data: Record<string, unknown>, meta: ReceiptMeta = {}): Promise<Receipt> {
    return this.enqueue(principalId, async () => {
      await this.adoptKey(principalId);
      return this.write(principalId, kind, data, meta);
    });
  }

  /**
   * Hands the principal's chain over to this gateway's key if another key signed its head; returns the rotation receipt,
   * or null when nothing changed. Rejects (409) when the head's key is neither held nor declared. Every append does this
   * first; startup, anchoring and the reclaim job call it on their own, before anything happens on-chain.
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
    const facts = { principalId, seq: head.seq, signer: head.key, gateway: this.signer.address };
    if (handover === null && !this.declared.has(head.key.toLowerCase())) {
      this.metrics?.chainRefusals.inc();
      this.opts.log?.warn(facts, "refused to continue a receipt chain whose head an unknown key signed");
      throw Object.assign(
        new Error(`the receipt chain of ${principalId} ends with #${head.seq}, signed by ${head.key}: not this gateway's key, a previous key it holds, or a declared previous address (previousGatewayAddresses); refusing to continue it`),
        { statusCode: 409 },
      );
    }
    const data: GatewayKeyRotatedData = { prevAddress: head.key, address: this.signer.address, handover };
    const rotation = await this.write(principalId, "gateway.key.rotated", { ...data }, {});
    this.metrics?.gatewayKeyRotations.inc({ handover: handover ? "yes" : "no" });
    if (handover) this.opts.log?.info(facts, "receipt chain handed over to this gateway's key, signed by the previous key");
    else this.opts.log?.warn(facts, "receipt chain continued from a declared previous gateway address without a handover");
    return rotation;
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
