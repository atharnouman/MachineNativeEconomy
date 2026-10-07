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
    this.pub = createPublicClient({ chain: this.chain, transport: http(cfg.rpcUrl) });
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
