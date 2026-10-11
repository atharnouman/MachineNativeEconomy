import { keccak256, toHex, type Address, type Hex } from "viem";

/** EIP-712 typed data for AgentAccount.PaymentAuthorization. Must match the Solidity typehash exactly. */
export const PaymentAuthorizationTypes = {
  PaymentAuthorization: [
    { name: "token", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "intentHash", type: "bytes32" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * EIP-712 typed data for AgentAccount.TokenAuthorization: a session key's authorization for the account to
 * pre-approve a standard EIP-3009 transfer (the ERC-1271 interop path for standard x402 facilitators).
 */
export const TokenAuthorizationTypes = {
  TokenAuthorization: [
    { name: "token", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "intentHash", type: "bytes32" },
  ],
} as const;

/** EIP-3009 (Circle FiatToken v2) typehash for `transferWithAuthorization`. */
export const TRANSFER_WITH_AUTHORIZATION_TYPEHASH: Hex = keccak256(
  toHex("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"),
);

export function agentAccountDomain(account: Address, chainId: number) {
  return { name: "AgentAccount", version: "1", chainId, verifyingContract: account } as const;
}

export interface PaymentAuthorizationStruct {
  token: Address;
  to: Address;
  amount: bigint;
  intentHash: Hex;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

export interface TokenAuthorizationStruct {
  token: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  intentHash: Hex;
}

export interface WireAuthorization {
  token: string;
  to: string;
  amount: string;
  intentHash: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export function toWireAuthorization(a: PaymentAuthorizationStruct): WireAuthorization {
  return {
    token: a.token,
    to: a.to,
    amount: a.amount.toString(),
    intentHash: a.intentHash,
    validAfter: a.validAfter.toString(),
    validBefore: a.validBefore.toString(),
    nonce: a.nonce,
  };
}

export function fromWireAuthorization(w: WireAuthorization): PaymentAuthorizationStruct {
  return {
    token: w.token as Address,
    to: w.to as Address,
    amount: BigInt(w.amount),
    intentHash: w.intentHash as Hex,
    validAfter: BigInt(w.validAfter),
    validBefore: BigInt(w.validBefore),
    nonce: w.nonce as Hex,
  };
}

/** The standard x402 `exact` EVM authorization (EIP-3009 fields, decimal strings). */
export interface WireEip3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}
