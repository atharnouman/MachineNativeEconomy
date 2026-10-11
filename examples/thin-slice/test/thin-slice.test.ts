import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runThinSlice } from "../src/run.js";

// End-to-end: real anvil, real contracts, real HTTP between gateway and payee.
describe("thin slice", () => {
  it("runs end to end and every step passes", async () => {
    const dir = join(tmpdir(), `spendmarshal-thin-slice-${Date.now()}`);
    const s = await runThinSlice({ rpcPort: 18545, gatewayPort: 14402, payeePort: 14403, dataDir: dir, evidenceOut: join(dir, "evidence.json"), log: () => {} });
    const failed = s.steps.filter((x) => !x.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(s.verification.ok).toBe(true);
    const kinds = s.evidence.receipts.map((r) => r.kind);
    expect(kinds).toContain("payment.settled");
    expect(kinds).toContain("payment.denied");
    expect(kinds).toContain("killswitch");
    expect(kinds).toContain("evidence.anchored");
    expect(s.evidence.receipts.filter((r) => r.kind === "payment.settled").length).toBe(4); // x402, mpp, auto, parent
  }, 180_000);
});
