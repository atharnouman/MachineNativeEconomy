import { isAddress, type Address } from "viem";
import type { Receipt, ApproverRegisteredData, ApproverRemovedData } from "@spendmarshal/core";
import type { GatewayConfig } from "./config.js";
import type { Store } from "./store.js";
import type { ReceiptLog } from "./receipts.js";

/**
 * Approver key history (ADR-0019). An approver's key changes (rotation, or a fresh key per run), and a principal's
 * evidence must keep verifying the approvals the old key signed. So the keys go into each principal's receipt chain: an
 * `approver.registered` receipt whenever an approver's configured key differs from the last one registered in that chain,
 * and an `approver.removed` receipt when an approver that holds a key there leaves the configuration. The verifier checks
 * each signed resolution against the key in force at its position in the chain.
 *
 * `sync()` runs for every configured principal at startup, and again right before a signed resolution is receipted, which
 * also covers a principal that is no longer configured but still has pending approvals. A principal's keys are read from
 * its chain once (indexed) and then kept in memory; syncs for one principal run one at a time, so a key is never
 * registered twice.
 */
export class ApproverKeys {
  /** principal -> approver id -> the key in force in that principal's chain (null: removed) */
  private readonly held = new Map<string, Map<string, Address | null>>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly cfg: Pick<GatewayConfig, "approvers">,
    private readonly store: Store,
    private readonly receipts: ReceiptLog,
  ) {
    for (const [id, address] of Object.entries(cfg.approvers ?? {})) {
      if (!isAddress(address, { strict: false })) throw new Error(`approver ${id}: ${address} is not an address`);
    }
  }

  /** Receipts every difference between the configured approvers and the keys in the principal's chain; returns those receipts. */
  sync(principalId: string): Promise<Receipt[]> {
    const run = async (): Promise<Receipt[]> => {
      const held = this.heldIn(principalId);
      const wanted = this.cfg.approvers ?? {};
      const written: Receipt[] = [];
      for (const [approverId, address] of Object.entries(wanted)) {
        const prevAddress = held.get(approverId) ?? null;
        if (prevAddress?.toLowerCase() === address.toLowerCase()) continue;
        const data: ApproverRegisteredData = { approverId, address, prevAddress };
        written.push(await this.receipts.append(principalId, "approver.registered", { ...data }));
        held.set(approverId, address);
      }
      for (const [approverId, prevAddress] of held) {
        if (prevAddress === null || Object.hasOwn(wanted, approverId)) continue;
        const data: ApproverRemovedData = { approverId, prevAddress };
        written.push(await this.receipts.append(principalId, "approver.removed", { ...data }));
        held.set(approverId, null);
      }
      return written;
    };
    const prev = this.queues.get(principalId) ?? Promise.resolve();
    const p = prev.then(run, run);
    this.queues.set(principalId, p.catch(() => undefined));
    return p;
  }

  private heldIn(principalId: string): Map<string, Address | null> {
    let held = this.held.get(principalId);
    if (!held) {
      held = new Map();
      for (const r of this.store.receiptsOfKind(principalId, ["approver.registered", "approver.removed"])) {
        const d = r.data as Partial<ApproverRegisteredData>;
        if (d.approverId) held.set(d.approverId, r.kind === "approver.registered" ? (d.address ?? null) : null);
      }
      this.held.set(principalId, held);
    }
    return held;
  }
}
