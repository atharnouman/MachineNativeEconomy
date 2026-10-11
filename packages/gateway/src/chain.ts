import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Chain,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AgentAccountAbi,
  ReceiptRegistryAbi,
  MockUSDCAbi,
  chainFor,
  decodeRevert,
  describeRevert,
  type PaymentAuthorizationStruct,
  type TokenAuthorizationStruct,
} from "@apgw/core";
import type { GatewayConfig } from "./config.js";

export interface SessionCaveatsOnChain {
  spendCap: bigint;
  perTxMax: bigint;
  validAfter: bigint;
  validUntil: bigint;
  anyTarget: boolean;
  targets: Address[];
  tokens: Address[];
}

/** Thin wrapper over viem for everything the gateway does on-chain. */
export class ChainClient {
  readonly chain: Chain;
  readonly pub: PublicClient;
  readonly wallet: WalletClient<ReturnType<typeof http>, Chain, Account>;

  constructor(private readonly cfg: Pick<GatewayConfig, "rpcUrl" | "chainId" | "gatewayPrivateKey">) {
    this.chain = chainFor(cfg.chainId, cfg.rpcUrl);
    this.pub = createPublicClient({ chain: this.chain, transport: http(cfg.rpcUrl), pollingInterval: 500 }); // receipts within a block, not viem's 4 s default
    this.wallet = createWalletClient({ chain: this.chain, transport: http(cfg.rpcUrl), account: privateKeyToAccount(cfg.gatewayPrivateKey) });
  }

  async grantSession(account: Address, key: Address, c: SessionCaveatsOnChain): Promise<Hex> {
    const hash = await this.wallet.writeContract({
      address: account,
      abi: AgentAccountAbi,
      functionName: "grantSession",
      args: [key, c.spendCap, c.perTxMax, c.validAfter, c.validUntil, c.anyTarget, c.targets, c.tokens],
    });
    await this.pub.waitForTransactionReceipt({ hash });
    return hash;
  }

  async grantChildSession(account: Address, parentKey: Address, key: Address, c: SessionCaveatsOnChain): Promise<Hex> {
    const hash = await this.wallet.writeContract({
      address: account,
      abi: AgentAccountAbi,
      functionName: "grantChildSession",
      args: [parentKey, key, c.spendCap, c.perTxMax, c.validAfter, c.validUntil, c.anyTarget, c.targets, c.tokens],
    });
    const r = await this.pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("grantChildSession reverted");
    return hash;
  }

  async setPaused(account: Address, paused: boolean): Promise<Hex> {
    const hash = await this.wallet.writeContract({ address: account, abi: AgentAccountAbi, functionName: paused ? "pause" : "unpause", args: [] });
    await this.pub.waitForTransactionReceipt({ hash });
    return hash;
  }

  /** The later of the latest block's timestamp and the wall clock: the next block cannot be earlier than either. */
  async now(): Promise<bigint> {
    const latest = await this.pub.getBlock({ blockTag: "latest" });
    const wall = BigInt(Math.floor(Date.now() / 1000));
    return latest.timestamp > wall ? latest.timestamp : wall;
  }

  async readSession(account: Address, key: Address) {
    return this.pub.readContract({ address: account, abi: AgentAccountAbi, functionName: "getSession", args: [key] });
  }

  async simulate(account: Address, auth: PaymentAuthorizationStruct, signer: Address): Promise<{ ok: boolean; reason: string | null }> {
    const [ok, data] = (await this.pub.readContract({ address: account, abi: AgentAccountAbi, functionName: "simulate", args: [auth, signer] })) as readonly [boolean, Hex];
    if (ok) return { ok: true, reason: null };
    const d = decodeRevert(data);
    return { ok: false, reason: d ? `${d.name}(${d.args.join(",")})` : "unknown revert" };
  }

  async payWithAuthorization(account: Address, auth: PaymentAuthorizationStruct, sig: Hex): Promise<{ ok: true; txHash: Hex; blockNumber: bigint } | { ok: false; reason: string }> {
    try {
      const hash = await this.wallet.writeContract({ address: account, abi: AgentAccountAbi, functionName: "payWithAuthorization", args: [auth, sig] });
      const r = await this.pub.waitForTransactionReceipt({ hash });
      return r.status === "success" ? { ok: true, txHash: hash, blockNumber: r.blockNumber } : { ok: false, reason: "reverted" };
    } catch (err) {
      return { ok: false, reason: describeRevert(err) };
    }
  }

  /**
   * Standard-x402 interop: have the account pre-approve an EIP-3009 transfer under session caveats. The gateway
   * pays gas for this one; the facilitator then settles with `transferWithAuthorization` and ERC-1271.
   */
  async approveAuthorization(account: Address, auth: TokenAuthorizationStruct, sig: Hex): Promise<{ ok: true; txHash: Hex; blockNumber: bigint; digest: Hex } | { ok: false; reason: string }> {
    try {
      const hash = await this.wallet.writeContract({ address: account, abi: AgentAccountAbi, functionName: "approveAuthorization", args: [auth, sig] });
      const r = await this.pub.waitForTransactionReceipt({ hash });
      if (r.status !== "success") return { ok: false, reason: "reverted" };
      const { parseEventLogs } = await import("viem");
      const ev = parseEventLogs({ abi: AgentAccountAbi, logs: r.logs, eventName: "AuthorizationApproved" })[0];
      return { ok: true, txHash: hash, blockNumber: r.blockNumber, digest: (ev?.args.tokenDigest ?? "0x") as Hex };
    } catch (err) {
      return { ok: false, reason: describeRevert(err) };
    }
  }

  /** Restore the charge of an expired, unused pre-approval (anyone may call; the contract checks expiry and token nonce state). */
  async reclaimApproval(account: Address, digest: Hex): Promise<{ ok: true; txHash: Hex } | { ok: false; reason: string }> {
    try {
      const hash = await this.wallet.writeContract({ address: account, abi: AgentAccountAbi, functionName: "reclaimApproval", args: [digest] });
      const r = await this.pub.waitForTransactionReceipt({ hash });
      return r.status === "success" ? { ok: true, txHash: hash } : { ok: false, reason: "reverted" };
    } catch (err) {
      return { ok: false, reason: describeRevert(err) };
    }
  }

  /** Confirms a standard EIP-3009 settlement: the token emitted AuthorizationUsed(account, nonce) and Transfer(account → payTo, amount). */
  async confirmStandardPayment(txHash: Hex, token: Address, account: Address, payTo: Address, amount: bigint, nonce: Hex): Promise<{ ok: boolean; blockNumber?: bigint; reason?: string }> {
    const r = await this.pub.waitForTransactionReceipt({ hash: txHash });
    if (r.status !== "success") return { ok: false, reason: "tx reverted" };
    const { parseEventLogs } = await import("viem");
    const tokenLogs = r.logs.filter((l) => l.address.toLowerCase() === token.toLowerCase());
    const used = parseEventLogs({ abi: MockUSDCAbi, logs: tokenLogs, eventName: "AuthorizationUsed" }).some((l) => l.args.authorizer.toLowerCase() === account.toLowerCase() && l.args.nonce === nonce);
    const moved = parseEventLogs({ abi: MockUSDCAbi, logs: tokenLogs, eventName: "Transfer" }).some((l) => l.args.from.toLowerCase() === account.toLowerCase() && l.args.to.toLowerCase() === payTo.toLowerCase() && l.args.value === amount);
    return used && moved ? { ok: true, blockNumber: r.blockNumber } : { ok: false, reason: `missing ${used ? "" : "AuthorizationUsed "}${moved ? "" : "Transfer"} event` };
  }

  /** Confirms a settlement the payee or facilitator claims: tx succeeded and emitted PaymentExecuted for our intent. */
  async confirmPayment(txHash: Hex, account: Address, intentHash: Hex, amount: bigint, to: Address): Promise<{ ok: boolean; blockNumber?: bigint; reason?: string }> {
    const r = await this.pub.waitForTransactionReceipt({ hash: txHash });
    if (r.status !== "success") return { ok: false, reason: "tx reverted" };
    const { parseEventLogs } = await import("viem");
    const logs = parseEventLogs({ abi: AgentAccountAbi, logs: r.logs, eventName: "PaymentExecuted" });
    const hit = logs.find(
      (l) => l.address.toLowerCase() === account.toLowerCase() && l.args.intentHash === intentHash && l.args.amount === amount && l.args.to.toLowerCase() === to.toLowerCase(),
    );
    return hit ? { ok: true, blockNumber: r.blockNumber } : { ok: false, reason: "no matching PaymentExecuted event" };
  }

  async anchor(registry: Address, head: Hex, prevHead: Hex, count: bigint): Promise<{ txHash: Hex; blockNumber: bigint }> {
    const hash = await this.wallet.writeContract({ address: registry, abi: ReceiptRegistryAbi, functionName: "anchor", args: [head, prevHead, count] });
    const r = await this.pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("anchor reverted");
    return { txHash: hash, blockNumber: r.blockNumber };
  }

  async usdcBalance(token: Address, who: Address): Promise<bigint> {
    return this.pub.readContract({ address: token, abi: MockUSDCAbi, functionName: "balanceOf", args: [who] });
  }
}
