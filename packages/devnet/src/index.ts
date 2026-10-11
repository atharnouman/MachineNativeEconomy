import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, encodeFunctionData, type Address, type Hex, type PublicClient, type WalletClient, type Chain, type Account } from "viem";
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
} from "@spendmarshal/core";

export { MockLightning } from "./lightning.js";

/** anvil's well-known dev keys. Never use outside a local chain. */
export const ANVIL_KEYS: readonly Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
];

export interface Devnet {
  rpcUrl: string;
  chainId: number;
  chain: Chain;
  pub: PublicClient;
  stop(): void;
}

export function anvilPath(): string {
  const candidates = [process.env.ANVIL, join(homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil"), "anvil"].filter(Boolean) as string[];
  for (const c of candidates) if (c === "anvil" || existsSync(c)) return c;
  return "anvil";
}

/** Start a local anvil (Prague hardfork, so EIP-7702 type-4 transactions work) and wait for its RPC. */
export async function startAnvil(opts: { port?: number; chainId?: number; log?: (l: string) => void } = {}): Promise<Devnet> {
  const port = opts.port ?? 8545;
  const chainId = opts.chainId ?? 31337;
  const rpcUrl = `http://127.0.0.1:${port}`;
  const bin = anvilPath();
  const child: ChildProcess = spawn(bin, ["--port", String(port), "--chain-id", String(chainId), "--hardfork", "prague", "--silent"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += String(d)));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`anvil exited: ${stderr || "is Foundry installed? https://getfoundry.sh"}`);
    try {
      const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) break;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (child.exitCode !== null || Date.now() >= deadline) {
    child.kill();
    throw new Error("anvil did not start in 20s");
  }
  opts.log?.(`anvil up on :${port} (${bin.replace(homedir(), "~")}, prague)`);
  const chain = chainFor(chainId, rpcUrl);
  return { rpcUrl, chainId, chain, pub: createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 500 }), stop: () => child.kill() };
}

export function walletFor(net: Pick<Devnet, "chain" | "rpcUrl">, key: Hex): WalletClient<ReturnType<typeof http>, Chain, Account> {
  return createWalletClient({ chain: net.chain, transport: http(net.rpcUrl), account: privateKeyToAccount(key) });
}

export interface CoreContracts {
  usdc: Address;
  receiptRegistry: Address;
  enforcers: { spendLimit: Address; timeWindow: Address; allowedTargets: Address };
  /** Uninitialised AgentAccount: the EIP-7702 delegate target. */
  agentAccountImpl: Address;
}

/** Deploy USDC, the registry, the three enforcers and an uninitialised AgentAccount implementation. */
export async function deployCore(net: Devnet, deployerKey: Hex): Promise<CoreContracts> {
  const w = walletFor(net, deployerKey);
  const deploy = async (name: string, bytecode: Hex, abi: readonly unknown[] = [], args: unknown[] = []): Promise<Address> => {
    const hash = await w.deployContract({ abi: abi as never, bytecode, args: args as never });
    const r = await net.pub.waitForTransactionReceipt({ hash });
    if (!r.contractAddress) throw new Error(`deploy ${name} failed`);
    return r.contractAddress;
  };
  const usdc = await deploy("MockUSDC", MockUSDCBytecode);
  const receiptRegistry = await deploy("ReceiptRegistry", ReceiptRegistryBytecode);
  const spendLimit = await deploy("SpendLimitEnforcer", SpendLimitEnforcerBytecode);
  const timeWindow = await deploy("TimeWindowEnforcer", TimeWindowEnforcerBytecode);
  const allowedTargets = await deploy("AllowedTargetsEnforcer", AllowedTargetsEnforcerBytecode);
  const agentAccountImpl = await deploy("AgentAccount(impl)", AgentAccountBytecode, AgentAccountAbi, ["0x0000000000000000000000000000000000000000"]);
  return { usdc, receiptRegistry, enforcers: { spendLimit, timeWindow, allowedTargets }, agentAccountImpl };
}

/** Deploy a standalone AgentAccount owned by `owner`, with the enforcers set (owner key must be `ownerKey`). */
export async function deployStandaloneAccount(net: Devnet, ownerKey: Hex, core: CoreContracts): Promise<Address> {
  const w = walletFor(net, ownerKey);
  const hash = await w.deployContract({ abi: AgentAccountAbi, bytecode: AgentAccountBytecode, args: [w.account.address] });
  const r = await net.pub.waitForTransactionReceipt({ hash });
  if (!r.contractAddress) throw new Error("deploy AgentAccount failed");
  const account = r.contractAddress;
  await net.pub.waitForTransactionReceipt({
    hash: await w.writeContract({ address: account, abi: AgentAccountAbi, functionName: "setEnforcers", args: [[core.enforcers.spendLimit, core.enforcers.timeWindow, core.enforcers.allowedTargets]] }),
  });
  return account;
}

/**
 * EIP-7702: turn an existing EOA into an AgentAccount without moving its funds.
 * One type-4 transaction from the EOA to itself carries the delegation authorization and calls
 * `initialize(owner)`; because it is a self-call, nobody else can claim the account. A second transaction sets
 * the enforcers (owner only).
 */
export async function delegateEoaToAccount(net: Devnet, eoaKey: Hex, core: CoreContracts, owner?: Address): Promise<{ delegationTx: Hex; enforcersTx: Hex; account: Address }> {
  const w = walletFor(net, eoaKey);
  const eoa = w.account.address;
  const authorization = await w.signAuthorization({ contractAddress: core.agentAccountImpl, executor: "self" });
  const delegationTx = await w.sendTransaction({
    to: eoa,
    authorizationList: [authorization],
    data: encodeFunctionData({ abi: AgentAccountAbi, functionName: "initialize", args: [owner ?? eoa] }),
  });
  const r1 = await net.pub.waitForTransactionReceipt({ hash: delegationTx });
  if (r1.status !== "success") throw new Error("delegation transaction reverted");
  const code = await net.pub.getCode({ address: eoa });
  if (!code || !code.toLowerCase().startsWith("0xef0100")) throw new Error("EOA does not carry a 7702 delegation designator");
  const enforcersTx = await w.writeContract({
    address: eoa,
    abi: AgentAccountAbi,
    functionName: "setEnforcers",
    args: [[core.enforcers.spendLimit, core.enforcers.timeWindow, core.enforcers.allowedTargets]],
  });
  await net.pub.waitForTransactionReceipt({ hash: enforcersTx });
  return { delegationTx, enforcersTx, account: eoa };
}

export async function mintUsdc(net: Devnet, minterKey: Hex, usdc: Address, to: Address, amount: bigint): Promise<Hex> {
  const w = walletFor(net, minterKey);
  const hash = await w.writeContract({ address: usdc, abi: MockUSDCAbi, functionName: "mint", args: [to, amount] });
  await net.pub.waitForTransactionReceipt({ hash });
  return hash;
}

export async function usdcBalance(net: Devnet, usdc: Address, who: Address): Promise<bigint> {
  return net.pub.readContract({ address: usdc, abi: MockUSDCAbi, functionName: "balanceOf", args: [who] });
}

export interface SessionGrant {
  key: Address;
  spendCap: bigint;
  perTxMax: bigint;
  validAfter?: bigint;
  validUntil: bigint;
  anyTarget?: boolean;
  targets?: Address[];
  tokens: Address[];
}

/** Owner grants a root session (for example to the gateway key, making it a bounded operator). */
export async function grantRootSession(net: Devnet, ownerKey: Hex, account: Address, g: SessionGrant): Promise<Hex> {
  const w = walletFor(net, ownerKey);
  const hash = await w.writeContract({
    address: account,
    abi: AgentAccountAbi,
    functionName: "grantSession",
    args: [g.key, g.spendCap, g.perTxMax, g.validAfter ?? 0n, g.validUntil, g.anyTarget ?? false, g.targets ?? [], g.tokens],
  });
  const r = await net.pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error("grantSession reverted");
  return hash;
}

export async function ownerUnpause(net: Devnet, ownerKey: Hex, account: Address): Promise<Hex> {
  const w = walletFor(net, ownerKey);
  const hash = await w.writeContract({ address: account, abi: AgentAccountAbi, functionName: "unpause", args: [] });
  await net.pub.waitForTransactionReceipt({ hash });
  return hash;
}

export async function readSession(net: Devnet, account: Address, key: Address) {
  return net.pub.readContract({ address: account, abi: AgentAccountAbi, functionName: "getSession", args: [key] });
}
