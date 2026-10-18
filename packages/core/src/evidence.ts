import { z } from "zod";
import type { Address, Hex } from "viem";
import { canonicalize } from "./canonical.js";
import { PolicySchema, policyHash } from "./policy.js";
import { GatewayKeyChangeSchema, ReceiptSchema, verifyChain, type GatewayKeyChange, type Receipt } from "./receipt.js";
import { CaveatSchema, effectiveLimits, isSubsetOf, credentialId, type CredentialPublic } from "./credential.js";
import { verifyApprovalSignature, type ApprovalVerdict } from "./approval.js";

/**
 * An evidence bundle is everything an auditor needs to re-verify a principal's payment history offline:
 * every policy version (with hashes and activation times), the public view of every credential, the approver
 * keys (the current ones, and every key each approver held in this chain), the signed receipt chain with every
 * change of the gateway key in it, and the on-chain anchors. It deliberately omits credential signatures (bearer
 * secrets) and session private keys.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** One key an approver held in a principal's receipt chain (ADR-0019). */
export const ApproverKeySchema = z.object({
  address: z.string().regex(ADDRESS).nullable(), // null: the approver was removed and has no key from here on
  seq: z.number().int().nonnegative(), // position of the receipt that registered it: the key is in force after it
  effectiveFrom: z.string().datetime(), // that receipt's timestamp
  receiptId: z.string().min(1),
});
export type ApproverKey = z.infer<typeof ApproverKeySchema>;

/**
 * Every approver's keys in chain order, read from the `approver.registered` and `approver.removed` receipts. The
 * gateway exports this as `approverHistory`; the verifier recomputes it from the receipts and requires the export to
 * match. Malformed receipts are left out here and reported by `verifyBundle`.
 */
export function approverKeyHistory(receipts: readonly Receipt[]): Record<string, ApproverKey[]> {
  const out = new Map<string, ApproverKey[]>();
  for (const r of receipts) {
    const k = approverKeyOf(r);
    if (!k) continue;
    const list = out.get(k.approverId) ?? [];
    list.push(k.key);
    out.set(k.approverId, list);
  }
  return Object.fromEntries(out);
}

function approverKeyOf(r: Receipt): { approverId: string; key: ApproverKey } | null {
  if (r.kind !== "approver.registered" && r.kind !== "approver.removed") return null;
  const d = r.data as { approverId?: unknown; address?: unknown };
  if (typeof d.approverId !== "string" || !d.approverId) return null;
  const address = r.kind === "approver.registered" ? d.address : null;
  if (address !== null && !(typeof address === "string" && ADDRESS.test(address))) return null;
  return { approverId: d.approverId, key: { address, seq: r.seq, effectiveFrom: r.ts, receiptId: r.id } };
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const sameAddress = (a: string | null, b: string | null) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

export const CredentialPublicSchema = z.object({
  v: z.literal(1),
  id: z.string(),
  rootId: z.string(),
  principalId: z.string(),
  agentId: z.string(),
  parentId: z.string().nullable(),
  caveats: z.array(CaveatSchema),
});

export const PolicyVersionSchema = z.object({
  version: z.number().int().positive(),
  hash: z.string().regex(/^0x[0-9a-f]{64}$/),
  prevHash: z.string().regex(/^0x[0-9a-f]{64}$/).nullable(),
  activatedAt: z.string().datetime(),
  activatedBy: z.string().optional(),
  document: PolicySchema,
});
export type PolicyVersion = z.infer<typeof PolicyVersionSchema>;

export const EvidenceBundleSchema = z.object({
  v: z.literal(1),
  principalId: z.string(),
  exportedAt: z.string().datetime(),
  gateway: z.object({ address: z.string(), chain: z.string() }), // address: the key in force at the end of the chain
  gatewayKeyHistory: z.array(GatewayKeyChangeSchema).default([]), // every change of the gateway key in this chain (ADR-0020)
  contracts: z.record(z.string()),
  policy: z.object({ hash: z.string(), document: PolicySchema }), // the active version
  policyVersions: z.array(PolicyVersionSchema).default([]),
  approvers: z.record(z.string()).default({}), // approver id -> address, as configured at export
  approverHistory: z.record(z.array(ApproverKeySchema)).default({}), // approver id -> every key it held in this chain
  credentials: z.array(CredentialPublicSchema),
  receipts: z.array(ReceiptSchema),
  anchors: z.array(
    // party: the address that sent the anchor, under which the registry keeps it (absent on anchors from before ADR-0020)
    z.object({ head: z.string(), count: z.number().int(), txHash: z.string(), blockNumber: z.string(), registry: z.string(), party: z.string().optional() }),
  ),
});
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;

export interface VerifyReport {
  ok: boolean;
  checks: Array<{ check: string; ok: boolean; detail?: string }>;
}

export interface BundleVerifyOptions {
  /**
   * Gateway keys the auditor already trusts: published by the operator, or pinned from an earlier bundle. When given, the
   * `gateway.trusted` check requires every key that signed part of the chain to be one of them, or linked to one of them
   * by handovers (ADR-0022). Without it, a rotation without a handover fails that check.
   */
  trustedGatewayKeys?: readonly string[];
}

/** Offline verification. Needs no RPC. (Anchor existence on-chain is checked separately with an RPC.) */
export async function verifyBundle(bundle: EvidenceBundle, opts: BundleVerifyOptions = {}): Promise<VerifyReport> {
  const checks: VerifyReport["checks"] = [];
  const push = (check: string, ok: boolean, detail?: string) => checks.push({ check, ok, detail });

  const parsed = EvidenceBundleSchema.safeParse(bundle);
  push("schema", parsed.success, parsed.success ? undefined : parsed.error.issues[0]?.message);
  if (!parsed.success) return { ok: false, checks };
  bundle = parsed.data;

  // active policy hash
  const ph = policyHash(bundle.policy.document);
  push("policy.hash", ph === bundle.policy.hash, `${ph} vs ${bundle.policy.hash}`);

  // policy versions: hashes recompute, prev links chain, numbering is sequential, active = last
  const versions = [...bundle.policyVersions].sort((a, b) => a.version - b.version);
  const vProblems: string[] = [];
  versions.forEach((v, i) => {
    if (policyHash(v.document) !== v.hash) vProblems.push(`v${v.version}: hash mismatch`);
    if (v.version !== i + 1) vProblems.push(`v${v.version}: expected v${i + 1}`);
    const expectedPrev = i === 0 ? null : versions[i - 1]!.hash;
    if (v.prevHash !== expectedPrev) vProblems.push(`v${v.version}: prevHash link broken`);
    if (i > 0 && new Date(v.activatedAt) < new Date(versions[i - 1]!.activatedAt)) vProblems.push(`v${v.version}: activated before v${i - 1 + 1}`);
  });
  if (versions.length && versions[versions.length - 1]!.hash !== bundle.policy.hash) vProblems.push("active policy is not the latest version");
  push("policy.versions", vProblems.length === 0, vProblems.join("; ") || `${versions.length} versions`);

  // receipts chain + signatures, each against the gateway key in force at its position
  const chain = await verifyChain(bundle.receipts, bundle.gateway.address);
  push("receipts.chain", chain.ok, chain.problems.slice(0, 5).join("; ") || `${bundle.receipts.length} receipts`);

  // gateway key history (ADR-0020): the export must match the rotations in the receipts. Reported only when there is a
  // rotation or an exported change, so a bundle without either gets exactly the report it got before key history.
  if (chain.keys.length > 0 || bundle.gatewayKeyHistory.length > 0) {
    const matches = canonicalize(bundle.gatewayKeyHistory) === canonicalize(chain.keys);
    push("gateway.keys", matches, matches ? describeKeys(chain.keys) : "gatewayKeyHistory does not match the receipts");
  }
  if (opts.trustedGatewayKeys) {
    const t = trustOf(chain, bundle.gateway.address, bundle.receipts.length, opts.trustedGatewayKeys);
    push("gateway.trusted", t.ok, t.detail);
  } else {
    // Without pinned keys, a rotation that no handover vouches for fails: the chain is consistent, but nothing shows that
    // the keys on both sides belong to one gateway (ADR-0022). Handovers alone keep the report as it was.
    const gap = chain.keys.find((k) => !k.handedOver);
    if (gap) push("gateway.trusted", false, `rotation without a handover at #${gap.seq} (${short(gap.prevAddress)} → ${short(gap.address)}): pin the gateway keys you trust`);
  }

  // every receipt that cites a policy hash cites the version that was active at its timestamp
  const activeAt = (ts: string): string | null => {
    if (versions.length === 0) return bundle.policy.hash;
    const t = new Date(ts).getTime();
    let cur: PolicyVersion | null = null;
    for (const v of versions) if (new Date(v.activatedAt).getTime() <= t) cur = v;
    return cur ? cur.hash : null;
  };
  const stale = bundle.receipts.filter((r) => r.policyHash && r.policyHash !== activeAt(r.ts));
  push("receipts.policyHash", stale.length === 0, stale.length ? `${stale.length} receipts cite a policy that was not active at their time (e.g. ${stale[0]!.id})` : undefined);

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
      const prefix = p.caveats.every((pc, i) => JSON.stringify(pc) === JSON.stringify(c.caveats[i]));
      if (!prefix) {
        monoOk = false;
        monoDetail.push(`${c.id}: caveat chain does not extend parent`);
      }
    }
  }
  push("credentials.ids", idOk);
  push("credentials.monotonic", monoOk, monoDetail.join("; ") || `${bundle.credentials.length} credentials`);

  // anchors reference receipts that exist in the chain at the stated count. An anchor that names its sender must be one the
  // chain records: an `evidence.anchored` receipt, signed like every receipt, with the same head, count, sender and
  // transaction. The sender is the gateway's on-chain key, which need not be the key that signs receipts (ADR-0023).
  const anchorId = (x: { head?: unknown; count?: unknown; party?: unknown; txHash?: unknown }) => `${String(x.head).toLowerCase()}|${String(x.count)}|${String(x.party).toLowerCase()}|${String(x.txHash).toLowerCase()}`;
  const recorded = new Set(bundle.receipts.filter((r) => r.kind === "evidence.anchored").map((r) => anchorId(r.data)));
  let anchorsOk = true;
  const anchorDetail: string[] = [];
  for (const a of bundle.anchors) {
    const r = bundle.receipts[a.count - 1];
    if (!r || r.hash !== a.head) {
      anchorsOk = false;
      anchorDetail.push(`anchor ${a.head.slice(0, 10)} does not match receipt #${a.count}`);
    } else if (a.party !== undefined && !recorded.has(anchorId(a))) {
      anchorsOk = false;
      anchorDetail.push(`anchor ${a.head.slice(0, 10)} sent by ${a.party} is not recorded by an evidence.anchored receipt`);
    }
  }
  push("anchors.match", anchorsOk, anchorDetail.join("; ") || `${bundle.anchors.length} anchors`);

  // settlements: each settled payment must be preceded by an allow decision for the same intent
  const allowed = new Set(
    bundle.receipts.filter((r) => r.kind === "decision" && (r.data as { effect?: string }).effect === "allow").map((r) => r.intentId),
  );
  const orphan = bundle.receipts.filter((r) => r.kind === "payment.settled" && !allowed.has(r.intentId));
  push("settlements.have_allow_decision", orphan.length === 0, orphan.map((r) => r.id).join(",") || undefined);

  // approver key history (ADR-0019): `approver.registered` / `approver.removed` receipts say which key each approver
  // held from which position in the chain. Each must name the key it replaces, and the export must match the receipts.
  const keyHistory = new Map(Object.entries(approverKeyHistory(bundle.receipts)));
  const historyProblems: string[] = [];
  const held = new Map<string, string | null>();
  for (const r of bundle.receipts) {
    if (r.kind !== "approver.registered" && r.kind !== "approver.removed") continue;
    const k = approverKeyOf(r);
    if (!k) {
      historyProblems.push(`${r.id}: malformed ${r.kind}`);
      continue;
    }
    const before = held.get(k.approverId) ?? null;
    const prev = (r.data as { prevAddress?: unknown }).prevAddress;
    if (r.kind === "approver.removed" && before === null) historyProblems.push(`${r.id}: removes ${k.approverId}, which has no key`);
    else if (!sameAddress(typeof prev === "string" ? prev : null, before)) historyProblems.push(`${r.id}: prevAddress is not the key ${k.approverId} held before it`);
    held.set(k.approverId, k.key.address);
  }
  const exportedHistory = new Map(Object.entries(bundle.approverHistory));
  for (const id of new Set([...keyHistory.keys(), ...exportedHistory.keys()])) {
    if (canonicalize(exportedHistory.get(id) ?? []) !== canonicalize(keyHistory.get(id) ?? [])) historyProblems.push(`approverHistory.${id} does not match the receipts`);
  }
  const historySummary = [...keyHistory].map(([id, ks]) => `${id}: ${ks.map((k) => `${k.address ? short(k.address) : "removed"} from #${k.seq}`).join(", ")}`).join("; ");
  push("approvers.history", historyProblems.length === 0, historyProblems.join("; ") || historySummary || "none: signed approvals verify against the approvers map");

  // The key an approver held at a position: the last one registered before it. A resolution written before the chain had
  // any key history (an older gateway, or a store from before the upgrade) uses the approver's first registered key, or
  // the `approvers` map when the chain never registered that approver: bundles without history verify as they always did.
  const firstKeySeq = [...keyHistory.values()].reduce((m, ks) => Math.min(m, ks[0]?.seq ?? Infinity), Infinity);
  const keyAt = (approverId: string, seq: number): { address: string; basis: "history" | "first" | "map" } | { address: null; why: string } => {
    const keys = keyHistory.get(approverId) ?? [];
    const inForce = keys.filter((k) => k.seq < seq).pop();
    if (inForce) return inForce.address ? { address: inForce.address, basis: "history" } : { address: null, why: `approver ${approverId} was removed at #${inForce.seq}` };
    if (firstKeySeq < seq) return { address: null, why: `approver ${approverId} had no registered key at #${seq}` };
    if (keys[0]) return keys[0].address ? { address: keys[0].address, basis: "first" } : { address: null, why: `approver ${approverId} not registered` };
    const mapped = Object.hasOwn(bundle.approvers, approverId) ? bundle.approvers[approverId] : undefined;
    return mapped ? { address: mapped, basis: "map" } : { address: null, why: `approver ${approverId} not registered` };
  };

  // approvals: each signed resolution verifies against the key its approver held at that point; consumed approvals were granted
  const approvalProblems: string[] = [];
  const granted = new Set<string>();
  let signedCount = 0;
  const basisCount = { first: 0, map: 0 };
  for (const r of bundle.receipts) {
    if (r.kind === "approval.granted" || r.kind === "approval.rejected") {
      const d = r.data as { approver?: { id?: unknown; method?: unknown; address?: unknown; signature?: unknown }; approval?: { id: string; principalId: string; intentHash: string; amount: string } };
      if (r.kind === "approval.granted" && r.approvalId) granted.add(r.approvalId);
      if (d.approver?.method === "signature") {
        const id = typeof d.approver.id === "string" ? d.approver.id : "";
        const key = keyAt(id, r.seq);
        const verdict: ApprovalVerdict = r.kind === "approval.granted" ? "approve" : "reject";
        if (key.address === null) approvalProblems.push(`${r.id}: ${key.why}`);
        else if (typeof d.approver.signature !== "string" || !d.approval) approvalProblems.push(`${r.id}: missing signature or approval data`);
        else if (d.approver.address !== undefined && !(typeof d.approver.address === "string" && sameAddress(d.approver.address, key.address))) approvalProblems.push(`${r.id}: approver address mismatch (${id} held ${short(key.address)} at #${r.seq})`);
        else {
          signedCount++;
          if (key.basis !== "history") basisCount[key.basis]++;
          const ok = await verifyApprovalSignature(d.approval, verdict, d.approver.signature as Hex, key.address as Address);
          if (!ok) approvalProblems.push(`${r.id}: approver signature invalid`);
        }
      }
    }
  }
  const consumedWithoutGrant = bundle.receipts.filter((r) => r.kind === "approval.consumed" && (!r.approvalId || !granted.has(r.approvalId)));
  if (consumedWithoutGrant.length) approvalProblems.push(`${consumedWithoutGrant.length} approvals consumed without a grant`);
  const basis = [basisCount.first ? `${basisCount.first} from before key history` : "", basisCount.map ? `${basisCount.map} against the approvers map` : ""].filter(Boolean).join(", ");
  push("approvals", approvalProblems.length === 0, approvalProblems.join("; ") || `${granted.size} granted, ${signedCount} signature-verified${basis ? `; ${basis}` : ""}`);

  return { ok: checks.every((c) => c.ok), checks };
}

/** "0xf39F…2266 from #0; 0x7099…79C8 from #4 (handed over)": every key that signed the chain, from where. */
function describeKeys(keys: GatewayKeyChange[]): string {
  const first = keys[0] ? [`${short(keys[0].prevAddress)} from #0`] : [];
  return [...first, ...keys.map((k) => `${short(k.address)} from #${k.seq} (${k.handedOver ? "handed over" : "no handover"})`)].join("; ");
}

/**
 * Whether every key that signed part of the chain is trusted, or linked to a trusted key by an unbroken run of handovers in
 * either direction (ADR-0022). A handover is the old key's signature and its rotation receipt the new key's, so a valid
 * handover next to a trusted key vouches for the key on its other side; a rotation without a handover vouches for neither.
 * Trusting only the key the chain ends with is not enough: a gateway that continued a chain without checking its head
 * would have signed over receipts it never wrote.
 */
function trustOf(chain: { ok: boolean; keys: GatewayKeyChange[] }, gatewayAddress: string, receiptCount: number, trustedKeys: readonly string[]): { ok: boolean; detail: string } {
  if (!chain.ok) return { ok: false, detail: "the receipt chain does not verify" };
  if (receiptCount === 0) return { ok: true, detail: "no receipts" };
  const trusted = new Set(trustedKeys.map((a) => a.toLowerCase()));
  // one segment per key in force: the first key from #0, then each rotation's key from its own position
  const segments = [{ key: chain.keys[0]?.prevAddress ?? gatewayAddress, from: 0 }, ...chain.keys.map((k) => ({ key: k.address, from: k.seq }))];
  const linked = (i: number) => chain.keys[i - 1]?.handedOver === true; // segment i was handed over from segment i - 1
  const vouched = segments.map((s) => trusted.has(s.key.toLowerCase()));
  for (let i = 1; i < segments.length; i++) if (!vouched[i] && vouched[i - 1] && linked(i)) vouched[i] = true;
  for (let i = segments.length - 2; i >= 0; i--) if (!vouched[i] && vouched[i + 1] && linked(i + 1)) vouched[i] = true;
  const bad = vouched.indexOf(false);
  if (bad >= 0) {
    const s = segments[bad]!;
    const to = (segments[bad + 1]?.from ?? receiptCount) - 1;
    return { ok: false, detail: `receipts #${s.from}–#${to} were signed by ${short(s.key)}, which is neither trusted nor linked to a trusted key by handovers` };
  }
  const names = (pinned: boolean) => [...new Set(segments.filter((s) => trusted.has(s.key.toLowerCase()) === pinned).map((s) => short(s.key)))];
  const handed = names(false);
  return { ok: true, detail: `trusted ${names(true).join(", ")}${handed.length ? `; handed over ${handed.join(", ")}` : ""}` };
}

export type { CredentialPublic, Receipt };
