import { z } from "zod";
import { formatUnits, parseUnits, type Address } from "viem";

export const AmountSchema = z.object({
  asset: z.string().min(1), // e.g. "USDC"
  chain: z.string().regex(/^eip155:\d+$/), // CAIP-2
  token: z.string().regex(/^0x[0-9a-fA-F]{40}$/), // ERC-20 address
  value: z.string().regex(/^\d+$/), // base units as decimal string
  decimals: z.number().int().min(0).max(36).default(6),
});
export type Amount = z.infer<typeof AmountSchema>;

export function toBase(human: string, decimals = 6): bigint {
  return parseUnits(human, decimals);
}

export function toHuman(base: bigint | string, decimals = 6): string {
  return formatUnits(BigInt(base), decimals);
}

export function amount(args: {
  asset: string;
  chain: string;
  token: Address;
  human?: string;
  base?: bigint | string;
  decimals?: number;
}): Amount {
  const decimals = args.decimals ?? 6;
  const value =
    args.base !== undefined ? BigInt(args.base).toString() : toBase(args.human ?? "0", decimals).toString();
  return { asset: args.asset, chain: args.chain, token: args.token, value, decimals };
}

export function sameMoney(a: Amount, b: Amount): boolean {
  return a.asset === b.asset && a.chain === b.chain && a.token.toLowerCase() === b.token.toLowerCase();
}

export const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);
