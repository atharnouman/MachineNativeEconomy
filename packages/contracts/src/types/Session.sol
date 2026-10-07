// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @notice Caveats compiled from an off-chain gateway credential into an on-chain session.
/// @dev Every field is a restriction. A child session is valid only if every field is at least as restrictive
///      as its parent's; the gateway checks this before granting and the chain re-checks via enforcers.
struct Session {
    address key; // session signing key (held by the gateway signer, never by the model)
    uint256 spendCap; // total spend allowed over the session lifetime, token base units
    uint256 spent; // running total (updated by the account after each payment)
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
