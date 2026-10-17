/**
 * Live run on Base Sepolia (see docs/TESTNET.md).
 *
 * Keys are read from files under local/ (git-ignored) and never printed. The run refuses to start until both
 * keys are funded. Every transaction is reported with a Basescan link so the transcript can be checked by anyone.
 *
 *   SPENDMARSHAL_TESTNET_OWNER_KEY_FILE    default local/testnet-owner.key   (the agent's EOA: ETH for gas + USDC)
 *   SPENDMARSHAL_TESTNET_GATEWAY_KEY_FILE  default local/testnet-gateway.key (deploys, grants, relays: ETH only)
 *   SPENDMARSHAL_TESTNET_RPC               default https://sepolia.base.org
 *   SPENDMARSHAL_TESTNET_FACILITATOR       default https://x402.org/facilitator
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { formatUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { connectChain, deployCore, deployReceiptRegistry, delegateEoaToAccount, grantRootSession, readSession, registryAnchorsPerChain, usdcBalance, walletFor, type CoreContracts } from "@spendmarshal/devnet";
import { buildGateway, type Gateway } from "@spendmarshal/gateway";
import { buildPayee } from "@spendmarshal/payee";
import { SpendMarshalAdmin, type PayResponse } from "@spendmarshal/sdk";
import { AgentAccountAbi, verifyBundle, toHuman, waitForInclusion, type EvidenceBundle } from "@spendmarshal/core";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const LOCAL = join(REPO, "local");
const CHAIN_ID = 84532;
const RPC = process.env.SPENDMARSHAL_TESTNET_RPC ?? "https://sepolia.base.org";
/** "bundled" uses the gateway's own facilitator on the same chain (the fallback if the public one refuses ERC-1271 payers). */
const FACILITATOR = process.env.SPENDMARSHAL_TESTNET_FACILITATOR ?? "https://x402.org/facilitator";
const USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Circle USDC on Base Sepolia (FiatToken v2, "USDC"/"2")
const txLink = (h: string) => `https://sepolia.basescan.org/tx/${h}`;
const addrLink = (a: string) => `https://sepolia.basescan.org/address/${a}`;

interface Secrets {
  sessionSecret: string;
  credentialRootKey: string;
  adminToken: string;
}
const newSecrets = (): Secrets => ({ sessionSecret: randomBytes(32).toString("hex"), credentialRootKey: randomBytes(32).toString("hex"), adminToken: randomBytes(16).toString("hex") });

function readKey(envName: string, fallback: string): Hex {
  const file = process.env[envName] ?? join(LOCAL, fallback);
  if (!existsSync(file)) throw new Error(`key file missing: ${file} (see docs/TESTNET.md)`);
  const key = readFileSync(file, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`key file ${file} must hold one 0x-prefixed 32-byte hex private key`);
  return key as Hex;
}

export interface TestnetSummary {
  steps: Array<{ step: string; ok: boolean; detail: string }>;
  verification: { ok: boolean; checks: Array<{ check: string; ok: boolean; detail?: string }> } | null;
}

export async function runTestnet(opts: { log?: (line: string) => void } = {}): Promise<TestnetSummary> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const steps: TestnetSummary["steps"] = [];
  const step = (name: string, ok: boolean, detail: string) => {
    steps.push({ step: name, ok, detail });
    log(`${ok ? "✔" : "✘"} ${name}: ${detail}`);
  };

  // One principal per run: the run's budget and approver key belong to it. The gateway key is new every run as well; when
  // the reclaim step writes into an earlier run's principal, that chain records the change as a rotation without a
  // handover (the earlier session key is gone) and its bundle still verifies (ADR-0020).
  const principalId = `org-acme-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
  const ownerKey = readKey("SPENDMARSHAL_TESTNET_OWNER_KEY_FILE", "testnet-owner.key");
  const operatorKey = readKey("SPENDMARSHAL_TESTNET_GATEWAY_KEY_FILE", "testnet-gateway.key"); // deploys once, funds each run
  const owner = privateKeyToAccount(ownerKey);
  const operator = privateKeyToAccount(operatorKey);
  // A session key is single-use on-chain: once granted it can be revoked, never re-granted or widened. Each run therefore
  // gets a fresh one, generated in memory and never stored: the operator funds it, the owner grants it a root session,
  // and what is left of its ETH goes back to the operator at the end.
  const gatewayKey = generatePrivateKey();
  const gatewayAccount = privateKeyToAccount(gatewayKey);
  const cfo = privateKeyToAccount(generatePrivateKey()); // signs approvals only; needs no funds

  const net = connectChain({ rpcUrl: RPC, chainId: CHAIN_ID });
  const chainId = await net.pub.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`RPC ${RPC} is chain ${chainId}, expected ${CHAIN_ID}`);
  log(`Base Sepolia via ${RPC}; owner ${owner.address} (${addrLink(owner.address)}); operator ${operator.address}; this run's session key ${gatewayAccount.address}`);

  // ── 0. funding gate ──────────────────────────────────────────────────────────
  const [ownerEth, operatorEth, ownerUsdc] = await Promise.all([net.pub.getBalance({ address: owner.address }), net.pub.getBalance({ address: operator.address }), usdcBalance(net, USDC, owner.address)]);
  log(`balances: owner ${formatUnits(ownerEth, 18)} ETH / ${toHuman(ownerUsdc)} USDC; operator ${formatUnits(operatorEth, 18)} ETH`);
  // one faucet claim is enough: if only the operator holds ETH, it tops up the owner with a quarter of it
  if (ownerEth === 0n && operatorEth > 0n) {
    const share = operatorEth / 4n;
    const w = walletFor(net, operatorKey);
    const h = await w.sendTransaction({ to: owner.address, value: share });
    await waitForInclusion(net.pub, h);
    log(`operator topped up the owner with ${formatUnits(share, 18)} ETH: ${txLink(h)}`);
    // public RPC endpoints are load-balanced; a node can lag the receipt by a few seconds
    for (let i = 0; i < 30 && (await net.pub.getBalance({ address: owner.address })) === 0n; i++) await new Promise((r) => setTimeout(r, 2_000));
  }
  const [ownerEth2, operatorEth2] = await Promise.all([net.pub.getBalance({ address: owner.address }), net.pub.getBalance({ address: operator.address })]);
  if (ownerEth2 === 0n || operatorEth2 < 7_000_000_000_000n || ownerUsdc < 60_000n) { // a run costs the operator about 0.000007 ETH
    log("Fund the keys first: Base Sepolia ETH on both addresses (a faucet; the operator needs at least 0.000007 ETH per run), at least 0.06 test USDC on the owner (https://faucet.circle.com, Base Sepolia). Then run again.");
    step("keys funded", false, `owner ETH ${formatUnits(ownerEth2, 18)}, operator ETH ${formatUnits(operatorEth2, 18)}, owner USDC ${toHuman(ownerUsdc)}`);
    return { steps, verification: null };
  }
  step("keys funded", true, `owner ${formatUnits(ownerEth2, 18)} ETH + ${toHuman(ownerUsdc)} USDC, operator ${formatUnits(operatorEth2, 18)} ETH`);

  // ── 1. contracts (deployed once per chain, cached) ───────────────────────────
  mkdirSync(LOCAL, { recursive: true });
  const deployFile = join(LOCAL, "testnet-deploy.json");
  let core: CoreContracts;
  let treasury: Address; // the payee's receiving address; stable across runs because the root session's allowlist names it
  let secrets: Secrets;
  if (existsSync(deployFile)) {
    const cached = JSON.parse(readFileSync(deployFile, "utf8")) as CoreContracts & { treasury?: Address; secrets?: Secrets };
    core = cached;
    treasury = cached.treasury ?? privateKeyToAccount(generatePrivateKey()).address;
    secrets = cached.secrets ?? newSecrets();
    if (!cached.treasury || !cached.secrets) writeFileSync(deployFile, JSON.stringify({ ...core, treasury, secrets }, null, 2));
    // A registry from before per-chain anchors (ADR-0021) cannot take this run's anchor, so the operator replaces it once
    // and the cache keeps the new one. Bundles anchored in the old one still verify: each anchor names its registry.
    let registryNote = "";
    if (!(await registryAnchorsPerChain(net, core.receiptRegistry))) {
      const old = core.receiptRegistry;
      core = { ...core, receiptRegistry: await deployReceiptRegistry(net, operatorKey) };
      writeFileSync(deployFile, JSON.stringify({ ...core, treasury, secrets }, null, 2));
      registryNote = `; ReceiptRegistry ${old} predates per-chain anchors, replaced by ${addrLink(core.receiptRegistry)}`;
    }
    step("contracts", true, `reusing ${deployFile.replace(REPO, ".")}: AgentAccount impl ${core.agentAccountImpl}${registryNote}`);
  } else {
    core = await deployCore(net, operatorKey, { usdc: USDC });
    treasury = privateKeyToAccount(generatePrivateKey()).address;
    secrets = newSecrets();
    writeFileSync(deployFile, JSON.stringify({ ...core, treasury, secrets }, null, 2));
    step("contracts deployed", true, `AgentAccount impl ${addrLink(core.agentAccountImpl)}, ReceiptRegistry ${core.receiptRegistry}, enforcers x3`);
  }

  // ── 2. the owner EOA becomes the account (EIP-7702), funds stay in place ────
  const code = await net.pub.getCode({ address: owner.address });
  if (code && code.toLowerCase().startsWith("0xef0100")) {
    const current = await net.pub.readContract({ address: owner.address, abi: AgentAccountAbi, functionName: "owner" });
    // a previous run may have delegated but died before setting the enforcers; without them no cap is enforced on-chain
    const hasEnforcers = await net.pub.readContract({ address: owner.address, abi: AgentAccountAbi, functionName: "enforcers", args: [0n] }).then(() => true).catch(() => false);
    let enforcersNote = "enforcers already set";
    if (!hasEnforcers) {
      const w = walletFor(net, ownerKey);
      const h = await w.writeContract({ address: owner.address, abi: AgentAccountAbi, functionName: "setEnforcers", args: [[core.enforcers.spendLimit, core.enforcers.timeWindow, core.enforcers.allowedTargets]] });
      await waitForInclusion(net.pub, h);
      enforcersNote = `enforcers set now: ${txLink(h)}`;
    }
    step("EIP-7702 delegation", current.toLowerCase() === owner.address.toLowerCase(), `already delegated (${addrLink(owner.address)} carries the designator); owner() = ${current}; ${enforcersNote}`);
  } else {
    const d = await delegateEoaToAccount(net, ownerKey, core);
    const after = await usdcBalance(net, USDC, owner.address);
    step("EIP-7702 delegation", after === ownerUsdc, `type-4 tx ${txLink(d.delegationTx)}; enforcers ${txLink(d.enforcersTx)}; USDC still ${toHuman(after)}`);
  }

  // ── 3. the owner grants this run's session key a bounded root session ───────
  const now = BigInt(Math.floor(Date.now() / 1000));
  const grant = await grantRootSession(net, ownerKey, owner.address, { key: gatewayAccount.address, spendCap: 100_000n, perTxMax: 50_000n, validUntil: now + 86_400n, anyTarget: false, targets: [treasury], tokens: [USDC] });
  for (let i = 0; i < 30 && !(await readSession(net, owner.address, gatewayAccount.address)).active; i++) await new Promise((r) => setTimeout(r, 2_000)); // a lagging node
  step("gateway root session", true, `fresh session key: cap 0.10 USDC, per-tx 0.05, payee allowlist, 24 h: ${txLink(grant)}`);

  // ── 4. gateway + payee (payee settles through the public facilitator) ───────
  const dataDir = join(LOCAL, "testnet-data"); // kept across runs: the next run reclaims what a failed run left pre-approved
  const adminToken = secrets.adminToken;
  let gw: Gateway | undefined;
  let payee: ReturnType<typeof buildPayee> | undefined;
  try {
    const operatorEth = await net.pub.getBalance({ address: operator.address }); // after any deployment above
    const fund = operatorEth > 16_000_000_000_000n ? 15_000_000_000_000n : (operatorEth * 9n) / 10n; // gas for about ten transactions; the rest returns at the end
    const fh = await walletFor(net, operatorKey).sendTransaction({ to: gatewayAccount.address, value: fund });
    await waitForInclusion(net.pub, fh);
    for (let i = 0; i < 15 && (await net.pub.getBalance({ address: gatewayAccount.address })) === 0n; i++) await new Promise((r) => setTimeout(r, 2_000));
    log(`operator funded the session key with ${formatUnits(fund, 18)} ETH: ${txLink(fh)}`);
    gw = await buildGateway({
      host: "127.0.0.1",
      port: 14602,
      rpcUrl: RPC,
      chainId: CHAIN_ID,
      gatewayPrivateKey: gatewayKey,
      sessionSecret: secrets.sessionSecret,
      credentialRootKey: secrets.credentialRootKey,
      adminToken,
      dataDir,
      storeDriver: "sqlite",
      policyYaml: readFileSync(join(HERE, "policy.yaml"), "utf8").replace("principalId: org-acme", `principalId: ${principalId}`),
      contracts: { usdc: USDC, receiptRegistry: core.receiptRegistry, enforcers: core.enforcers },
      principals: { [principalId]: { account: owner.address, ownerIsGateway: false } },
      asset: { symbol: "USDC", decimals: 6 },
      facilitator: { enabled: FACILITATOR === "bundled" },
      x402Mode: "standard",
      authorizationTtlSeconds: 900,
      approvers: { cfo: cfo.address },
      approvalTtlSeconds: 900,
      payeeTimeoutMs: 120_000, // the public facilitator settles on a 2 s chain inside the paid request
      outbound: { allowLoopback: true },
    });
    const gatewayUrl = await gw.listen();
    const facilitatorUrl = FACILITATOR === "bundled" ? `${gatewayUrl}/facilitator` : FACILITATOR;
    payee = buildPayee({
      host: "127.0.0.1",
      port: 14603,
      token: USDC,
      chainId: CHAIN_ID,
      pricing: { rails: ["x402"], payTo: treasury, facilitatorUrl, agentAuth: { require: true, allowedAgents: [gatewayUrl] } },
      eip712: { name: "USDC", version: "2" },
    });
    const payeeUrl = await payee.listen();
    const payeeHost = new URL(payeeUrl).host;
    const waitForUsdc = (who: Address, expected: bigint) => waitForUsdcAt(net, who, expected);
    const admin = new SpendMarshalAdmin(gatewayUrl, adminToken);
    const health = await admin.health();
    step("services", health.ok === true, `gateway ${gatewayUrl} (standard x402, facilitator ${facilitatorUrl}), payee ${payeeUrl}, treasury ${addrLink(treasury)}`);

    const spentBefore = (await readSession(net, owner.address, gatewayAccount.address)).spent; // 0 for a fresh session

    const agent = await admin.issueCredential({
      principalId,
      agentId: "research-agent",
      caveats: [
        { type: "spend_cap", value: "100000" },
        { type: "per_tx_max", value: "50000" },
        { type: "allowed_payees", value: [payeeHost, treasury] },
        { type: "allowed_rails", value: ["x402"] },
        { type: "purposes", value: ["research"] },
        { type: "expires_at", value: new Date(Date.now() + 24 * 3600 * 1000).toISOString() },
      ],
    });

    // ── 5. a payment settled through the facilitator ─────────────────────────────
    const treasuryBefore = await usdcBalance(net, USDC, treasury); // the treasury keeps what earlier runs paid it
    const quote = await agent.pay({ url: `${payeeUrl}/v1/quote?symbol=ETH`, maxAmount: "0.02", purpose: "research", rail: "x402" });
    const treasuryAfter1 = await waitForUsdc(treasury, treasuryBefore + 10_000n);
    step(`0.01 USDC paid through the ${FACILITATOR === "bundled" ? "bundled" : "public"} facilitator`, quote.ok && treasuryAfter1 === treasuryBefore + 10_000n, `${summarise(quote)}; treasury +${toHuman(treasuryAfter1 - treasuryBefore)} USDC (now ${toHuman(treasuryAfter1)})`);

    // ── 6. escalation above the threshold, approved by the CFO key, resumed ─────
    const pending = await agent.pay({ url: `${payeeUrl}/v1/report`, maxAmount: "0.05", purpose: "research", rail: "x402" });
    const approvalId = pending.pending?.approvalId;
    step("0.04 USDC escalates (202)", pending.status === 202 && !!approvalId, `approval ${approvalId ?? "none"}; reasons ${pending.pending?.reasons.join(", ") ?? "-"}`);
    let resumed: PayResponse | undefined;
    if (approvalId) {
      await admin.resolveApproval(approvalId, "approve", "cfo", { signer: cfo, principalId, note: "testnet run" });
      resumed = await agent.resume(approvalId);
    }
    const treasuryAfter2 = await waitForUsdc(treasury, treasuryBefore + 50_000n);
    step("approved and settled on resume", resumed?.ok === true && treasuryAfter2 === treasuryBefore + 50_000n, `${resumed ? summarise(resumed) : "no approval"}; treasury +${toHuman(treasuryAfter2 - treasuryBefore)} USDC (now ${toHuman(treasuryAfter2)})`);

    // ── 7. the budget stops the third one ────────────────────────────────────────
    const denied = await agent.pay({ url: `${payeeUrl}/v1/report`, maxAmount: "0.05", purpose: "research", rail: "x402" });
    step("third payment denied by the 0.06 budget", denied.ok === false && denied.status !== 202 && /BUDGET/i.test(denied.error ?? denied.decision?.reasons.join(",") ?? ""), `${denied.status} ${denied.error ?? denied.decision?.reasons.join(", ")}`);

    // ── 8. on-chain truth and offline evidence ───────────────────────────────────
    let session = await readSession(net, owner.address, gatewayAccount.address);
    for (let i = 0; i < 15 && session.spent !== spentBefore + 50_000n; i++) {
      await new Promise((r) => setTimeout(r, 2_000));
      session = await readSession(net, owner.address, gatewayAccount.address);
    }
    step("root session spend matches the chain", session.spent === spentBefore + 50_000n, `gateway root session spent ${toHuman(session.spent - spentBefore)} USDC this run (${toHuman(session.spent)} of ${toHuman(session.spendCap)} in total) = payee treasury +${toHuman(treasuryAfter2 - treasuryBefore)}`);
    const anchor = await admin.anchor(principalId);
    const evidence = await admin.exportEvidence(principalId);
    const evidenceFile = join(LOCAL, `testnet-evidence-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
    const offline = await verifyBundle(JSON.parse(readFileSync(evidenceFile, "utf8")) as EvidenceBundle);
    step("receipts anchored and evidence verified offline", offline.ok && anchor.count > 0, `anchor ${txLink(anchor.txHash)} (${anchor.count} receipts); ${offline.checks.filter((c) => c.ok).length}/${offline.checks.length} checks; ${evidenceFile.replace(REPO, ".")}`);

    // ── 9. housekeeping last, on whatever gas is left: earlier runs' pre-approvals whose window has closed ──
    const reclaim = await admin.reclaim();
    const reclaimedTx = reclaim.results.filter((r) => r.ok).map((r) => r.txHash!);
    if (reclaimedTx.length > 0) step("earlier pre-approvals reclaimed", true, `${reclaimedTx.length} restored: ${reclaimedTx.map((h) => txLink(h)).join(", ")}`);
    if (reclaim.pending > 0) log(`${reclaim.pending} earlier pre-approval(s) still inside their window; a later run reclaims them`);
    const failed = steps.filter((s) => !s.ok).length;
    log(failed ? `TESTNET FAILED: ${steps.length - failed}/${steps.length} steps` : `TESTNET PASSED: ${steps.length}/${steps.length} steps`);
    return { steps, verification: { ok: offline.ok, checks: offline.checks } };
  } finally {
    await payee?.close();
    await gw?.close();
    try {
      const bal = await net.pub.getBalance({ address: gatewayAccount.address });
      const fee = 21_000n * (await net.pub.getGasPrice()) * 3n; // the margin also covers Base's L1 data fee
      if (bal > fee * 2n) {
        const sh = await walletFor(net, gatewayKey).sendTransaction({ to: operator.address, value: bal - fee });
        await waitForInclusion(net.pub, sh);
        log(`returned ${formatUnits(bal - fee, 18)} ETH from the session key to the operator: ${txLink(sh)}`);
      }
    } catch (err) {
      log(`could not return the session key's ETH: ${String(err).slice(0, 160)}`);
    }
  }
}

async function waitForUsdcAt(net: ReturnType<typeof connectChain>, who: Address, expected: bigint): Promise<bigint> {
  let bal = await usdcBalance(net, USDC, who);
  for (let i = 0; i < 30 && bal !== expected; i++) {
    await new Promise((r) => setTimeout(r, 2_000));
    bal = await usdcBalance(net, USDC, who);
  }
  return bal;
}

function summarise(r: PayResponse): string {
  if (r.ok) return `${r.rail} ${toHuman(r.settlement?.amount ?? "0")} USDC ${r.settlement?.txHash ? txLink(r.settlement.txHash) : ""}`;
  return `${r.status} ${r.error ?? r.decision?.reasons.join(", ") ?? ""}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTestnet()
    .then((s) => process.exit(s.steps.every((x) => x.ok) ? 0 : s.verification === null ? 2 : 1))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
