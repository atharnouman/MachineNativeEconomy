import type { Address, Hex } from "viem";

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

export function toWireAuthorization(a: PaymentAuthorizationStruct) {
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

export interface WireAuthorization {
  token: string;
  to: string;
  amount: string;
  intentHash: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
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
