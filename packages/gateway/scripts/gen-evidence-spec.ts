/**
 * Writes the evidence format v1 test vectors (docs/spec/vectors/*.json) and the bundle's JSON Schema
 * (docs/spec/evidence-v1.schema.json) from the real gateway (ADR-0026).
 *
 * Every vector states which checks it is meant to fail; generation stops if the reference verifier disagrees. The clock
 * and the random ids are fixed, so running it again writes the same bytes.
 *
 * Run after `pnpm build`:  npx tsx packages/gateway/scripts/gen-evidence-spec.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── a fixed clock and seeded ids, before anything reads them ──
const RealDate = Date;
let clock = RealDate.parse("2026-10-18T09:00:00.000Z");
const tick = () => {
  const t = clock;
  clock += 1000;
  return t;
};
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(tick());
    else super(...(args as [string | number]));
  }
  static override now() {
    return tick();
  }
}
globalThis.Date = FixedDate as unknown as DateConstructor;
let seed = 0x5eed1;
const seeded = (arr: Uint8Array) => {
  for (let i = 0; i < arr.length; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    arr[i] = seed >>> 24;
  }
  return arr;
};
Object.defineProperty(globalThis.crypto, "getRandomValues", { value: seeded, configurable: true, writable: true });

const { buildGateway } = await import("../src/server.js");
const core = await import("@spendmarshal/core");
const { privateKeyToAccount } = await import("viem/accounts");
const { zodToJsonSchema } = await import("zod-to-json-schema");
type Gateway = Awaited<ReturnType<typeof buildGateway>>;
type GatewayConfig = Parameters<typeof buildGateway>[0];
type Bundle = import("@spendmarshal/core").EvidenceBundle;
type Receipt = import("@spendmarshal/core").Receipt;
type Hex = `0x${string}`;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SPEC = join(ROOT, "docs/spec");
const VECTORS = join(SPEC, "vectors");
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const ZERO32 = `0x${"0".repeat(64)}` as Hex;

// anvil's published development keys: never hold value
const KEY = {
  gatewayA: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  gatewayB: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  gatewayC: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  cfoA: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  cfoB: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  evidence: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  stranger: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
} as const satisfies Record<string, Hex>;
const account = (k: keyof typeof KEY) => privateKeyToAccount(KEY[k]);
const address = (k: keyof typeof KEY) => account(k).address;

const policy = (cap: string) => `
version: 1
principalId: org
budgets: { org: { cap: "${cap}", period: daily }, research: { cap: "0.50", parent: org } }
agents: { analyst: { budget: research } }
velocity: [{ id: burst, scope: agent, window: 1m, max_count: 5 }]
rules:
  - { id: big, effect: escalate, match: { amount_gt: "0.03" } }
  - { id: allow-all, effect: allow }
`;

function config(dataDir: string, over: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    rpcUrl: "http://127.0.0.1:1",
    chainId: 31337,
    gatewayPrivateKey: KEY.gatewayA,
    sessionSecret: "vectors-session-secret",
    credentialRootKey: "vectors-credential-root",
    adminToken: "vectors-admin-token",
    dataDir,
    storeDriver: "json",
    policyYaml: policy("1.00"),
    contracts: { usdc: ZERO, receiptRegistry: ZERO, enforcers: { spendLimit: ZERO, timeWindow: ZERO, allowedTargets: ZERO } },
    principals: { org: { account: ZERO } },
    asset: { symbol: "USDC", decimals: 6 },
    facilitator: { enabled: false },
    authorizationTtlSeconds: 120,
    ...over,
  };
}

/** A gateway whose anchors land without a chain: the registry has no earlier head, and each anchor gets a fixed tx. */
async function start(cfg: GatewayConfig): Promise<Gateway> {
  const gw = await buildGateway(cfg);
  await gw.ready;
  gw.chain.latestAnchorHead = async () => ZERO32;
  let anchors = 0;
  gw.chain.anchor = async () => ({ txHash: `0x${String(++anchors).padStart(64, "a")}` as Hex, blockNumber: BigInt(100 + anchors) });
  return gw;
}

const fresh = () => mkdtempSync(join(tmpdir(), "spendmarshal-vectors-"));
const exported = async (gw: Gateway): Promise<Bundle> => JSON.parse(JSON.stringify(await gw.exportEvidence("org"))) as Bundle;
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

async function activeHash(gw: Gateway): Promise<Hex> {
  return (await gw.policies.activeVersion("org")).hash as Hex;
}

/** An allow decision for a new intent, then its settlement: the pair every payment leaves in the chain. */
async function pay(gw: Gateway, intentId: string, amount = "20000") {
  const policyHash = await activeHash(gw);
  await gw.receipts.append("org", "decision", { stage: "quote", effect: "allow", reasons: [], checks: [], matchedRules: ["allow-all"], amount }, { agentId: "analyst", credentialId: "cred_vectors", intentId, rail: "x402", policyHash });
  await gw.receipts.append("org", "payment.settled", { txHash: `0x${"b".repeat(64)}`, blockNumber: "7", amount, payee: ZERO, payloadKind: "agent-account", ledgerEntryId: `led_${intentId}`, approvalId: null }, { agentId: "analyst", credentialId: "cred_vectors", intentId, rail: "x402", policyHash });
}

async function requestApproval(gw: Gateway, intentId: string) {
  const intent = {
    v: 1 as const,
    id: intentId,
    principalId: "org",
    agentId: "analyst",
    credentialId: "cred_vectors",
    payee: { url: "https://payee.example/v1/report", host: "payee.example", address: ZERO },
    resource: "/v1/report",
    maxAmount: { asset: "USDC", chain: "eip155:31337", token: ZERO, value: "40000", decimals: 6 },
    quotedAmount: { asset: "USDC", chain: "eip155:31337", token: ZERO, value: "40000", decimals: 6 },
    purpose: "research",
    rail: "x402" as const,
    createdAt: new Date().toISOString(),
  };
  const decision = { effect: "escalate" as const, reasons: ["RULE_ESCALATE:big"], checks: [], matchedRules: ["big"], budgetPath: ["research", "org"], policyHash: await activeHash(gw), amount: "40000" };
  return gw.approvals.request({ intent, decision, amount: 40_000n, rail: "x402", request: { method: "GET" } });
}

async function approveSigned(gw: Gateway, approvalId: string, signer: keyof typeof KEY) {
  const a = (await gw.store.getApproval(approvalId))!;
  return gw.approvals.resolve(approvalId, "approve", { id: "cfo", signature: await account(signer).signMessage({ message: core.approvalMessage(a, "approve") }) });
}

/** Re-links, re-hashes and re-signs receipts from `from` on, each with the key `keyFor` names: a forger holding keys. */
async function resign(receipts: Receipt[], from: number, keyFor: (i: number) => keyof typeof KEY) {
  for (let i = from; i < receipts.length; i++) {
    const r = receipts[i]!;
    const { hash: _h, sig: _s, ...body } = r;
    body.prev = (i === 0 ? null : receipts[i - 1]!.hash) as typeof body.prev;
    const hash = core.receiptHash(body);
    receipts[i] = { ...body, hash, sig: await account(keyFor(i)).signMessage({ message: { raw: hash } }) };
  }
}

interface Vector {
  name: string;
  description: string;
  bundle: Bundle;
  options?: { trustedGatewayKeys: string[] };
  /** the checks this vector is meant to fail; every other check must pass */
  fails: string[];
}
const vectors: Vector[] = [];
const add = (v: Vector) => vectors.push(v);

// ───────────────────────────── valid bundles, and what breaks them ─────────────────────────────

// 1. a principal's ordinary history: policy version 1, payments, an operator's note
{
  const gw = await start(config(fresh()));
  await pay(gw, "int_0001");
  await gw.receipts.append("org", "external", { source: "operator", note: "monthly review" });
  await gw.receipts.append("org", "external", { source: "operator", note: "budget unchanged" });
  await pay(gw, "int_0002", "15000");
  const b = await exported(gw);
  await gw.close();
  add({ name: "basic", description: "Policy version 1, two allowed and settled payments, two operator notes.", bundle: b, fails: [] });

  const tampered = copy(b);
  (tampered.receipts[2]!.data as Record<string, unknown>).note = "edited after signing";
  add({ name: "receipt-data-edited", description: "A receipt's data is edited; its hash no longer matches.", bundle: tampered, fails: ["receipts.chain"] });

  const rehashed = copy(b);
  (rehashed.receipts[2]!.data as Record<string, unknown>).note = "edited after signing";
  const { hash: _h, sig: _s, ...body } = rehashed.receipts[2]!;
  rehashed.receipts[2]!.hash = core.receiptHash(body);
  add({ name: "receipt-rehashed-not-resigned", description: "A receipt is edited and re-hashed, but the gateway did not sign the new hash.", bundle: rehashed, fails: ["receipts.chain"] });

  const removed = copy(b);
  removed.receipts.splice(3, 1);
  add({ name: "receipt-removed", description: "A receipt is removed from the middle of the chain.", bundle: removed, fails: ["receipts.chain"] });

  const swapped = copy(b);
  [swapped.receipts[3], swapped.receipts[4]] = [swapped.receipts[4]!, swapped.receipts[3]!];
  add({ name: "receipts-reordered", description: "Two receipts trade places.", bundle: swapped, fails: ["receipts.chain"] });

  const extra = copy(b);
  (extra.receipts[1] as Record<string, unknown>).memo = "not covered by the signature";
  add({ name: "receipt-unknown-member", description: "A receipt carries a member the format does not define, so its signature does not cover it.", bundle: extra, fails: ["schema"] });

  const unsigned = copy(b);
  delete (unsigned.receipts[0] as Partial<Receipt>).sig;
  add({ name: "receipt-missing-signature", description: "A receipt has no signature.", bundle: unsigned, fails: ["schema"] });

  const truncated = copy(b);
  truncated.receipts[1]!.sig = truncated.receipts[1]!.sig.slice(0, 66);
  add({ name: "receipt-signature-malformed", description: "A receipt's signature is 32 bytes instead of 65; verifiers report it, never crash.", bundle: truncated, fails: ["receipts.chain"] });

  const otherGateway = copy(b);
  otherGateway.gateway.address = address("stranger");
  add({ name: "wrong-gateway-key", description: "The bundle names a gateway key that signed none of the receipts.", bundle: otherGateway, fails: ["receipts.chain"] });

  const doc = copy(b);
  (doc.policy.document.budgets.org as { cap: string }).cap = "9.00";
  add({ name: "policy-document-edited", description: "The active policy document is edited; it no longer hashes to the recorded hash.", bundle: doc, fails: ["policy.hash"] });
}

// 2. a policy update, and receipts that cite each version while it was active
{
  const gw = await start(config(fresh()));
  await pay(gw, "int_0101");
  await gw.policies.update("org", policy("2.00"), "finance");
  await pay(gw, "int_0102");
  const b = await exported(gw);
  add({ name: "policy-versions", description: "Policy version 1, then version 2; each receipt cites the version active at its time.", bundle: b, fails: [] });

  const broken = copy(b);
  broken.policyVersions[1]!.prevHash = `0x${"c".repeat(64)}`;
  add({ name: "policy-version-link-broken", description: "Version 2 does not name version 1's hash as its predecessor.", bundle: broken, fails: ["policy.versions"] });

  // the gateway signs a receipt that cites the superseded version
  await gw.receipts.append("org", "decision", { stage: "quote", effect: "allow", reasons: [], checks: [], matchedRules: ["allow-all"], amount: "1000" }, { intentId: "int_0103", policyHash: b.policyVersions[0]!.hash });
  const stale = await exported(gw);
  await gw.close();
  add({ name: "receipt-cites-stale-policy", description: "A decision cites policy version 1 after version 2 was activated.", bundle: stale, fails: ["receipts.policyHash"] });
}

// 3. a settlement with no allow decision before it
{
  const gw = await start(config(fresh()));
  await pay(gw, "int_0201");
  await gw.receipts.append("org", "payment.settled", { txHash: `0x${"d".repeat(64)}`, blockNumber: "8", amount: "5000", payee: ZERO, payloadKind: "agent-account", ledgerEntryId: "led_orphan", approvalId: null }, { intentId: "int_0202", policyHash: await activeHash(gw) });
  const b = await exported(gw);
  await gw.close();
  add({ name: "settlement-without-decision", description: "A payment settles for an intent that no allow decision covers.", bundle: b, fails: ["settlements.have_allow_decision"] });
}

// 4. signed approvals, the approver's key history, and what breaks them
{
  const gw = await start(config(fresh(), { approvers: { cfo: address("cfoA") } }));
  const a = await requestApproval(gw, "int_0301");
  await approveSigned(gw, a.id, "cfoA");
  await pay(gw, "int_0301", "40000");
  await gw.approvals.consume(a.id, "int_0301", `0x${"b".repeat(64)}`);
  const b = await exported(gw);
  add({ name: "approval-signed", description: "An escalation approved with the CFO's registered key, then paid and consumed.", bundle: b, fails: [] });

  const history = copy(b);
  history.approverHistory.cfo![0]!.seq += 1;
  add({ name: "approver-history-edited", description: "The exported approver history does not match the approver receipts.", bundle: history, fails: ["approvers.history"] });

  // the gateway records a grant whose signature the registered key never made
  const forged = await requestApproval(gw, "int_0302");
  const view = gw.approvals.publicView({ ...forged, status: "approved" });
  const signature = await account("stranger").signMessage({ message: core.approvalMessage(forged, "approve") });
  await gw.receipts.append("org", "approval.granted", { approval: view, approver: { id: "cfo", method: "signature", address: address("cfoA"), signature }, note: null }, { intentId: forged.intentId, approvalId: forged.id });
  const bad = await exported(gw);

  // and a consumption of an approval that was never granted
  const pending = await requestApproval(gw, "int_0303");
  await gw.receipts.append("org", "approval.consumed", { approval: gw.approvals.publicView(pending), txHash: `0x${"e".repeat(64)}` }, { intentId: pending.intentId, approvalId: pending.id });
  const consumed = await exported(gw);
  await gw.close();
  // each case cut to its own chain: the forged grant first, then the consumption alone
  add({ name: "approval-signature-forged", description: "A grant carries a signature the CFO's key did not make.", bundle: bad, fails: ["approvals"] });
  const onlyConsumed = copy(consumed);
  const forgedAt = onlyConsumed.receipts.findIndex((r) => r.kind === "approval.granted" && r.approvalId === forged.id);
  onlyConsumed.receipts = onlyConsumed.receipts.slice(0, forgedAt);
  onlyConsumed.receipts.push(...consumed.receipts.slice(forgedAt + 1).filter((r) => r.approvalId === pending.id));
  await resign(onlyConsumed.receipts, forgedAt, () => "gatewayA");
  onlyConsumed.receipts.forEach((r, i) => (r.seq = i));
  await resign(onlyConsumed.receipts, 0, () => "gatewayA");
  add({ name: "approval-consumed-without-grant", description: "An approval is consumed although it was never granted.", bundle: onlyConsumed, fails: ["approvals"] });
}

// 5. the approver's key rotates between runs; older approvals keep verifying against the older key
{
  const dir = fresh();
  let gw = await start(config(dir, { approvers: { cfo: address("cfoA") } }));
  const first = await requestApproval(gw, "int_0401");
  await approveSigned(gw, first.id, "cfoA");
  await gw.close();
  gw = await start(config(dir, { approvers: { cfo: address("cfoB") } }));
  const second = await requestApproval(gw, "int_0402");
  await approveSigned(gw, second.id, "cfoB");
  const b = await exported(gw);
  await gw.close();
  add({ name: "approver-key-rotated", description: "The CFO's key changes between runs; each approval verifies against the key in force at its position.", bundle: b, fails: [] });
}

// 6. an approval from before the chain kept approver keys, checked against the bundle's approvers map
{
  const gw = await start(config(fresh()));
  const a = await requestApproval(gw, "int_0501");
  const signature = await account("cfoA").signMessage({ message: core.approvalMessage(a, "approve") });
  await gw.receipts.append("org", "approval.granted", { approval: gw.approvals.publicView({ ...a, status: "approved" }), approver: { id: "cfo", method: "signature", address: address("cfoA"), signature }, note: null }, { intentId: a.intentId, approvalId: a.id });
  const b = await exported(gw);
  await gw.close();
  b.approvers = { cfo: address("cfoA") };
  add({ name: "approval-legacy-map", description: "A signed approval in a chain without approver receipts verifies against the approvers map, as bundles from before key history do.", bundle: b, fails: [] });
}

// 7. delegated credentials
{
  const gw = await start(config(fresh()));
  const root = core.issueRoot({ rootKey: "vectors-credential-root", rootId: "root_vectors", principalId: "org", agentId: "analyst", nonce: "n-root", caveats: [{ type: "spend_cap", value: "500000" }, { type: "allowed_rails", value: ["x402", "mpp"] }] });
  const child = core.attenuate(root, [{ type: "per_tx_max", value: "50000" }, { type: "allowed_rails", value: ["x402"] }], { agentId: "fetcher", nonce: "n-child" });
  for (const [c, parent] of [[root, null], [child, root]] as const) {
    await gw.store.putCredential({ ...core.toPublic(c), sessionKey: ZERO, parentSessionKey: parent ? ZERO : null, registeredAt: new Date().toISOString(), txHash: ZERO32 });
  }
  const b = await exported(gw);
  await gw.close();
  add({ name: "credentials-delegated", description: "A root credential and a sub-agent's credential that only narrows it.", bundle: b, fails: [] });

  const id = copy(b);
  id.credentials[1]!.id = id.credentials[1]!.id.replace(/.$/, (ch) => (ch === "0" ? "1" : "0"));
  add({ name: "credential-id-edited", description: "A credential's id does not derive from its caveats.", bundle: id, fails: ["credentials.ids"] });

  const wider = copy(b);
  const caveats = [b.credentials[0]!.caveats[0]!, { type: "delegate" as const, agentId: "rogue", nonce: "n-rogue" }];
  wider.credentials.push({ v: 1, id: core.credentialId({ rootId: "root_vectors", caveats }), rootId: "root_vectors", principalId: "org", agentId: "rogue", parentId: b.credentials[0]!.id, caveats });
  add({ name: "credential-wider-than-parent", description: "A sub-agent's credential drops its parent's caps instead of extending them.", bundle: wider, fails: ["credentials.monotonic"] });
}

// 8. the gateway key changes with a handover from the old key
{
  const dir = fresh();
  let gw = await start(config(dir));
  await pay(gw, "int_0601");
  await gw.close();
  gw = await start(config(dir, { gatewayPrivateKey: KEY.gatewayB, previousGatewayKeys: [KEY.gatewayA] }));
  await pay(gw, "int_0602");
  const b = await exported(gw);
  await gw.close();
  add({ name: "gateway-key-handover", description: "The gateway key changes; the old key signs the handover, so no key needs pinning.", bundle: b, fails: [] });
  add({ name: "gateway-key-handover-pinned", description: "The same chain with the old key pinned: the new key is trusted through the handover.", bundle: b, options: { trustedGatewayKeys: [address("gatewayA")] }, fails: [] });
  add({ name: "gateway-key-handover-wrong-pin", description: "The same chain, pinned to a key that never signed it.", bundle: b, options: { trustedGatewayKeys: [address("stranger")] }, fails: ["gateway.trusted"] });

  const history = copy(b);
  history.gatewayKeyHistory[0]!.handedOver = false;
  add({ name: "gateway-key-history-edited", description: "The exported gateway key history does not match the rotation receipt.", bundle: history, fails: ["gateway.keys"] });

  // a forger holding the new key writes a handover the old key never signed
  const forged = copy(b);
  const at = forged.receipts.findIndex((r) => r.kind === "gateway.key.rotated");
  const data = forged.receipts[at]!.data as { handover: string; prevAddress: string; address: string };
  const message = core.gatewayKeyHandoverMessage({ principalId: "org", seq: at, prev: forged.receipts[at - 1]!.hash, prevAddress: data.prevAddress, address: data.address });
  data.handover = await account("stranger").signMessage({ message });
  await resign(forged.receipts, at, () => "gatewayB");
  add({ name: "gateway-key-handover-forged", description: "The rotation's handover is signed by a key other than the old gateway key.", bundle: forged, fails: ["receipts.chain"] });
}

// 9. the gateway key changes without a handover: the operator declared the old address
{
  const dir = fresh();
  let gw = await start(config(dir));
  await pay(gw, "int_0701");
  await gw.close();
  gw = await start(config(dir, { gatewayPrivateKey: KEY.gatewayC, previousGatewayAddresses: [address("gatewayA")] }));
  await pay(gw, "int_0702");
  const b = await exported(gw);
  await gw.close();
  add({ name: "gateway-key-declared-unpinned", description: "The gateway key changes without a handover; without pinned keys nothing links the two.", bundle: b, fails: ["gateway.trusted"] });
  add({ name: "gateway-key-declared-pinned", description: "The same chain with both keys pinned.", bundle: b, options: { trustedGatewayKeys: [address("gatewayA"), address("gatewayC")] }, fails: [] });
  add({ name: "gateway-key-declared-half-pinned", description: "The same chain with only the new key pinned: the receipts before the change stay unvouched.", bundle: b, options: { trustedGatewayKeys: [address("gatewayC")] }, fails: ["gateway.trusted"] });
}

// 10. a separate evidence key, and anchors sent by the gateway key
{
  const gw = await start(config(fresh(), { evidencePrivateKey: KEY.evidence }));
  await pay(gw, "int_0801");
  await gw.anchor("org");
  await gw.receipts.append("org", "external", { source: "operator", note: "after the first anchor" });
  await gw.anchor("org");
  const b = await exported(gw);
  await gw.close();
  add({ name: "anchors-evidence-key", description: "Receipts signed by a separate evidence key; two anchors sent by the gateway key, each recorded by an evidence.anchored receipt.", bundle: b, fails: [] });

  const head = copy(b);
  head.anchors[0]!.head = head.receipts[0]!.hash;
  add({ name: "anchor-head-mismatch", description: "An anchor's head is not the receipt at its count.", bundle: head, fails: ["anchors.match"] });

  const party = copy(b);
  party.anchors[1]!.party = address("stranger");
  add({ name: "anchor-sender-unrecorded", description: "An anchor names a sender no evidence.anchored receipt records.", bundle: party, fails: ["anchors.match"] });
}

// ───────────────────────────── check every vector against the reference verifier, then write ─────────────────────────────

const written: string[] = [];
rmSync(VECTORS, { recursive: true, force: true });
mkdirSync(VECTORS, { recursive: true });
for (const [i, v] of vectors.entries()) {
  const report = await core.verifyBundle(copy(v.bundle), v.options ?? {});
  const failing = report.checks.filter((c) => !c.ok).map((c) => c.check);
  if (failing.join(",") !== [...v.fails].sort((a, b) => report.checks.findIndex((c) => c.check === a) - report.checks.findIndex((c) => c.check === b)).join(",")) {
    throw new Error(`vector ${v.name}: meant to fail [${v.fails.join(", ")}], the reference verifier failed [${failing.join(", ")}]: ${JSON.stringify(report.checks.filter((c) => !c.ok))}`);
  }
  const file = `${String(i + 1).padStart(2, "0")}-${v.name}.json`;
  const out = {
    format: "evidence-v1",
    name: v.name,
    description: v.description,
    ...(v.options ? { options: v.options } : {}),
    expected: { ok: report.ok, checks: report.checks.map((c) => ({ check: c.check, ok: c.ok })) },
    bundle: v.bundle,
  };
  writeFileSync(join(VECTORS, file), JSON.stringify(out, null, 2) + "\n");
  written.push(file);
}

// the bundle's JSON Schema: objects accept unknown members (verifiers ignore them) except where the format forbids them
const schema = zodToJsonSchema(core.EvidenceBundleSchema, { target: "jsonSchema7", removeAdditionalStrategy: "strict", $refStrategy: "none" }) as Record<string, unknown>;
const utc = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$";
const withUtc = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(withUtc);
  if (node && typeof node === "object") {
    const o = Object.fromEntries(Object.entries(node).map(([k, x]) => [k, withUtc(x)]));
    return o.format === "date-time" ? { ...o, pattern: utc } : o;
  }
  return node;
};
const { $schema: _draft, ...body } = withUtc(schema) as Record<string, unknown>;
const document = { $schema: "http://json-schema.org/draft-07/schema#", $id: "evidence-v1.schema.json", title: "Evidence bundle, format v1", ...body };
writeFileSync(join(SPEC, "evidence-v1.schema.json"), JSON.stringify(document, null, 2) + "\n");

console.log(`wrote ${written.length} vectors to docs/spec/vectors and docs/spec/evidence-v1.schema.json`);
for (const f of written) console.log(`  ${f}`);
