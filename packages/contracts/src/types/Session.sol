// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @notice Caveats compiled from an off-chain gateway credential into an on-chain session.
/// @dev Sessions form a capability chain: owner -> gateway root session -> agent -> sub-agent. A child is valid
///      only if every field is at least as restrictive as its parent's. `spent` includes descendants' spend, so a
///      root session's cap bounds the whole subtree.
struct Session {
    address key; // session signing key (held by the gateway signer, never by the model)
    address parent; // parent session key; address(0) for a root session granted by the owner
    uint256 spendCap; // total spend allowed over the session lifetime for this session AND its descendants
    uint256 spent; // running total including descendants (updated by the account after each payment)
    uint256 perTxMax; // maximum single payment
    uint64 validAfter; // unix seconds; 0 = immediately
    uint64 validUntil; // unix seconds; must be > 0
    bool anyTarget; // true = no payee allowlist
    bool active; // false after revocation
}

struct PaymentAuthorization {
    address token;
    address to;
    uint256 amount;
    bytes32 intentHash; // keccak256 of the gateway's canonical PaymentIntent; binds chain to evidence
    uint256 validAfter;
    uint256 validBefore;
    bytes32 nonce; // unique per authorization; replay protection
}

/// @notice A session key's authorization for the account to pre-approve a standard EIP-3009
///         `transferWithAuthorization(from = this account, ...)`, so any x402 facilitator that only understands
///         EIP-3009 payloads can settle against the account while every caveat is still enforced on-chain.
struct TokenAuthorization {
    address token; // EIP-3009 token (USDC)
    address to;
    uint256 value;
    uint256 validAfter;
    uint256 validBefore;
    bytes32 nonce; // becomes the EIP-3009 nonce; single use in both the token and the account
    bytes32 intentHash;
}
