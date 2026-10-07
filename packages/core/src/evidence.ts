import { z } from "zod";
import { PolicySchema, policyHash } from "./policy.js";
import { ReceiptSchema, verifyChain } from "./receipt.js";
import { CaveatSchema, effectiveLimits, isSubsetOf, credentialId, type CredentialPublic } from "./credential.js";

/**
 * An evidence bundle is everything an auditor needs to re-verify a principal's payment history offline:
 * the policy (and its hash), the public view of every credential, the signed receipt chain, and the on-chain
 * anchors. It deliberately omits credential signatures (bearer secrets) and session private keys.
 */

export const CredentialPublicSchema = z.object({
  v: z.literal(1),
  id: z.string(),
  rootId: z.string(),
  principalId: z.string(),
  agentId: z.string(),
  parentId: z.string().nullable(),
  caveats: z.array(CaveatSchema),
});

export const EvidenceBundleSchema = z.object({
  v: z.literal(1),
  principalId: z.string(),
  exportedAt: z.string().datetime(),
  gateway: z.object({ address: z.string(), chain: z.string() }),
  contracts: z.record(z.string()),
  policy: z.object({ hash: z.string(), document: PolicySchema }),
  credentials: z.array(CredentialPublicSchema),
  receipts: z.array(ReceiptSchema),
  anchors: z.array(
    z.object({ head: z.string(), count: z.number().int(), txHash: z.string(), blockNumber: z.string(), registry: z.string() }),
  ),
});
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;

export interface VerifyReport {
  ok: boolean;
  checks: Array<{ check: string; ok: boolean; detail?: string }>;
}

/** Offline verification. Needs no RPC. (Anchor existence on-chain is checked separately with an RPC.) */
export async function verifyBundle(bundle: EvidenceBundle): Promise<VerifyReport> {
  const checks: VerifyReport["checks"] = [];
  const push = (check: string, ok: boolean, detail?: string) => checks.push({ check, ok, detail });

  const parsed = EvidenceBundleSchema.safeParse(bundle);
  push("schema", parsed.success, parsed.success ? undefined : parsed.error.issues[0]?.message);
  if (!parsed.success) return { ok: false, checks };

  // policy hash
  const ph = policyHash(bundle.policy.document);
  push("policy.hash", ph === bundle.policy.hash, `${ph} vs ${bundle.policy.hash}`);

  // receipts chain + signatures
  const chain = await verifyChain(bundle.receipts, bundle.gateway.address);
  push("receipts.chain", chain.ok, chain.problems.slice(0, 5).join("; ") || `${bundle.receipts.length} receipts`);

  // every receipt that cites a policy hash cites this policy
  const stale = bundle.receipts.filter((r) => r.policyHash && r.policyHash !== bundle.policy.hash);
  push("receipts.policyHash", stale.length === 0, stale.length ? `${stale.length} receipts cite another policy version` : undefined);

  // credentials: ids derive from caveats; every child is a subset of its parent
  const byId = new Map(bundle.credentials.map((c) => [c.id, c]));
  let idOk = true;
  let monoOk = true;
  const monoDetail: string[] = [];
  for (const c of bundle.credentials) {
    if (credentialId(c) !== c.id) idOk = false;
    if (c.parentId) {
      const p = byId.get(c.parentId);
      if (!p) {
        monoOk = false;
        monoDetail.push(`${c.id}: parent missing`);
        continue;
      }
      const r = isSubsetOf(effectiveLimits(c.caveats), effectiveLimits(p.caveats));
      if (!r.ok) {
        monoOk = false;
        monoDetail.push(`${c.id}: wider than parent in ${r.violations.join(",")}`);
      }
      // structural: child's caveats must extend parent's caveats
      const prefix = p.caveats.every((pc, i) => JSON.stringify(pc) === JSON.stringify(c.caveats[i]));
      if (!prefix) {
        monoOk = false;
        monoDetail.push(`${c.id}: caveat chain does not extend parent`);
      }
    }
  }
  push("credentials.ids", idOk);
  push("credentials.monotonic", monoOk, monoDetail.join("; ") || `${bundle.credentials.length} credentials`);

  // anchors reference receipts that exist in the chain at the stated count
  let anchorsOk = true;
  const anchorDetail: string[] = [];
  for (const a of bundle.anchors) {
    const r = bundle.receipts[a.count - 1];
    if (!r || r.hash !== a.head) {
      anchorsOk = false;
      anchorDetail.push(`anchor ${a.head.slice(0, 10)} does not match receipt #${a.count}`);
    }
  }
  push("anchors.match", anchorsOk, anchorDetail.join("; ") || `${bundle.anchors.length} anchors`);

  // settlements: each settled payment must be preceded by an allow decision for the same intent
  const allowed = new Set(
    bundle.receipts.filter((r) => r.kind === "decision" && (r.data as { effect?: string }).effect === "allow").map((r) => r.intentId),
  );
  const orphan = bundle.receipts.filter((r) => r.kind === "payment.settled" && !allowed.has(r.intentId));
  push("settlements.have_allow_decision", orphan.length === 0, orphan.map((r) => r.id).join(",") || undefined);

  return { ok: checks.every((c) => c.ok), checks };
}

export type { CredentialPublic };
