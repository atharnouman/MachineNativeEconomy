import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex } from "viem";
import { AgentAccountAbi, describeRevert, verifyBundle, credentialId, toHuman, type EvidenceBundle } from "@spendmarshal/core";
import { ANVIL_KEYS, MockLightning, startAnvil, deployCore, delegateEoaToAccount, mintUsdc, usdcBalance, grantRootSession, ownerUnpause, readSession, walletFor } from "@spendmarshal/devnet";
import { preimageMatches } from "@spendmarshal/core";
import { buildGateway, type Gateway } from "@spendmarshal/gateway";
import { buildPayee } from "@spendmarshal/payee";
import { SpendMarshalAdmin, SpendMarshalClient, SpendMarshalError, generateHolderKey, type PayResponse } from "@spendmarshal/sdk";
import { verifyEvidence, formatReport } from "@spendmarshal/cli";

/**
 * Phase 1 demo. Everything Phase 0 showed, plus:
 *   - an existing EOA becomes the agent account via EIP-7702 and keeps its funds in place
 *   - the gateway is a bounded operator (root session granted by the owner), not the owner
 *   - lineage spend is visible on-chain: the root session's `spent` equals every descendant's settlements
 *   - budget periods and a rate-limit caveat stop a sub-agent, with reasons in receipts
 *   - an escalated payment is approved with a CFO-key signature, resumed and settled; another is rejected
 *   - a policy update is receipted with a diff and an impact list; later decisions cite the new hash
 *   - the gateway pauses from its session key; only the owner can unpause
 *   - the evidence bundle verifies offline, including policy versions and approval signatures
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

const KEYS = {
  gateway: ANVIL_KEYS[0]!,
  payeeRelayer: ANVIL_KEYS[1]!,
  payeeTreasury: ANVIL_KEYS[2]!,
  alice: ANVIL_KEYS[3]!, // the principal's existing EOA
  cfo: ANVIL_KEYS[4]!, // registered approver
};

export interface Phase1Options {
  rpcPort?: number;
  gatewayPort?: number;
  payeePort?: number;
  dataDir?: string;
  evidenceOut?: string;
  log?: (line: string) => void;
}

export interface Phase1Summary {
  steps: Array<{ step: string; ok: boolean; detail: string }>;
  evidenceFile: string;
  evidence: EvidenceBundle;
  verification: { ok: boolean; checks: Array<{ check: string; ok: boolean; detail?: string }> };
}

export async function runPhase1(opts: Phase1Options = {}): Promise<Phase1Summary> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const rpcPort = opts.rpcPort ?? 8545;
  const gatewayPort = opts.gatewayPort ?? 4402;
  const payeePort = opts.payeePort ?? 4403;
  const dataDir = opts.dataDir ?? join(REPO, "data", "phase1");
  const steps: Phase1Summary["steps"] = [];
  const step = (name: string, ok: boolean, detail: string) => {
    steps.push({ step: name, ok, detail });
    log(`${ok ? "✔" : "✘"} ${name}: ${detail}`);
  };
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });

  const net = await startAnvil({ port: rpcPort, log });
  let gw: Gateway | undefined;
  let payee: ReturnType<typeof buildPayee> | undefined;
  try {
    // ── 1. contracts + an EOA that already holds USDC ───────────────────────────────
    const core = await deployCore(net, KEYS.gateway);
    const alice = privateKeyToAccount(KEYS.alice);
    const gatewayAddr = privateKeyToAccount(KEYS.gateway).address;
    const cfo = privateKeyToAccount(KEYS.cfo);
    const payeeTreasury = privateKeyToAccount(KEYS.payeeTreasury).address;
    await mintUsdc(net, KEYS.gateway, core.usdc, alice.address, 10_000_000n);
    const before = await usdcBalance(net, core.usdc, alice.address);

    // ── 2. EIP-7702: Alice's EOA becomes an AgentAccount in one transaction ─────────
    const del = await delegateEoaToAccount(net, KEYS.alice, core);
    const after = await usdcBalance(net, core.usdc, alice.address);
    const owner = await net.pub.readContract({ address: alice.address, abi: AgentAccountAbi, functionName: "owner" });
    step("EIP-7702 delegation", after === before && owner.toLowerCase() === alice.address.toLowerCase(), `EOA ${alice.address} now runs AgentAccount code (tx ${del.delegationTx.slice(0, 10)}…), owner is itself, balance unchanged at ${toHuman(after)} USDC`);

    let initReason = "";
    try {
      await walletFor(net, KEYS.payeeRelayer).writeContract({ address: alice.address, abi: AgentAccountAbi, functionName: "initialize", args: [privateKeyToAccount(KEYS.payeeRelayer).address] });
      initReason = "NO REVERT (bug)";
    } catch (err) {
      initReason = describeRevert(err);
    }
    step("initialize is self-only", initReason.startsWith("NotSelf"), `a stranger calling initialize on Alice's account reverted: ${initReason}`);

    // ── 3. the owner grants the gateway a bounded root session ──────────────────────
    const validUntil = BigInt(Math.floor(Date.now() / 1000) + 2 * 86_400);
    await grantRootSession(net, KEYS.alice, alice.address, { key: gatewayAddr, spendCap: 3_000_000n, perTxMax: 500_000n, validUntil, targets: [payeeTreasury], tokens: [core.usdc] });
    const rootSession = await readSession(net, alice.address, gatewayAddr);
    step("gateway is a bounded operator", rootSession.active && rootSession.parent === "0x0000000000000000000000000000000000000000", `owner granted gateway ${gatewayAddr} a root session: cap ${toHuman(rootSession.spendCap)}, perTx ${toHuman(rootSession.perTxMax)}, payee allowlist`);

    // ── 4. gateway + payee (sharing one mock Lightning network for the L402 rail) ───────
    const lightning = new MockLightning();
    gw = await buildGateway({
      host: "127.0.0.1",
      port: gatewayPort,
      rpcUrl: net.rpcUrl,
      chainId: net.chainId,
      gatewayPrivateKey: KEYS.gateway,
      sessionSecret: "dev-session-secret-change-me",
      credentialRootKey: "dev-credential-root-key-change-me",
      adminToken: "dev-admin-token",
      dataDir,
      storeDriver: "sqlite",
      policyYaml: readFileSync(join(HERE, "policy-v1.yaml"), "utf8"),
      contracts: { usdc: core.usdc, receiptRegistry: core.receiptRegistry, enforcers: core.enforcers },
      principals: { "org-acme": { account: alice.address, ownerIsGateway: false } },
      asset: { symbol: "USDC", decimals: 6 },
      facilitator: { enabled: true },
      authorizationTtlSeconds: 120,
      approvers: { cfo: cfo.address },
      approvalTtlSeconds: 600,
      lightning,
      fx: { satsPerUsdc: 1600 },
      payeeTimeoutMs: 3_000, // the demo shows a payee that never answers; an MPP settlement relayed by the payee takes well under a second
      outbound: { allowLoopback: true }, // the demo payee is on this machine; private and link-local ranges stay refused
    });
    const gatewayUrl = await gw.listen();
    payee = buildPayee({
      host: "127.0.0.1",
      port: payeePort,
      token: core.usdc,
      chainId: net.chainId,
      pricing: { rails: ["x402", "mpp"], payTo: payeeTreasury, facilitatorUrl: `${gatewayUrl}/facilitator`, mpp: { rpcUrl: net.rpcUrl, relayerPrivateKey: KEYS.payeeRelayer }, agentAuth: { require: true, allowedAgents: [gatewayUrl] } },
      eip712: { name: "USD Coin (mock)", version: "2" },
      lightning: { node: lightning, macaroonSecret: "payee-macaroon-secret" },
      feedInterval: "1s",
    });
    const payeeUrl = await payee.listen();
    const admin = new SpendMarshalAdmin(gatewayUrl, "dev-admin-token");
    const health = await admin.health();
    step("services", health.policies["org-acme"]?.version === 1, `gateway ${gatewayUrl} (store: sqlite), payee ${payeeUrl}, policy v1 ${health.policies["org-acme"]?.hash.slice(0, 10)}…`);

    // ── 4a. the payee only talks to governed agents: unsigned callers get 401 + Accept-Signature ──
    const anonymous = await fetch(`${payeeUrl}/v1/quote?symbol=ETH`);
    const directory = await fetch(`${gatewayUrl}/.well-known/http-message-signatures-directory`);
    const dirBody = (await directory.json()) as { keys: Array<{ kid: string }> };
    step(
      "payee requires Web Bot Auth",
      anonymous.status === 401 && (anonymous.headers.get("accept-signature") ?? "").includes("web-bot-auth") && dirBody.keys[0]?.kid === health.agentKeyId && !!directory.headers.get("signature"),
      `anonymous GET → ${anonymous.status} Accept-Signature: ${anonymous.headers.get("accept-signature")}; gateway key ${health.agentKeyId?.slice(0, 12)}… published in a signed directory`,
    );

    // ── 5. credentials: research-agent (child of the gateway session) → fetcher ─────
    const payeeHost = new URL(payeeUrl).host;
    const researchAgent = await admin.issueCredential({
      principalId: "org-acme",
      agentId: "research-agent",
      caveats: [
        { type: "spend_cap", value: "1000000" },
        { type: "per_tx_max", value: "300000" },
        { type: "allowed_payees", value: [payeeHost, payeeTreasury] },
        { type: "allowed_rails", value: ["x402", "mpp", "l402"] },
        { type: "purposes", value: ["research"] },
        { type: "expires_at", value: new Date(Date.now() + 24 * 3600 * 1000).toISOString() },
      ],
    });
    const fetcher = await researchAgent.delegate({
      agentId: "research-agent/fetcher",
      caveats: [
        { type: "spend_cap", value: "100000" },
        { type: "per_tx_max", value: "20000" },
        { type: "rate_limit", window: "10m", max_count: 3 },
      ],
      bindTo: "new", // holder-bound: the sub-agent's credential only works with its own Ed25519 key
    });
    const raReg = gw.store.getCredential(credentialId(researchAgent.credential))!;
    const raSession = await readSession(net, alice.address, raReg.sessionKey as `0x${string}`);
    step("credential chain mirrors on-chain", raReg.parentSessionKey?.toLowerCase() === gatewayAddr.toLowerCase() && raSession.parent.toLowerCase() === gatewayAddr.toLowerCase(), `research-agent session ${raReg.sessionKey.slice(0, 10)}… has parent = gateway root session; fetcher is its child`);

    // ── 6. sub-agent: three payments, then the rate-limit caveat ────────────────────
    const quoteUrl = `${payeeUrl}/v1/quote?symbol=ETH`;
    const rails = ["x402", "mpp", "auto"] as const;
    const fetcherPays: PayResponse[] = [];
    for (const rail of rails) fetcherPays.push(await fetcher.pay({ url: quoteUrl, maxAmount: "0.02", purpose: "research", rail }));
    step("sub-agent pays over both rails", fetcherPays.every((p) => p.ok), fetcherPays.map(summarise).join(" | "));
    const lastSettled = payee.settled[payee.settled.length - 1];
    step("payee saw a signed, governed agent", lastSettled?.agent?.keyid === health.agentKeyId && lastSettled?.agent?.signatureAgent === gatewayUrl, `Signature-Agent ${lastSettled?.agent?.signatureAgent}, key ${lastSettled?.agent?.keyid?.slice(0, 12)}…`);

    // the gateway is not an open proxy: an agent cannot make it fetch a private address, policy or not
    let proxy: { ok?: boolean; status?: number; error?: string } = {};
    try {
      proxy = await fetcher.pay({ url: "http://169.254.169.254/latest/meta-data/", maxAmount: "0.01", purpose: "research" });
    } catch (e) {
      proxy = { ok: false, status: (e as SpendMarshalError).status, error: (e as Error).message };
    }
    step("gateway refuses to fetch private addresses", proxy.ok === false && proxy.status === 403 && (proxy.error ?? "").includes("private"), `${proxy.status} ${proxy.error}`);

    // a stolen bearer credential is useless without the holder key: wrong key → 401, no payment, no signing
    const thief = new SpendMarshalClient(gatewayUrl, fetcher.credential, { holderKey: generateHolderKey().privateJwk });
    let theftStatus = 0;
    let theftMessage = "";
    try {
      await thief.pay({ url: quoteUrl, maxAmount: "0.02", purpose: "research" });
    } catch (e) {
      theftStatus = (e as SpendMarshalError).status;
      theftMessage = (e as Error).message;
    }
    step("stolen credential is useless without the holder key", theftStatus === 401 && theftMessage.includes("holder signature"), `${theftStatus} ${theftMessage}`);
    const fourth = await fetcher.pay({ url: quoteUrl, maxAmount: "0.02", purpose: "research" });
    step("rate_limit caveat stops the 4th payment in 10m", !fourth.ok && (fourth.decision?.reasons[0] ?? "").startsWith("CAVEAT:rate_limit"), `${fourth.error}`);

    // ── 7. escalation: approve with the CFO key, resume; then a rejection ───────────
    const reportUrl = `${payeeUrl}/v1/report?symbol=ETH`;
    const pending = await researchAgent.pay({ url: reportUrl, maxAmount: "0.05", purpose: "research", rail: "x402" });
    step("escalation returns 202", pending.status === 202 && !!pending.pending, `report costs 0.04 > 0.03 threshold → approval ${pending.pending?.approvalId} pending (${pending.pending?.reasons.join(",")})`);
    const approvalId = pending.pending!.approvalId;
    const pendingList = await admin.listApprovals("org-acme", "pending");
    const granted = await admin.resolveApproval(approvalId, "approve", "cfo", { signer: cfo, note: "ok for Q4 research", approval: pendingList.find((a) => a.id === approvalId)! });
    step("CFO signs the approval", granted.status === "approved" && granted.approver?.method === "signature", `approver ${granted.approver?.id} (${granted.approver?.address?.slice(0, 10)}…), signature ${granted.approver?.signature?.slice(0, 12)}…`);
    const resumed = await researchAgent.resume(approvalId);
    step("resume settles under the approval", resumed.ok && resumed.decision?.approvalId === approvalId, summarise(resumed));

    const pending2 = await researchAgent.pay({ url: reportUrl, maxAmount: "0.05", purpose: "research", rail: "mpp" });
    const rejected = await admin.resolveApproval(pending2.pending!.approvalId, "reject", "cfo", { signer: cfo, note: "one report is enough", approval: (await admin.listApprovals("org-acme", "pending")).find((a) => a.id === pending2.pending!.approvalId)! });
    const resumedRejected = await researchAgent.resume(pending2.pending!.approvalId);
    step("rejected approval cannot be resumed", rejected.status === "rejected" && !resumedRejected.ok && resumedRejected.status === 403, `${resumedRejected.error}`);

    // ── 8a. standard x402 payload: pre-approve on-chain, settle via plain EIP-3009 + ERC-1271 ──
    const std = await researchAgent.pay({ url: quoteUrl, maxAmount: "0.02", purpose: "research", rail: "x402", x402Mode: "standard" });
    step(
      "standard x402 payload via ERC-1271",
      std.ok && std.payloadKind === "standard" && !!std.settlement?.approvalTxHash,
      `account pre-approved the EIP-3009 digest (tx ${(std.settlement?.approvalTxHash ?? "").slice(0, 10)}…), facilitator settled with transferWithAuthorization (tx ${(std.settlement?.txHash ?? "").slice(0, 10)}…): works with any x402 facilitator`,
    );

    // ── 8b. an orphaned pre-approval (facilitator never settled) is reclaimed after it expires ──
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    {
      const raId = credentialId(researchAgent.credential);
      const spentBefore = (await readSession(net, alice.address, raReg.sessionKey as `0x${string}`)).spent;
      // a 30 s window on the chain's clock: long enough that a receipt-polling pause cannot expire it before the first reclaim call
      const chainNow = (await net.pub.getBlock({ blockTag: "latest" })).timestamp;
      const wallNow = BigInt(Math.floor(Date.now() / 1000));
      const validBefore = (chainNow > wallNow ? chainNow : wallNow) + 30n;
      const orphanAuth = { token: core.usdc, to: payeeTreasury, value: 1_000n, validAfter: 0n, validBefore, nonce: keccak256(toHex(`orphan-${Date.now()}`)), intentHash: keccak256(toHex("orphan-intent")) };
      const sig = await gw.signer.signTokenAuthorization(raId, alice.address, net.chainId, orphanAuth);
      const appr = await gw.chain.approveAuthorization(alice.address, orphanAuth, sig);
      if (appr.ok) gw.store.putPreApproval({ digest: appr.digest, principalId: "org-acme", account: alice.address, credentialId: raId, intentId: "int_orphan_demo", value: "1000", validBefore: orphanAuth.validBefore.toString(), approvalTxHash: appr.txHash, createdAt: new Date().toISOString(), state: "pending" });
      const spentCharged = (await readSession(net, alice.address, raReg.sessionKey as `0x${string}`)).spent;
      const tooEarly = await admin.reclaim("org-acme");
      // advance the dev chain's clock past the window instead of sleeping (anvil evm_increaseTime + evm_mine)
      const rpc = net.pub as unknown as { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
      await rpc.request({ method: "evm_increaseTime", params: [45] });
      await rpc.request({ method: "evm_mine", params: [] });
      const reclaimed = await admin.reclaim("org-acme");
      const spentAfter = (await readSession(net, alice.address, raReg.sessionKey as `0x${string}`)).spent;
      step(
        "orphaned pre-approval reclaimed after expiry",
        appr.ok && spentCharged === spentBefore + 1_000n && tooEarly.reclaimed === 0 && reclaimed.reclaimed === 1 && spentAfter === spentBefore,
        `30 s window; charge +0.001 at approval; reclaim inside the window → ${tooEarly.reclaimed} (pending ${tooEarly.pending}); chain clock +45 s → ${reclaimed.reclaimed} reclaimed (tx ${(reclaimed.results[0]?.txHash ?? "").slice(0, 10)}…), session spent back to ${toHuman(spentAfter)}`,
      );
    }

    // ── 8c. subscription: the payee charges on a cadence, the agent cancels ────────────
    const feed = await researchAgent.subscribe({ url: `${payeeUrl}/v1/feed`, purpose: "research", maxAmountPerCharge: "0.02", maxCharges: 3 });
    const feedPayee = payee.subscriptions.list().find((s) => s.agentSubscriptionId === feed.subscription?.id);
    step("subscription opened with its first charge", feed.ok && feed.subscription?.status === "active" && feed.firstCharge?.ok === true && !!feedPayee, `${feed.subscription?.terms.kind} ${toHuman(feed.subscription?.terms.amountPerCharge ?? "0")} USDC every ${feed.subscription?.terms.interval}, max ${feed.subscription?.terms.maxCharges} charges; payee holds charge token for ${feed.subscription?.chargeUrl.split("/v1/")[1]}`);
    // visibility follows the chain: the sub-agent (a child) cannot see or cancel its parent's subscription; the admin sees the principal
    const seenByChild = await fetcher.subscriptions();
    const seenByOpener = await researchAgent.subscriptions();
    const seenByAdmin = await admin.listSubscriptions("org-acme");
    let childCancelStatus = 0;
    try {
      await fetcher.cancelSubscription(feed.subscription!.id);
    } catch (e) {
      childCancelStatus = (e as SpendMarshalError).status;
    }
    step(
      "subscription visibility follows the credential chain",
      seenByChild.length === 0 && seenByOpener.some((s) => s.id === feed.subscription?.id) && seenByAdmin.some((s) => s.id === feed.subscription?.id) && childCancelStatus === 404,
      `child sees ${seenByChild.length}, opener sees ${seenByOpener.length}, admin sees ${seenByAdmin.length}; child cancel -> ${childCancelStatus}`,
    );
    const early = await payee.subscriptions.charge(feedPayee!.id);
    await sleep(1100);
    const onTime = await payee.subscriptions.charge(feedPayee!.id, { reference: "cycle-2" });
    const cancelled = await researchAgent.cancelSubscription(feed.subscription!.id);
    const afterCancel = await payee.subscriptions.charge(feedPayee!.id);
    step(
      "payee charges on cadence; agent cancels",
      early.status === 429 && !!early.nextAllowedAt && onTime.ok && onTime.charges === 2 && cancelled.status === "cancelled" && afterCancel.status === 410,
      `too early → 429 (next ${early.nextAllowedAt?.slice(11, 19)}); on time → settled ${toHuman(onTime.amount ?? "0")} tx ${(onTime.txHash ?? "").slice(0, 10)}…; after cancel → ${afterCancel.status} ${afterCancel.error}`,
    );

    // ── 8d. metered stream: usage-based charges within a per-cycle cap ────────────────
    const stream = await researchAgent.subscribe({ url: `${payeeUrl}/v1/stream`, purpose: "research", maxAmountPerCharge: "0.005" });
    const streamPayee = payee.subscriptions.list().find((s) => s.agentSubscriptionId === stream.subscription?.id);
    await sleep(1100);
    const usage = await payee.subscriptions.charge(streamPayee!.id, { units: 30, reference: "30 tokens" });
    await sleep(1100);
    const overCap = await payee.subscriptions.charge(streamPayee!.id, { units: 60, reference: "60 tokens" });
    step("metered stream", stream.ok && usage.ok && usage.amount === "3000" && overCap.status === 403, `30 tokens × 0.0001 → settled ${toHuman(usage.amount ?? "0")} USDC; 60 tokens (0.006) → ${overCap.status} ${overCap.error}`);

    // ── 8e. L402 (Lightning): a non-EVM rail, proof of payment is the preimage ───────
    const ln = await researchAgent.pay({ url: `${payeeUrl}/v1/lightning-quote`, maxAmount: "0.01", purpose: "research" });
    const lnProof = ln.settlement?.lightning;
    step(
      "L402 over Lightning",
      ln.ok && ln.rail === "l402" && !!lnProof && preimageMatches(lnProof.preimage, lnProof.paymentHash) && lnProof.delivered,
      ln.ok
        ? `${lnProof?.amountSats} sats at ${lnProof?.satsPerUsdc} sats/USDC = ${toHuman(ln.settlement?.amount ?? "0")} USDC against policy; preimage ${lnProof?.preimage.slice(0, 12)}… matches invoice hash ${lnProof?.paymentHash.slice(0, 12)}…`
        : `${ln.status} ${ln.error}`,
    );

    // ── 8f. daily budget: research-agent fills the rest, then is stopped ─────────────
    const quotes: PayResponse[] = [];
    for (let i = 0; i < 3; i++) quotes.push(await researchAgent.pay({ url: quoteUrl, maxAmount: "0.02", purpose: "research" }));
    const overBudget = await researchAgent.pay({ url: quoteUrl, maxAmount: "0.02", purpose: "research" });
    step("daily budget period", quotes.every((q) => q.ok) && !overBudget.ok && overBudget.decision?.reasons.includes("BUDGET:research-daily") === true, `every rail and subscription charge counts against the same daily cap; next: ${overBudget.decision?.checks?.find((c) => c.check === "budget:research-daily")?.detail}`);

    // ── 9. lineage accounting on-chain ─────────────────────────────────────────────
    const root = await readSession(net, alice.address, gatewayAddr);
    const ra = await readSession(net, alice.address, raReg.sessionKey as `0x${string}`);
    const fe = await readSession(net, alice.address, gw.store.getCredential(credentialId(fetcher.credential))!.sessionKey as `0x${string}`);
    const payeeBal = await usdcBalance(net, core.usdc, payeeTreasury);
    step("lineage spend on-chain", root.spent === payeeBal && ra.spent === payeeBal && fe.spent === 30_000n, `gateway root spent ${toHuman(root.spent)} = research-agent ${toHuman(ra.spent)} = payee USDC balance ${toHuman(payeeBal)} (Lightning spend is off-chain: ${lightning.paidSats} sats); fetcher ${toHuman(fe.spent)}`);

    // ── 10. policy update with impact analysis ──────────────────────────────────────
    const update = await admin.updatePolicy("org-acme", readFileSync(join(HERE, "policy-v2.yaml"), "utf8"), "alice@org-acme");
    const impactedReport = update.impact.find((i) => i.resource.startsWith("/v1/report"));
    const afterV2 = await researchAgent.simulate({ url: reportUrl, maxAmount: "0.05", purpose: "research", rail: "x402" });
    step("policy v2 receipted with impact", update.version.version === 2 && !!impactedReport && afterV2.decision?.policyHash === update.version.hash && afterV2.decision?.reasons.includes("RULE_DENY:deny-full-reports") === true, `diff rules ${update.diff.rules?.join(",")}; impact: ${update.impact.length} past intent(s) now ${impactedReport?.nowEffect} (${impactedReport?.reasons.join(",")}); simulate now cites v2 ${update.version.hash.slice(0, 10)}…`);

    // ── 11. kill switch: gateway session may pause, only the owner may unpause ──────
    const ks = await admin.killSwitch("org-acme", true, "demo: suspected compromise");
    const duringKill = await researchAgent.pay({ url: quoteUrl, maxAmount: "0.02", purpose: "research" });
    const pausedOnChain = await net.pub.readContract({ address: alice.address, abi: AgentAccountAbi, functionName: "paused" });
    const ksOff = await admin.killSwitch("org-acme", false, "demo: cleared by gateway (will not unpause chain)");
    const stillPaused = await net.pub.readContract({ address: alice.address, abi: AgentAccountAbi, functionName: "paused" });
    await ownerUnpause(net, KEYS.alice, alice.address);
    const unpaused = await net.pub.readContract({ address: alice.address, abi: AgentAccountAbi, functionName: "paused" });
    step("kill switch: session key pauses, owner unpauses", ks.onchain === "paused" && !duringKill.ok && pausedOnChain === true && ksOff.onchain.startsWith("owner-required") && stillPaused === true && unpaused === false, `gateway paused on-chain (${(ks.txHash ?? "").slice(0, 10)}…); gateway unpause → ${ksOff.onchain}; owner unpause → paused=${unpaused}`);

    // ── 12. load shape: one relayer key, five agents paying at once; a retried request pays once; a dead payee times out ──
    const opsAgent = await admin.issueCredential({
      principalId: "org-acme",
      agentId: "ops-agent",
      caveats: [
        { type: "spend_cap", value: "500000" },
        { type: "per_tx_max", value: "20000" },
        { type: "allowed_payees", value: [payeeHost, payeeTreasury] },
        { type: "allowed_rails", value: ["x402", "mpp"] },
        { type: "purposes", value: ["research"] },
      ],
    });
    const burst = await Promise.all([1, 2, 3, 4, 5].map(() => opsAgent.pay({ url: quoteUrl, maxAmount: "0.02", purpose: "research", rail: "x402" })));
    const burstTx = new Set(burst.map((p) => p.settlement?.txHash));
    step("five concurrent payments settle through one relayer key", burst.every((p) => p.ok) && burstTx.size === 5, burst.map(summarise).join(" | "));
    const retryKey = `retry-${Date.now()}`;
    const firstTry = await opsAgent.pay({ url: quoteUrl, maxAmount: "0.02", purpose: "research", rail: "x402", idempotencyKey: retryKey });
    const retried = (await opsAgent.pay({ url: quoteUrl, maxAmount: "0.02", purpose: "research", rail: "x402", idempotencyKey: retryKey })) as PayResponse & { replayed?: boolean };
    step(
      "a retried request with the same Idempotency-Key pays once",
      firstTry.ok && retried.ok && retried.replayed === true && retried.settlement?.txHash === firstTry.settlement?.txHash,
      `first ${summarise(firstTry)}; retry replayed=${retried.replayed}, same settlement=${retried.settlement?.txHash === firstTry.settlement?.txHash}`,
    );
    let slow: { ok?: boolean; status?: number; error?: string } = {};
    try {
      slow = await opsAgent.pay({ url: `${payeeUrl}/v1/slow`, maxAmount: "0.02", purpose: "research" });
    } catch (e) {
      slow = { ok: false, status: (e as SpendMarshalError).status, error: (e as Error).message };
    }
    step("a payee that never answers times out, nothing reserved", slow.ok === false && slow.status === 502 && (slow.error ?? "").includes("timeout"), `${slow.status} ${slow.error}`);

    // ── 11b. observability: Prometheus metrics and the OpenAPI document ─────────────
    const metricsText = await admin.metrics();
    const openapi = (await admin.openapi()) as { openapi?: string; paths?: Record<string, unknown> };
    const settledCount = /spendmarshal_payments_total\{rail="x402",outcome="settled",payload_kind="standard"\} (\d+)/.exec(metricsText)?.[1];
    step(
      "metrics + OpenAPI",
      metricsText.includes("spendmarshal_payments_total") && metricsText.includes("spendmarshal_receipts_total") && settledCount === "1" && openapi.openapi === "3.1.0" && Object.keys(openapi.paths ?? {}).length >= 20,
      `/metrics has spendmarshal_payments_total (standard x402 settled = ${settledCount}); /openapi.json is OpenAPI ${openapi.openapi} with ${Object.keys(openapi.paths ?? {}).length} paths`,
    );

    // ── 12. anchor, export, verify ─────────────────────────────────────────────────
    const anchor = await admin.anchor("org-acme");
    const evidence = await admin.exportEvidence("org-acme");
    const evidenceFile = opts.evidenceOut ?? join(REPO, "evidence", `phase1-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    mkdirSync(dirname(evidenceFile), { recursive: true });
    writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
    const offline = await verifyBundle(JSON.parse(readFileSync(evidenceFile, "utf8")) as EvidenceBundle);
    const withChain = await verifyEvidence(JSON.parse(readFileSync(evidenceFile, "utf8")), { rpcUrl: net.rpcUrl });
    const approvalsCheck = withChain.checks.find((c) => c.check === "approvals");
    step("evidence bundle", offline.ok && withChain.ok, `${evidence.receipts.length} receipts, ${evidence.policyVersions.length} policy versions, ${evidence.credentials.length} credentials, anchor #${anchor.count}; approvals: ${approvalsCheck?.detail} → ${evidenceFile}`);
    log(formatReport(withChain));
    log(`\nbalances: Alice (EOA account) ${toHuman(await usdcBalance(net, core.usdc, alice.address))} USDC, payee ${toHuman(payeeBal)} USDC`);

    return { steps, evidenceFile, evidence, verification: withChain };
  } finally {
    await payee?.close();
    await gw?.close();
    net.stop();
  }
}

function summarise(r: PayResponse): string {
  if (r.ok) return `${r.rail} ${toHuman(r.settlement!.amount)} USDC tx ${r.settlement!.txHash.slice(0, 10)}…`;
  if (r.status === 202) return `202 pending ${r.pending?.approvalId}`;
  return `${r.status} ${r.error}`;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  runPhase1()
    .then((s) => {
      const failed = s.steps.filter((x) => !x.ok);
      console.log(`\n${failed.length === 0 ? "PHASE 1 PASSED" : "PHASE 1 FAILED"}: ${s.steps.length - failed.length}/${s.steps.length} steps`);
      process.exit(failed.length === 0 ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
