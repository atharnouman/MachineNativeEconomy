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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { formatUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { connectChain, deployCore, delegateEoaToAccount, grantRootSession, readSession, usdcBalance, type CoreContracts } from "@spendmarshal/devnet";
import { buildGateway, type Gateway } from "@spendmarshal/gateway";
import { buildPayee } from "@spendmarshal/payee";
import { SpendMarshalAdmin, type PayResponse } from "@spendmarshal/sdk";
import { AgentAccountAbi, verifyBundle, toHuman, type EvidenceBundle } from "@spendmarshal/core";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const LOCAL = join(REPO, "local");
const CHAIN_ID = 84532;
const RPC = process.env.SPENDMARSHAL_TESTNET_RPC ?? "https://sepolia.base.org";
const FACILITATOR = process.env.SPENDMARSHAL_TESTNET_FACILITATOR ?? "https://x402.org/facilitator";
const USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Circle USDC on Base Sepolia (FiatToken v2, "USDC"/"2")
const txLink = (h: string) => `https://sepolia.basescan.org/tx/${h}`;
const addrLink = (a: string) => `https://sepolia.basescan.org/address/${a}`;

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

  const ownerKey = readKey("SPENDMARSHAL_TESTNET_OWNER_KEY_FILE", "testnet-owner.key");
  const gatewayKey = readKey("SPENDMARSHAL_TESTNET_GATEWAY_KEY_FILE", "testnet-gateway.key");
  const owner = privateKeyToAccount(ownerKey);
  const gatewayAccount = privateKeyToAccount(gatewayKey);
  const cfo = privateKeyToAccount(generatePrivateKey()); // signs approvals only; needs no funds
  const treasury = privateKeyToAccount(generatePrivateKey()).address; // the payee's receiving address for this run

  const net = connectChain({ rpcUrl: RPC, chainId: CHAIN_ID });
  const chainId = await net.pub.getChainId();
  if (chainId !== CHAIN_ID) throw new Error(`RPC ${RPC} is chain ${chainId}, expected ${CHAIN_ID}`);
  log(`Base Sepolia via ${RPC}; owner ${owner.address} (${addrLink(owner.address)}); gateway ${gatewayAccount.address}`);

  // ── 0. funding gate ──────────────────────────────────────────────────────────
  const [ownerEth, gatewayEth, ownerUsdc] = await Promise.all([net.pub.getBalance({ address: owner.address }), net.pub.getBalance({ address: gatewayAccount.address }), usdcBalance(net, USDC, owner.address)]);
  log(`balances: owner ${formatUnits(ownerEth, 18)} ETH / ${toHuman(ownerUsdc)} USDC; gateway ${formatUnits(gatewayEth, 18)} ETH`);
  if (ownerEth === 0n || gatewayEth === 0n || ownerUsdc < 60_000n) {
    log("Fund the keys first: Base Sepolia ETH on both addresses (a faucet), at least 0.06 test USDC on the owner (https://faucet.circle.com, Base Sepolia). Then run again.");
    step("keys funded", false, `owner ETH ${formatUnits(ownerEth, 18)}, gateway ETH ${formatUnits(gatewayEth, 18)}, owner USDC ${toHuman(ownerUsdc)}`);
    return { steps, verification: null };
  }
  step("keys funded", true, `owner ${formatUnits(ownerEth, 18)} ETH + ${toHuman(ownerUsdc)} USDC, gateway ${formatUnits(gatewayEth, 18)} ETH`);

  // ── 1. contracts (deployed once per chain, cached) ───────────────────────────
  mkdirSync(LOCAL, { recursive: true });
  const deployFile = join(LOCAL, "testnet-deploy.json");
  let core: CoreContracts;
  if (existsSync(deployFile)) {
    core = JSON.parse(readFileSync(deployFile, "utf8")) as CoreContracts;
    step("contracts", true, `reusing ${deployFile.replace(REPO, ".")}: AgentAccount impl ${core.agentAccountImpl}`);
  } else {
    core = await deployCore(net, gatewayKey, { usdc: USDC });
    writeFileSync(deployFile, JSON.stringify(core, null, 2));
    step("contracts deployed", true, `AgentAccount impl ${addrLink(core.agentAccountImpl)}, ReceiptRegistry ${core.receiptRegistry}, enforcers x3`);
  }

  // ── 2. the owner EOA becomes the account (EIP-7702), funds stay in place ────
  const code = await net.pub.getCode({ address: owner.address });
  if (code && code.toLowerCase().startsWith("0xef0100")) {
    const current = await net.pub.readContract({ address: owner.address, abi: AgentAccountAbi, functionName: "owner" });
    step("EIP-7702 delegation", current.toLowerCase() === owner.address.toLowerCase(), `already delegated; owner() = ${current}`);
  } else {
    const d = await delegateEoaToAccount(net, ownerKey, core);
    const after = await usdcBalance(net, USDC, owner.address);
    step("EIP-7702 delegation", after === ownerUsdc, `type-4 tx ${txLink(d.delegationTx)}; enforcers ${txLink(d.enforcersTx)}; USDC still ${toHuman(after)}`);
  }

  // ── 3. the owner grants the gateway a bounded root session ───────────────────
  const now = BigInt(Math.floor(Date.now() / 1000));
  const existing = await readSession(net, owner.address, gatewayAccount.address);
  if (existing.active && existing.validUntil > now + 3600n) {
    step("gateway root session", true, `already granted: cap ${toHuman(existing.spendCap)} spent ${toHuman(existing.spent)}`);
  } else {
    const h = await grantRootSession(net, ownerKey, owner.address, { key: gatewayAccount.address, spendCap: 100_000n, perTxMax: 50_000n, validUntil: now + 86_400n, anyTarget: false, targets: [treasury], tokens: [USDC] });
    step("gateway root session", true, `cap 0.10 USDC, per-tx 0.05, payee allowlist, 24 h: ${txLink(h)}`);
  }

  // ── 4. gateway + payee (payee settles through the public facilitator) ───────
  const dataDir = join(LOCAL, "testnet-data");
  rmSync(dataDir, { recursive: true, force: true });
  const adminToken = randomBytes(16).toString("hex");
  let gw: Gateway | undefined;
  let payee: ReturnType<typeof buildPayee> | undefined;
  try {
    gw = await buildGateway({
      host: "127.0.0.1",
      port: 14602,
      rpcUrl: RPC,
      chainId: CHAIN_ID,
      gatewayPrivateKey: gatewayKey,
      sessionSecret: randomBytes(32).toString("hex"),
      credentialRootKey: randomBytes(32).toString("hex"),
      adminToken,
      dataDir,
      storeDriver: "sqlite",
      policyYaml: readFileSync(join(HERE, "policy.yaml"), "utf8"),
      contracts: { usdc: USDC, receiptRegistry: core.receiptRegistry, enforcers: core.enforcers },
      principals: { "org-acme": { account: owner.address, ownerIsGateway: false } },
      asset: { symbol: "USDC", decimals: 6 },
      facilitator: { enabled: false },
      x402Mode: "standard",
      authorizationTtlSeconds: 900,
      approvers: { cfo: cfo.address },
      approvalTtlSeconds: 900,
      payeeTimeoutMs: 120_000, // the public facilitator settles on a 2 s chain inside the paid request
      outbound: { allowLoopback: true },
    });
    const gatewayUrl = await gw.listen();
    payee = buildPayee({
      host: "127.0.0.1",
      port: 14603,
      token: USDC,
      chainId: CHAIN_ID,
      pricing: { rails: ["x402"], payTo: treasury, facilitatorUrl: FACILITATOR, agentAuth: { require: true, allowedAgents: [gatewayUrl] } },
      eip712: { name: "USDC", version: "2" },
    });
    const payeeUrl = await payee.listen();
    const payeeHost = new URL(payeeUrl).host;
    const admin = new SpendMarshalAdmin(gatewayUrl, adminToken);
    const health = await admin.health();
    step("services", health.ok === true, `gateway ${gatewayUrl} (standard x402, facilitator ${FACILITATOR}), payee ${payeeUrl}, treasury ${addrLink(treasury)}`);

    const agent = await admin.issueCredential({
      principalId: "org-acme",
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

    // ── 5. a payment settled by the public facilitator ──────────────────────────
    const quote = await agent.pay({ url: `${payeeUrl}/v1/quote?symbol=ETH`, maxAmount: "0.02", purpose: "research", rail: "x402" });
    const treasuryAfter1 = await usdcBalance(net, USDC, treasury);
    step("0.01 USDC paid through the public facilitator", quote.ok && treasuryAfter1 === 10_000n, `${summarise(quote)}; treasury now ${toHuman(treasuryAfter1)} USDC`);

    // ── 6. escalation above the threshold, approved by the CFO key, resumed ─────
    const pending = await agent.pay({ url: `${payeeUrl}/v1/report`, maxAmount: "0.05", purpose: "research", rail: "x402" });
    const approvalId = pending.pending?.approvalId;
    step("0.04 USDC escalates (202)", pending.status === 202 && !!approvalId, `approval ${approvalId ?? "none"}; reasons ${pending.pending?.reasons.join(", ") ?? "-"}`);
    let resumed: PayResponse | undefined;
    if (approvalId) {
      await admin.resolveApproval(approvalId, "approve", "cfo", { signer: cfo, principalId: "org-acme", note: "testnet run" });
      resumed = await agent.resume(approvalId);
    }
    const treasuryAfter2 = await usdcBalance(net, USDC, treasury);
    step("approved and settled on resume", resumed?.ok === true && treasuryAfter2 === 50_000n, `${resumed ? summarise(resumed) : "no approval"}; treasury now ${toHuman(treasuryAfter2)} USDC`);

    // ── 7. the budget stops the third one ────────────────────────────────────────
    const denied = await agent.pay({ url: `${payeeUrl}/v1/report`, maxAmount: "0.05", purpose: "research", rail: "x402" });
    step("third payment denied by the 0.06 budget", denied.ok === false && denied.status !== 202 && /BUDGET/i.test(denied.error ?? denied.decision?.reasons.join(",") ?? ""), `${denied.status} ${denied.error ?? denied.decision?.reasons.join(", ")}`);

    // ── 8. on-chain truth and offline evidence ───────────────────────────────────
    const session = await readSession(net, owner.address, gatewayAccount.address);
    step("root session spend matches the chain", session.spent === 50_000n, `gateway root session spent ${toHuman(session.spent)} USDC = payee treasury ${toHuman(treasuryAfter2)}`);
    const anchor = await admin.anchor("org-acme");
    const evidence = await admin.exportEvidence("org-acme");
    const evidenceFile = join(LOCAL, `testnet-evidence-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
    const offline = await verifyBundle(JSON.parse(readFileSync(evidenceFile, "utf8")) as EvidenceBundle);
    step("receipts anchored and evidence verified offline", offline.ok && anchor.count > 0, `anchor ${txLink(anchor.txHash)} (${anchor.count} receipts); ${offline.checks.filter((c) => c.ok).length}/${offline.checks.length} checks; ${evidenceFile.replace(REPO, ".")}`);

    const failed = steps.filter((s) => !s.ok).length;
    log(failed ? `TESTNET FAILED: ${steps.length - failed}/${steps.length} steps` : `TESTNET PASSED: ${steps.length}/${steps.length} steps`);
    return { steps, verification: { ok: offline.ok, checks: offline.checks } };
  } finally {
    await payee?.close();
    await gw?.close();
  }
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
