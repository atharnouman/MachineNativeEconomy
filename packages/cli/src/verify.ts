import { createPublicClient, http, type Address, type Hex } from "viem";
import { verifyBundle, EvidenceBundleSchema, ReceiptRegistryAbi, chainFor, gatewayKeyAt, gatewayKeyHistory, type EvidenceBundle, type VerifyReport } from "@spendmarshal/core";

/**
 * Offline verification plus, when an RPC is given, confirmation that each anchor exists on-chain. `trustedGatewayKeys`
 * pins the gateway keys the auditor trusts (ADR-0020).
 */
export async function verifyEvidence(bundle: unknown, opts: { rpcUrl?: string; trustedGatewayKeys?: string[] } = {}): Promise<VerifyReport & { bundle: EvidenceBundle | null }> {
  const parsed = EvidenceBundleSchema.safeParse(bundle);
  if (!parsed.success) return { ok: false, checks: [{ check: "schema", ok: false, detail: parsed.error.issues[0]?.message }], bundle: null };
  const b = parsed.data;
  const report = await verifyBundle(b, { trustedGatewayKeys: opts.trustedGatewayKeys });
  if (opts.rpcUrl && b.anchors.length) {
    const chainId = Number(b.gateway.chain.split(":")[1]);
    const client = createPublicClient({ chain: chainFor(chainId, opts.rpcUrl), transport: http(opts.rpcUrl) });
    let ok = true;
    const detail: string[] = [];
    const keys = gatewayKeyHistory(b.receipts);
    for (const a of b.anchors) {
      try {
        // the registry keeps each anchor under the address that sent it. An anchor that records no sender predates ADR-0020 and
        // was sent by the key that signed the receipt it anchors, which after a rotation is not the key the chain ends with.
        const party = (a.party ?? gatewayKeyAt(keys, b.gateway.address, a.count - 1)) as Address;
        const blk = await client.readContract({ address: a.registry as Address, abi: ReceiptRegistryAbi, functionName: "anchoredAt", args: [party, a.head as Hex] });
        if (blk === 0n) {
          ok = false;
          detail.push(`${a.head.slice(0, 10)} not anchored`);
        } else detail.push(`${a.head.slice(0, 10)} @ block ${blk}`);
      } catch (e) {
        ok = false;
        detail.push(`${a.head.slice(0, 10)}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    report.checks.push({ check: "anchors.onchain", ok, detail: detail.join("; ") });
    report.ok = report.ok && ok;
  }
  return { ...report, bundle: b };
}

export function formatReport(r: VerifyReport): string {
  const lines = r.checks.map((c) => `  ${c.ok ? "PASS" : "FAIL"}  ${c.check}${c.detail ? `  (${c.detail})` : ""}`);
  return [`${r.ok ? "VERIFIED" : "FAILED"}: ${r.checks.filter((c) => c.ok).length}/${r.checks.length} checks`, ...lines].join("\n");
}
