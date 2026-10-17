import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPhase1 } from "../src/run.js";

describe("phase 1", () => {
  it("runs end to end and every step passes", async () => {
    const dir = join(tmpdir(), `spendmarshal-phase1-${Date.now()}`);
    const s = await runPhase1({ rpcPort: 18546, gatewayPort: 14412, payeePort: 14413, dataDir: dir, evidenceOut: join(dir, "evidence.json"), log: () => {} });
    const failed = s.steps.filter((x) => !x.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(s.verification.ok).toBe(true);
    const kinds = s.evidence.receipts.map((r) => r.kind);
    for (const k of ["policy.updated", "approver.registered", "approval.requested", "approval.granted", "approval.rejected", "approval.consumed", "payment.settled", "payment.denied", "subscription.created", "subscription.charged", "subscription.refused", "subscription.cancelled", "preapproval.reclaimed", "killswitch", "evidence.anchored"]) expect(kinds).toContain(k);
    expect(s.evidence.policyVersions.map((v) => v.version)).toEqual([1, 2]);
    const settled = s.evidence.receipts.filter((r) => r.kind === "payment.settled");
    expect(settled.length).toBe(19); // 3 fetcher + 1 report + 1 standard + 2 feed + 2 stream + 1 lightning + 3 quotes + 5 concurrent + 1 idempotent
    expect(new Set(settled.map((r) => r.rail))).toEqual(new Set(["x402", "mpp", "l402"]));
  }, 240_000);
});
