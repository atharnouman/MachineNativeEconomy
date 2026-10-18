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
 * ledger). Versions are numbered in the store, which refuses a number already taken, so two updates at once (in one
 * gateway or two) never both become version N (ADR-0025).
 */
export class PolicyService {
  readonly ready: Promise<void>;

  constructor(
    private readonly store: Store,
    private readonly receipts: ReceiptLog,
    seed: { yaml: string; by: string },
  ) {
    this.ready = this.seed(parsePolicyYaml(seed.yaml), seed);
  }

  /** Records the configured document: version 1 on a first run, an update when it changed since the last one. */
  private async seed(doc: Policy, seed: { yaml: string; by: string }): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const latest = (await this.store.policyVersions(doc.principalId)).at(-1);
      try {
        if (!latest) {
          const v: PolicyVersion = { version: 1, hash: policyHash(doc), prevHash: null, activatedAt: nowIso(), activatedBy: seed.by, document: doc };
          if (!(await this.store.addPolicyVersion(doc.principalId, v))) throw Object.assign(new Error("version 1 taken"), { statusCode: 409 });
          await this.receipts.append(doc.principalId, "policy.updated", { version: 1, prevHash: null, hash: v.hash, activatedBy: seed.by, diff: null, impact: [] }, { policyHash: v.hash });
        } else if (latest.hash !== policyHash(doc)) {
          // the configured document changed since the last run: that is a policy update, and it is receipted
          await this.update(doc.principalId, seed.yaml, seed.by);
        }
        return;
      } catch (err) {
        // another gateway instance recorded a version first: look again (it may be this very document)
        if ((err as { statusCode?: number }).statusCode !== 409 || attempt >= 3) throw err;
      }
    }
  }

  versions(principalId: string): Promise<PolicyVersion[]> {
    return this.store.policyVersions(principalId);
  }

  async activeVersion(principalId: string): Promise<PolicyVersion> {
    const v = (await this.store.policyVersions(principalId)).at(-1);
    if (!v) throw Object.assign(new Error(`no policy for principal ${principalId}`), { statusCode: 404 });
    return v;
  }

  async active(principalId: string): Promise<Policy> {
    return (await this.activeVersion(principalId)).document;
  }

  async update(principalId: string, yaml: string, by: string): Promise<PolicyUpdateResult> {
    const doc = parsePolicyYaml(yaml);
    if (doc.principalId !== principalId) throw Object.assign(new Error(`policy principalId ${doc.principalId} does not match ${principalId}`), { statusCode: 400 });
    const prev = await this.activeVersion(principalId);
    const hash = policyHash(doc);
    if (hash === prev.hash) throw Object.assign(new Error("policy unchanged"), { statusCode: 409 });
    const diff = diffPolicies(prev.document, doc);
    const impact = await this.impact(principalId, doc);
    const version: PolicyVersion = { version: prev.version + 1, hash, prevHash: prev.hash, activatedAt: nowIso(), activatedBy: by, document: doc };
    if (!(await this.store.addPolicyVersion(principalId, version))) {
      throw Object.assign(new Error(`version ${version.version} of the policy of ${principalId} was recorded by another update first; try again`), { statusCode: 409 });
    }
    await this.receipts.append(principalId, "policy.updated", { version: version.version, prevHash: prev.hash, hash, activatedBy: by, diff, impact }, { policyHash: hash });
    return { version, diff, impact };
  }

  /**
   * Re-run recently allowed intents under a candidate policy against an empty ledger, so the result reflects
   * rule and caveat changes rather than how much has been spent since. Advisory.
   */
  async impact(principalId: string, candidate: Policy, n = 50): Promise<PolicyUpdateResult["impact"]> {
    const ledger: SpendLedgerView = { spentByCredential: () => 0n, spentByBudget: () => 0n, activity: () => ({ count: 0, amount: 0n }) };
    const out: PolicyUpdateResult["impact"] = [];
    for (const rec of await this.store.recentIntents(principalId, n)) {
      if (rec.effect !== "allow") continue;
      const reg = await this.store.getCredential(rec.intent.credentialId);
      if (!reg) continue;
      const cred: Credential = { v: 1, rootId: reg.rootId, principalId: reg.principalId, caveats: reg.caveats, sig: "" };
      const d = evaluate({ policy: candidate, intent: rec.intent, credential: cred, amountBase: BigInt(rec.amount), rail: rec.intent.rail, ledger, killSwitch: false });
      if (d.effect !== "allow") out.push({ intentId: rec.intent.id, resource: rec.intent.resource, amount: rec.amount, wasEffect: "allow", nowEffect: d.effect, reasons: d.reasons });
    }
    return out;
  }
}
