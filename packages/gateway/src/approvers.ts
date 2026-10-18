import { isAddress, type Address } from "viem";
import type { Receipt, ApproverRegisteredData, ApproverRemovedData } from "@spendmarshal/core";
import { approversFor, type GatewayConfig } from "./config.js";
import { ChainConflict, type Store } from "./store.js";
import type { ReceiptLog } from "./receipts.js";

/**
 * Approver key history (ADR-0019). An approver's key changes (rotation, or a fresh key per run), and a principal's
 * evidence must keep verifying the approvals the old key signed. So the keys go into each principal's receipt chain: an
 * `approver.registered` receipt whenever an approver's configured key differs from the last one registered in that chain,
 * and an `approver.removed` receipt when an approver that holds a key there leaves the configuration. The verifier checks
 * each signed resolution against the key in force at its position in the chain.
 *
 * Each principal registers its own approvers, or the gateway-wide ones when it has none (ADR-0024).
 *
 * `sync()` runs for every configured principal at startup, and again right before a signed resolution is receipted, which
 * also covers a principal that is no longer configured but still has pending approvals. Syncs for one principal run one at
 * a time here, and the keys are read from the chain at every sync (indexed), since another gateway instance on the same
 * store may have changed them. Its receipts report a conflict instead of being rebuilt on a moved head, so the sync reads
 * the keys again and decides again: a key is never registered twice (ADR-0025).
 */
export class ApproverKeys {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly cfg: Pick<GatewayConfig, "approvers" | "principals">,
    private readonly store: Store,
    private readonly receipts: ReceiptLog,
  ) {
    for (const [id, address] of Object.entries(cfg.approvers ?? {})) {
      if (!isAddress(address, { strict: false })) throw new Error(`approver ${id}: ${address} is not an address`);
    }
    for (const [principalId, pc] of Object.entries(cfg.principals)) {
      for (const [id, address] of Object.entries(pc.approvers ?? {})) {
        if (!isAddress(address, { strict: false })) throw new Error(`approver ${id} of ${principalId}: ${address} is not an address`);
      }
    }
  }

  /** Receipts every difference between the configured approvers and the keys in the principal's chain; returns those receipts. */
  sync(principalId: string): Promise<Receipt[]> {
    const run = async (): Promise<Receipt[]> => {
      const written: Receipt[] = [];
      for (let attempt = 0; ; attempt++) {
        try {
          await this.syncOnce(principalId, written);
          return written;
        } catch (err) {
          if (!(err instanceof ChainConflict) || attempt >= 8) throw err; // another writer moved the chain: read again
        }
      }
    };
    const prev = this.queues.get(principalId) ?? Promise.resolve();
    const p = prev.then(run, run);
    this.queues.set(principalId, p.catch(() => undefined));
    return p;
  }

  /** One pass: every difference between the configured approvers and the chain's keys, receipted into `written`. */
  private async syncOnce(principalId: string, written: Receipt[]): Promise<void> {
    const held = await this.heldIn(principalId);
    const wanted = approversFor(this.cfg, principalId);
    for (const [approverId, address] of Object.entries(wanted)) {
      const prevAddress = held.get(approverId) ?? null;
      if (prevAddress?.toLowerCase() === address.toLowerCase()) continue;
      const data: ApproverRegisteredData = { approverId, address, prevAddress };
      written.push(await this.receipts.append(principalId, "approver.registered", { ...data }, {}, { conflicts: "report" }));
      held.set(approverId, address);
    }
    for (const [approverId, prevAddress] of held) {
      if (prevAddress === null || Object.hasOwn(wanted, approverId)) continue;
      const data: ApproverRemovedData = { approverId, prevAddress };
      written.push(await this.receipts.append(principalId, "approver.removed", { ...data }, {}, { conflicts: "report" }));
      held.set(approverId, null);
    }
  }

  /** approver id -> the key in force in the principal's chain (null: removed), read from its receipts */
  private async heldIn(principalId: string): Promise<Map<string, Address | null>> {
    const held = new Map<string, Address | null>();
    for (const r of await this.store.receiptsOfKind(principalId, ["approver.registered", "approver.removed"])) {
      const d = r.data as Partial<ApproverRegisteredData>;
      if (d.approverId) held.set(d.approverId, r.kind === "approver.registered" ? (d.address ?? null) : null);
    }
    return held;
  }
}
