import {
  parsePolicyYaml,
  policyHash,
  diffPolicies,
  evaluate,
  nowIso,
  type Policy,
  type PolicyVersion,
  type Credential,
  type SpendLedgerView,
} from "@spendmarshal/core";
import type { Store } from "./store.js";
import type { ReceiptLog } from "./receipts.js";

export interface PolicyUpdateResult {
  version: PolicyVersion;
  diff: ReturnType<typeof diffPolicies>;
  impact: Array<{ intentId: string; resource: string; amount: string; wasEffect: string; nowEffect: string; reasons: string[] }>;
}

/**
 * Policy versions. The active policy for a principal is the latest version; every activation is a
 * `policy.updated` receipt carrying the previous and new hash, the structural diff, and an impact analysis
 * (which recently allowed intents would be denied or escalated under the new document, against the current
 * ledger).
 */
export class PolicyService {
  readonly ready: Promise<void>;

  constructor(
    private readonly store: Store,
    private readonly receipts: ReceiptLog,
    seed: { yaml: string; by: string },
  ) {
    const doc = parsePolicyYaml(seed.yaml);
    const existing = store.policyVersions(doc.principalId);
    const latest = existing[existing.length - 1];
    if (!latest) {
      // first run: version 1 is recorded synchronously so decisions can start immediately; the receipt follows
      const v: PolicyVersion = { version: 1, hash: policyHash(doc), prevHash: null, activatedAt: nowIso(), activatedBy: seed.by, document: doc };
      store.addPolicyVersion(doc.principalId, v);
      this.ready = receipts.append(doc.principalId, "policy.updated", { version: 1, prevHash: null, hash: v.hash, activatedBy: seed.by, diff: null, impact: [] }, { policyHash: v.hash }).then(() => undefined);
    } else if (latest.hash !== policyHash(doc)) {
      // the configured document changed since the last run: that is a policy update, and it is receipted
      this.ready = this.update(doc.principalId, seed.yaml, seed.by).then(() => undefined);
    } else {
      this.ready = Promise.resolve();
    }
  }

  versions(principalId: string): PolicyVersion[] {
    return this.store.policyVersions(principalId);
  }

  activeVersion(principalId: string): PolicyVersion {
    const vs = this.store.policyVersions(principalId);
    const v = vs[vs.length - 1];
    if (!v) throw Object.assign(new Error(`no policy for principal ${principalId}`), { statusCode: 404 });
    return v;
  }

  active(principalId: string): Policy {
    return this.activeVersion(principalId).document;
  }

  async update(principalId: string, yaml: string, by: string): Promise<PolicyUpdateResult> {
    const doc = parsePolicyYaml(yaml);
    if (doc.principalId !== principalId) throw Object.assign(new Error(`policy principalId ${doc.principalId} does not match ${principalId}`), { statusCode: 400 });
    const prev = this.activeVersion(principalId);
    const hash = policyHash(doc);
    if (hash === prev.hash) throw Object.assign(new Error("policy unchanged"), { statusCode: 409 });
    const diff = diffPolicies(prev.document, doc);
    const impact = this.impact(principalId, doc);
    const version: PolicyVersion = { version: prev.version + 1, hash, prevHash: prev.hash, activatedAt: nowIso(), activatedBy: by, document: doc };
    this.store.addPolicyVersion(principalId, version);
    await this.receipts.append(principalId, "policy.updated", { version: version.version, prevHash: prev.hash, hash, activatedBy: by, diff, impact }, { policyHash: hash });
    return { version, diff, impact };
  }

  /**
   * Re-run recently allowed intents under a candidate policy against an empty ledger, so the result reflects
   * rule and caveat changes rather than how much has been spent since. Advisory.
   */
  impact(principalId: string, candidate: Policy, n = 50): PolicyUpdateResult["impact"] {
    const ledger: SpendLedgerView = { spentByCredential: () => 0n, spentByBudget: () => 0n, activity: () => ({ count: 0, amount: 0n }) };
    const out: PolicyUpdateResult["impact"] = [];
    for (const rec of this.store.recentIntents(principalId, n)) {
      if (rec.effect !== "allow") continue;
      const reg = this.store.getCredential(rec.intent.credentialId);
      if (!reg) continue;
      const cred: Credential = { v: 1, rootId: reg.rootId, principalId: reg.principalId, caveats: reg.caveats, sig: "" };
      const d = evaluate({ policy: candidate, intent: rec.intent, credential: cred, amountBase: BigInt(rec.amount), rail: rec.intent.rail, ledger, killSwitch: false });
      if (d.effect !== "allow") out.push({ intentId: rec.intent.id, resource: rec.intent.resource, amount: rec.amount, wasEffect: "allow", nowEffect: d.effect, reasons: d.reasons });
    }
    return out;
  }
}
