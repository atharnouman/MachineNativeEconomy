import {
  decodeErrorResult,
  recoverTypedDataAddress,
  defineChain,
  toFunctionSelector,
  keccak256,
  encodeAbiParameters,
  concatHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Chain,
  type Account,
} from "viem";
import {
  AgentAccountAbi,
  MockUSDCAbi,
  SpendLimitEnforcerAbi,
  TimeWindowEnforcerAbi,
  AllowedTargetsEnforcerAbi,
} from "./abi/generated.js";
import { PaymentAuthorizationTypes, agentAccountDomain, fromWireAuthorization, TRANSFER_WITH_AUTHORIZATION_TYPEHASH } from "./typedData.js";
import type { AuthorizationPayload, X402StandardPayload } from "./rails.js";

/**
 * Waits for a transaction's receipt and then for its block to be the chain's latest. Chains with preconfirmations
 * (Base Flashblocks) hand out receipts while the block is still being built, and a read at "latest" made right then
 * does not see the change: a facilitator checking a fresh pre-approval through ERC-1271 rejects it. On a local chain
 * the receipt's block is already the latest, so this returns at once. After `timeoutMs` it returns the receipt anyway.
 */
export async function waitForInclusion(client: PublicClient, hash: Hex, timeoutMs = 30_000) {
  const receipt = await client.waitForTransactionReceipt({ hash });
  const deadline = Date.now() + timeoutMs;
  while ((await client.getBlockNumber({ cacheTime: 0 })) < receipt.blockNumber && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  return receipt;
}

/**
 * The signature a standard x402 payload carries when the account pre-approved the EIP-3009 digest on-chain. The account
 * answers ERC-1271 from the approved digest and ignores these bytes, but facilitators split a 65-byte signature into
 * (v, r, s) to call USDC's split-signature `transferWithAuthorization`, and secp256k1 libraries refuse r = 0 or s = 0
 * before anything reaches the chain. So the bytes are well formed and meaningless: r is the x-coordinate of the curve's
 * generator, s = 1, v = 27.
 */
export const PREAPPROVED_SIGNATURE = `0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798${"00".repeat(31)}011b` as Hex;

/** All ABIs whose custom errors can surface from AgentAccount calls. */
export const RevertAbi = [
  ...AgentAccountAbi,
  ...MockUSDCAbi,
  ...SpendLimitEnforcerAbi,
  ...TimeWindowEnforcerAbi,
  ...AllowedTargetsEnforcerAbi,
] as const;

export function decodeRevert(data: Hex | undefined): { name: string; args: unknown[] } | null {
  if (!data || data === "0x") return null;
  try {
    const d = decodeErrorResult({ abi: RevertAbi, data });
    return { name: d.errorName, args: [...(d.args ?? [])].map((a) => (typeof a === "bigint" ? a.toString() : a)) };
  } catch {
    return null;
  }
}

/** Pull revert data out of whatever viem threw. */
export function revertDataFromError(err: unknown): Hex | undefined {
  let e: unknown = err;
  for (let i = 0; i < 8 && e && typeof e === "object"; i++) {
    const o = e as { data?: unknown; raw?: unknown; cause?: unknown };
    // viem: ContractFunctionRevertedError carries `raw` (hex) and `data` (decoded, only if the ABI knew the error)
    if (typeof o.raw === "string" && o.raw.startsWith("0x") && o.raw.length > 10) return o.raw as Hex;
    if (typeof o.data === "string" && o.data.startsWith("0x") && o.data.length > 10) return o.data as Hex;
    if (o.data && typeof o.data === "object" && typeof (o.data as { data?: unknown }).data === "string")
      return (o.data as { data: Hex }).data;
    e = o.cause;
  }
  const msg = err instanceof Error ? err.message : String(err);
  const m = /(0x[0-9a-fA-F]{10,})/.exec(msg);
  return m ? (m[1] as Hex) : undefined;
}

/** Best-effort name of the custom error, even when only the 4-byte selector is available. */
export function revertName(err: unknown): string | null {
  const d = decodeRevert(revertDataFromError(err));
  if (d) return d.name;
  const msg = err instanceof Error ? err.message : String(err);
  const sel = /signature:\s*(0x[0-9a-fA-F]{8})/.exec(msg)?.[1] ?? /(0x[0-9a-fA-F]{8})\b/.exec(msg)?.[1];
  if (!sel) return null;
  for (const item of RevertAbi) {
    if (item.type !== "error") continue;
    const sig = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
    if (toFunctionSelector(sig) === sel.toLowerCase()) return item.name;
  }
  return null;
}

export function describeRevert(err: unknown): string {
  const d = decodeRevert(revertDataFromError(err));
  if (d) return `${d.name}(${d.args.join(", ")})`;
  const name = revertName(err);
  if (name) return `${name}(…)`;
  return err instanceof Error ? err.message.split("\n")[0]! : String(err);
}

export function chainFor(chainId: number, rpcUrl: string): Chain {
  return defineChain({
    id: chainId,
    name: `spendmarshal-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export interface PayloadRequirements {
  chainId: number;
  token: Address;
  payTo: Address;
  minAmount: bigint;
}

type Wallet = WalletClient<ReturnType<typeof import("viem").http>, Chain, Account>;

// ───────────────────────────── agent-account payloads ─────────────────────────────

/**
 * Verify an agent-account payment payload without sending anything:
 *  - fields match the requirements (token, payee, amount, time window)
 *  - the EIP-712 signature recovers to a session key
 *  - the account's own `simulate` says every enforcer and the lineage would pass
 */
export async function verifyAgentAccountPayload(
  client: PublicClient,
  payload: AuthorizationPayload,
  req: PayloadRequirements,
): Promise<{ ok: true; signer: Address } | { ok: false; reason: string; signer?: Address }> {
  const auth = fromWireAuthorization(payload.authorization);
  if (auth.token.toLowerCase() !== req.token.toLowerCase()) return { ok: false, reason: "token mismatch" };
  if (auth.to.toLowerCase() !== req.payTo.toLowerCase()) return { ok: false, reason: "payTo mismatch" };
  if (auth.amount < req.minAmount) return { ok: false, reason: `amount ${auth.amount} below required ${req.minAmount}` };
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (auth.validBefore <= now) return { ok: false, reason: "authorization expired" };
  if (auth.validAfter > now) return { ok: false, reason: "authorization not yet valid" };
  let signer: Address;
  try {
    signer = await recoverTypedDataAddress({
      domain: agentAccountDomain(payload.account as Address, req.chainId),
      types: PaymentAuthorizationTypes,
      primaryType: "PaymentAuthorization",
      message: auth,
      signature: payload.signature as Hex,
    });
  } catch {
    return { ok: false, reason: "bad signature" };
  }
  const [ok, revertData] = (await client.readContract({
    address: payload.account as Address,
    abi: AgentAccountAbi,
    functionName: "simulate",
    args: [auth, signer],
  })) as readonly [boolean, Hex];
  if (!ok) {
    const d = decodeRevert(revertData);
    return { ok: false, signer, reason: d ? `${d.name}(${d.args.join(",")})` : "account would reject" };
  }
  return { ok: true, signer };
}

/** Submit the authorization. The submitter pays gas; the agent account pays the payee. */
export async function settleAgentAccountPayload(
  wallet: Wallet,
  client: PublicClient,
  payload: AuthorizationPayload,
): Promise<{ ok: true; txHash: Hex; blockNumber: bigint } | { ok: false; reason: string }> {
  const auth = fromWireAuthorization(payload.authorization);
  try {
    const hash = await wallet.writeContract({
      address: payload.account as Address,
      abi: AgentAccountAbi,
      functionName: "payWithAuthorization",
      args: [auth, payload.signature as Hex],
    });
    const rcpt = await waitForInclusion(client, hash);
    if (rcpt.status !== "success") return { ok: false, reason: "transaction reverted" };
    return { ok: true, txHash: hash, blockNumber: rcpt.blockNumber };
  } catch (err) {
    return { ok: false, reason: describeRevert(err) };
  }
}

// ───────────────────────────── standard EIP-3009 payloads ─────────────────────────────

/** The EIP-3009 `TransferWithAuthorization` digest under the token's own domain (read from the chain). */
export async function eip3009Digest(client: PublicClient, token: Address, a: X402StandardPayload["authorization"]): Promise<Hex> {
  const domainSeparator = await client.readContract({ address: token, abi: MockUSDCAbi, functionName: "DOMAIN_SEPARATOR" });
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
      [TRANSFER_WITH_AUTHORIZATION_TYPEHASH, a.from as Address, a.to as Address, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce as Hex],
    ),
  );
  return keccak256(concatHex(["0x1901", domainSeparator, structHash]));
}

/**
 * Verify a standard x402 payload the way any EIP-3009-aware facilitator does: fields, window, balance, unused
 * nonce, and a signature that is either ECDSA from `from` (EOA) or ERC-1271-valid on `from` (contract account,
 * including EIP-7702-delegated EOAs and AgentAccounts that pre-approved the digest).
 */
export async function verifyStandardPayload(
  client: PublicClient,
  payload: X402StandardPayload,
  req: PayloadRequirements,
): Promise<{ ok: true; payer: Address; digest: Hex } | { ok: false; reason: string }> {
  const a = payload.authorization;
  if (a.to.toLowerCase() !== req.payTo.toLowerCase()) return { ok: false, reason: "payTo mismatch" };
  if (BigInt(a.value) < req.minAmount) return { ok: false, reason: `value ${a.value} below required ${req.minAmount}` };
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(a.validBefore) <= now) return { ok: false, reason: "authorization expired" };
  if (BigInt(a.validAfter) > now) return { ok: false, reason: "authorization not yet valid" };
  const from = a.from as Address;
  const [balance, used] = await Promise.all([
    client.readContract({ address: req.token, abi: MockUSDCAbi, functionName: "balanceOf", args: [from] }),
    client.readContract({ address: req.token, abi: MockUSDCAbi, functionName: "authorizationState", args: [from, a.nonce as Hex] }),
  ]);
  if (balance < BigInt(a.value)) return { ok: false, reason: `insufficient balance ${balance}` };
  if (used) return { ok: false, reason: "nonce already used" };
  const digest = await eip3009Digest(client, req.token, a);
  let valid = false;
  try {
    valid = await client.verifyHash({ address: from, hash: digest, signature: payload.signature as Hex });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "signature not valid for payer (ECDSA or ERC-1271)" };
  return { ok: true, payer: from, digest };
}

/** Settle a standard payload with `transferWithAuthorization`. The submitter pays gas. */
export async function settleStandardPayload(
  wallet: Wallet,
  client: PublicClient,
  payload: X402StandardPayload,
  token: Address,
): Promise<{ ok: true; txHash: Hex; blockNumber: bigint } | { ok: false; reason: string }> {
  const a = payload.authorization;
  try {
    const hash = await wallet.writeContract({
      address: token,
      abi: MockUSDCAbi,
      functionName: "transferWithAuthorization",
      args: [a.from as Address, a.to as Address, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce as Hex, payload.signature as Hex],
    });
    const rcpt = await waitForInclusion(client, hash);
    if (rcpt.status !== "success") return { ok: false, reason: "transaction reverted" };
    return { ok: true, txHash: hash, blockNumber: rcpt.blockNumber };
  } catch (err) {
    return { ok: false, reason: describeRevert(err) };
  }
}
