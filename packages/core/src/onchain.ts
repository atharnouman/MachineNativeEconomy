import {
  decodeErrorResult,
  recoverTypedDataAddress,
  defineChain,
  toFunctionSelector,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Chain,
  type Account,
} from "viem";
import {
  AgentAccountAbi,
  SpendLimitEnforcerAbi,
  TimeWindowEnforcerAbi,
  AllowedTargetsEnforcerAbi,
} from "./abi/generated.js";
import { PaymentAuthorizationTypes, agentAccountDomain, fromWireAuthorization } from "./typedData.js";
import type { AuthorizationPayload } from "./rails.js";

/** All ABIs whose custom errors can surface from AgentAccount.payWithAuthorization / simulate. */
export const RevertAbi = [
  ...AgentAccountAbi,
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
    name: `apgw-${chainId}`,
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

/**
 * Verify an agent-account payment payload without sending anything:
 *  - fields match the requirements (token, payee, amount, time window)
 *  - the EIP-712 signature recovers to a session key
 *  - the account's own `simulate` says every enforcer would pass
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
  wallet: WalletClient<ReturnType<typeof import("viem").http>, Chain, Account>,
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
    const rcpt = await client.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") return { ok: false, reason: "transaction reverted" };
    return { ok: true, txHash: hash, blockNumber: rcpt.blockNumber };
  } catch (err) {
    return { ok: false, reason: describeRevert(err) };
  }
}
