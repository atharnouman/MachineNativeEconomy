import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AgentAccountAbi,
  AgentAccountBytecode,
  MockUSDCAbi,
  MockUSDCBytecode,
  ReceiptRegistryBytecode,
  SpendLimitEnforcerBytecode,
  TimeWindowEnforcerBytecode,
  AllowedTargetsEnforcerBytecode,
  chainFor,
  describeRevert,
  verifyBundle,
  credentialId,
  PaymentAuthorizationTypes,
  agentAccountDomain,
  toHuman,
  type EvidenceBundle,
} from "@spendmarshal/core";
import { buildGateway, type Gateway } from "@spendmarshal/gateway";
import { buildPayee } from "@spendmarshal/payee";
import { SpendMarshalAdmin, type SpendMarshalClient, type PayResponse } from "@spendmarshal/sdk";
import { verifyEvidence, formatReport } from "@spendmarshal/cli";

/**
 * Phase 0 thin slice.
 *
 *   One agent, under one org budget with one sub-agent credential, pays one payee for the same resource over
 *   x402 and then over MPP with no change to agent code. One attempt violates policy and is denied by the
 *   gateway and by the on-chain account. Every step produces a receipt, and the run ends with an auditor-ready
 *   evidence bundle exported by the CLI and verified offline.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

// anvil's well-known dev keys (never use outside a local chain)
const KEYS = {
  gateway: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // #0
  payeeRelayer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // #1
  payeeTreasury: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // #2
} as const;

export interface ThinSliceOptions {
  rpcPort?: number;
  gatewayPort?: number;
  payeePort?: number;
  dataDir?: string;
  evidenceOut?: string;
  log?: (line: string) => void;
  keepAnvil?: boolean;
}

export interface ThinSliceSummary {
  gateway: string;
  contracts: Record<string, string>;
  steps: Array<{ step: string; ok: boolean; detail: string }>;
  evidenceFile: string;
  evidence: EvidenceBundle;
  verification: { ok: boolean; checks: Array<{ check: string; ok: boolean; detail?: string }> };
}

export async function runThinSlice(opts: ThinSliceOptions = {}): Promise<ThinSliceSummary> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const rpcPort = opts.rpcPort ?? 8545;
  const gatewayPort = opts.gatewayPort ?? 4402;
  const payeePort = opts.payeePort ?? 4403;
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const chainId = 31337;
  const dataDir = opts.dataDir ?? join(REPO, "data", "thin-slice");
  const steps: ThinSliceSummary["steps"] = [];
  const step = (name: string, ok: boolean, detail: string) => {
    steps.push({ step: name, ok, detail });
    log(`${ok ? "✔" : "✘"} ${name}: ${detail}`);
  };

  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });

  // ── 1. local chain ──────────────────────────────────────────────────────────────
  const anvil = await startAnvil(rpcPort, chainId, log);
  let gw: Gateway | undefined;
  let payee: ReturnType<typeof buildPayee> | undefined;
  try {
    const chain = chainFor(chainId, rpcUrl);
    const pub = createPublicClient({ chain, transport: http(rpcUrl) });
    const deployer = createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(KEYS.gateway) });
    const deploy = async (name: string, bytecode: Hex, abi: readonly unknown[] = [], args: unknown[] = []) => {
      const hash = await deployer.deployContract({ abi: abi as never, bytecode, args: args as never });
      const r = await pub.waitForTransactionReceipt({ hash });
      if (!r.contractAddress) throw new Error(`deploy ${name} failed`);
      return r.contractAddress;
    };
    const usdc = await deploy("MockUSDC", MockUSDCBytecode);
    const registry = await deploy("ReceiptRegistry", ReceiptRegistryBytecode);
    const spendLimit = await deploy("SpendLimitEnforcer", SpendLimitEnforcerBytecode);
    const timeWindow = await deploy("TimeWindowEnforcer", TimeWindowEnforcerBytecode);
    const allowedTargets = await deploy("AllowedTargetsEnforcer", AllowedTargetsEnforcerBytecode);
    const account = await deploy("AgentAccount", AgentAccountBytecode, AgentAccountAbi, [deployer.account.address]);
    await pub.waitForTransactionReceipt({ hash: await deployer.writeContract({ address: account, abi: AgentAccountAbi, functionName: "setEnforcers", args: [[spendLimit, timeWindow, allowedTargets]] }) });
    await pub.waitForTransactionReceipt({ hash: await deployer.writeContract({ address: usdc, abi: MockUSDCAbi, functionName: "mint", args: [account, 10_000_000n] }) });
    const contracts = { usdc, receiptRegistry: registry, agentAccount: account, spendLimit, timeWindow, allowedTargets };
    step("deploy", true, `AgentAccount ${account} funded with 10.00 USDC on anvil chain ${chainId}`);

    // ── 2. gateway + payee ─────────────────────────────────────────────────────────
    const payeeTreasury = privateKeyToAccount(KEYS.payeeTreasury).address;
    gw = await buildGateway({
      host: "127.0.0.1",
      port: gatewayPort,
      rpcUrl,
      chainId,
      gatewayPrivateKey: KEYS.gateway,
      sessionSecret: "dev-session-secret-change-me",
      credentialRootKey: "dev-credential-root-key-change-me",
      adminToken: "dev-admin-token",
      dataDir,
      policyYaml: readFileSync(join(HERE, "policy.yaml"), "utf8"),
      contracts: { usdc, receiptRegistry: registry, enforcers: { spendLimit, timeWindow, allowedTargets } },
      principals: { "org-acme": { account } },
      asset: { symbol: "USDC", decimals: 6 },
      facilitator: { enabled: true },
      authorizationTtlSeconds: 120,
      outbound: { allowLoopback: true }, // loopback payee in the demo
    });
    const gatewayUrl = await gw.listen();
    payee = buildPayee({
      host: "127.0.0.1",
      port: payeePort,
      token: usdc,
      chainId,
      pricing: { rails: ["x402", "mpp"], payTo: payeeTreasury, facilitatorUrl: gatewayUrl, mpp: { rpcUrl, relayerPrivateKey: KEYS.payeeRelayer } },
    });
    const payeeUrl = await payee.listen();
    step("services", true, `gateway ${gatewayUrl} (signer ${gw.signer.address}), payee ${payeeUrl} (treasury ${payeeTreasury})`);

    // ── 3. credentials: org -> research-agent -> fetcher (sub-agent) ───────────────
    const admin = new SpendMarshalAdmin(gatewayUrl, "dev-admin-token");
    const payeeHost = new URL(payeeUrl).host;
    const researchAgent = await admin.issueCredential({
      principalId: "org-acme",
      agentId: "research-agent",
      caveats: [
        { type: "spend_cap", value: "1000000" }, // 1.00 USDC lifetime for this agent and all its sub-agents
        { type: "per_tx_max", value: "300000" }, // 0.30 per payment
        { type: "allowed_payees", value: [payeeHost, payeeTreasury] }, // host enforced off-chain, address on-chain
        { type: "allowed_rails", value: ["x402", "mpp"] },
        { type: "purposes", value: ["research"] },
        { type: "expires_at", value: new Date(Date.now() + 24 * 3600 * 1000).toISOString() },
      ],
    });
    const fetcher = await researchAgent.delegate({
      agentId: "research-agent/fetcher",
      caveats: [
        { type: "spend_cap", value: "100000" }, // 0.10 for the sub-agent
        { type: "per_tx_max", value: "20000" }, // 0.02 per payment  <- /v1/report (0.04) will violate this
      ],
    });
    const fetcherId = credentialId(fetcher.credential);
    const fetcherSession = await gw.chain.readSession(account, gw.signer.sessionKeyAddress(fetcherId));
    step("credentials", true, `research-agent cap 1.00/0.30 → fetcher cap 0.10/0.02; on-chain session ${gw.signer.sessionKeyAddress(fetcherId)} perTxMax=${toHuman(fetcherSession.perTxMax)}`);

    // a sub-agent cannot widen itself: attenuation only *adds* caveats and the tightest one wins, off-chain and on-chain
    const rogue = await fetcher.delegate({ agentId: "research-agent/fetcher/rogue", caveats: [{ type: "per_tx_max", value: "500000" }] });
    const rogueSession = await gw.chain.readSession(account, gw.signer.sessionKeyAddress(credentialId(rogue.credential)));
    step("delegation is monotonic", rogueSession.perTxMax === fetcherSession.perTxMax, `sub-sub-agent appended per_tx_max=0.50 but its on-chain session still has perTxMax=${toHuman(rogueSession.perTxMax)}`);

    // ── 4. the same resource, two rails, identical agent code ──────────────────────
    const quoteUrl = `${payeeUrl}/v1/quote?symbol=ETH`;
    const payX = await fetcher.pay({ url: quoteUrl, maxAmount: "0.02", purpose: "research", rail: "x402" });
    step("pay via x402", payX.ok, summarise(payX));
    const payM = await fetcher.pay({ url: quoteUrl, maxAmount: "0.02", purpose: "research", rail: "mpp" });
    step("pay via MPP", payM.ok, summarise(payM));
    const payAuto = await fetcher.pay({ url: quoteUrl, maxAmount: "0.02", purpose: "research" });
    step("pay via auto", payAuto.ok, summarise(payAuto));

    // ── 5. denial: 0.04 report exceeds the sub-agent's 0.02 per-tx caveat ──────────
    const reportUrl = `${payeeUrl}/v1/report?symbol=ETH`;
    const sim = await fetcher.simulate({ url: reportUrl, maxAmount: "0.05", purpose: "research", rail: "x402" });
    step("simulate reports both denials", !sim.ok && sim.decision?.effect === "deny" && sim.onchain?.ok === false, `policy: ${sim.decision?.reasons.join(",")} | account.simulate: ${sim.onchain?.reason}`);
    const denied = await fetcher.pay({ url: reportUrl, maxAmount: "0.05", purpose: "research", rail: "x402" });
    const gatewayDenied = !denied.ok && denied.decision?.effect === "deny";
    step("gateway denies over-limit", gatewayDenied, `${denied.error} (nothing signed, nothing sent)`);

    // same request from the parent agent is fine (0.04 <= 0.30), proving the denial came from the sub-agent caveat
    const parentOk = await researchAgent.pay({ url: reportUrl, maxAmount: "0.05", purpose: "research", rail: "mpp" });
    step("parent agent allowed same purchase", parentOk.ok, summarise(parentOk));

    // ── 6. independent on-chain denial: attacker exfiltrates the sub-agent session key ──
    // Simulates a compromised gateway host / framework that bypasses policy and talks to the chain directly.
    const stolenKey = gw.signer._unsafeSessionPrivateKey(fetcherId);
    const attacker = createWalletClient({ chain, transport: http(rpcUrl), account: privateKeyToAccount(KEYS.payeeRelayer) });
    const auth = {
      token: usdc,
      to: payeeTreasury,
      amount: 40_000n,
      intentHash: keccak256(toHex("attacker-bypass")),
      validAfter: 0n,
      validBefore: BigInt(Math.floor(Date.now() / 1000) + 600),
      nonce: keccak256(toHex(`attack-${Date.now()}`)),
    };
    const sig = await privateKeyToAccount(stolenKey).signTypedData({ domain: agentAccountDomain(account, chainId), types: PaymentAuthorizationTypes, primaryType: "PaymentAuthorization", message: auth });
    let revert = "";
    try {
      await attacker.writeContract({ address: account, abi: AgentAccountAbi, functionName: "payWithAuthorization", args: [auth, sig] });
      revert = "NO REVERT (bug)";
    } catch (err) {
      revert = describeRevert(err);
    }
    const onchainDenied = revert.startsWith("PerTxLimitExceeded");
    await admin.attachExternal({ principalId: "org-acme", source: "demo:key-exfiltration-attack", credentialId: fetcherId, data: { attempted: { ...auth, amount: auth.amount.toString(), validBefore: auth.validBefore.toString(), validAfter: "0" }, submitter: attacker.account.address, result: revert } });
    step("chain denies with stolen key", onchainDenied, `payWithAuthorization reverted: ${revert}`);

    // ── 7. kill switch ─────────────────────────────────────────────────────────────
    const ks = await admin.killSwitch("org-acme", true, "demo: suspected compromise");
    const duringKill = await fetcher.pay({ url: quoteUrl, maxAmount: "0.02", purpose: "research" });
    const chainPaused = await pub.readContract({ address: account, abi: AgentAccountAbi, functionName: "paused" });
    step("kill switch", !duringKill.ok && chainPaused === true, `gateway: ${duringKill.decision?.reasons.join(",") ?? duringKill.error}; account.paused=${chainPaused} (tx ${(ks.txHash ?? "").slice(0, 10)}…)`);
    await admin.killSwitch("org-acme", false, "demo: cleared");

    // ── 8. anchor + export + verify ────────────────────────────────────────────────
    const anchor = await admin.anchor("org-acme");
    step("anchor", true, `receipt head ${anchor.head.slice(0, 10)}… (#${anchor.count}) anchored in tx ${anchor.txHash.slice(0, 10)}… block ${anchor.blockNumber}`);

    const evidence = await admin.exportEvidence("org-acme");
    const evidenceFile = opts.evidenceOut ?? join(REPO, "evidence", `thin-slice-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    mkdirSync(dirname(evidenceFile), { recursive: true });
    writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
    const offline = await verifyBundle(JSON.parse(readFileSync(evidenceFile, "utf8")) as EvidenceBundle);
    const withChain = await verifyEvidence(JSON.parse(readFileSync(evidenceFile, "utf8")), { rpcUrl });
    step("evidence bundle", offline.ok && withChain.ok, `${evidence.receipts.length} receipts, ${evidence.credentials.length} credentials, ${evidence.anchors.length} anchor → ${evidenceFile}`);
    log(formatReport(withChain));

    // ── balances ───────────────────────────────────────────────────────────────────
    const acctBal = await gw.chain.usdcBalance(usdc, account);
    const payeeBal = await gw.chain.usdcBalance(usdc, payeeTreasury);
    const spent = gw.store.spent();
    log(`\nbalances: AgentAccount ${toHuman(acctBal)} USDC, payee ${toHuman(payeeBal)} USDC`);
    log(`ledger:   ${JSON.stringify(Object.fromEntries(Object.entries(spent.byBudget).map(([k, v]) => [k, toHuman(v)])))} by budget; ${Object.keys(spent.byCredential).length} credential nodes charged`);

    return { gateway: gatewayUrl, contracts, steps, evidenceFile, evidence, verification: withChain };
  } finally {
    await payee?.close();
    await gw?.close();
    if (!opts.keepAnvil) anvil.kill();
  }
}

function summarise(r: PayResponse): string {
  if (r.ok) return `${r.rail} settled ${toHuman(r.settlement!.amount)} USDC in tx ${r.settlement!.txHash.slice(0, 10)}… → ${JSON.stringify(r.body)}`;
  return `${r.error}`;
}

function anvilPath(): string {
  const candidates = [process.env.ANVIL, join(homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil"), "anvil"].filter(Boolean) as string[];
  for (const c of candidates) if (c === "anvil" || existsSync(c)) return c;
  return "anvil";
}

async function startAnvil(port: number, chainId: number, log: (l: string) => void): Promise<ChildProcess> {
  const bin = anvilPath();
  const child = spawn(bin, ["--port", String(port), "--chain-id", String(chainId), "--silent"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += String(d)));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`anvil exited: ${stderr || "is Foundry installed? https://getfoundry.sh"}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) {
        log(`anvil up on :${port} (${bin})`);
        return child;
      }
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error("anvil did not start in 20s");
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  runThinSlice()
    .then((s) => {
      const failed = s.steps.filter((x) => !x.ok);
      console.log(`\n${failed.length === 0 ? "THIN SLICE PASSED" : "THIN SLICE FAILED"}: ${s.steps.length - failed.length}/${s.steps.length} steps`);
      process.exit(failed.length === 0 ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
