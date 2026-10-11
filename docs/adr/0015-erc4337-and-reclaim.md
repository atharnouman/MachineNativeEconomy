# ADR-0015: ERC-4337 validation on the account, and reclaiming orphaned pre-approvals

**Status:** accepted (Phase 1, milestone 1.11 and roadmap item)

## ERC-4337

### Context
Teams that already run ERC-4337 infrastructure (bundlers, paymasters) want the account to accept user operations rather than relying on the gateway's relayer. The account must not become a second authorization model.

### Decision
`AgentAccount` implements `IAccount.validateUserOp` (EntryPoint v0.7 layout). The user operation's signature is an EIP-191 signature over `userOpHash` by a **session key**; validation succeeds only for an active session on an unpaused account and returns the session's `validUntil` / `validAfter` as the packed validity window. Only the configured EntryPoint may call it; the prefund is paid from the account's ETH balance. Nothing else changes: the EntryPoint then executes `callData` with `msg.sender = EntryPoint`, so a session key can reach only the permissionless entry points (`payWithAuthorization`, `approveAuthorization`, `reclaimApproval`), each of which enforces every caveat on its own. A user operation that targets an owner-only function validates but reverts at execution; the tests prove it.

Rejected: a 4337-specific session model (two models to audit); treating the EntryPoint as owner (would hand the bundler the account).

### Consequences
* "Works with any bundler" without widening what a session key can do.
* Gas for user operations comes from the account's ETH or a paymaster; the gateway's relayer path remains the default and needs no ETH in the account.

## Reclaiming pre-approvals

### Context
ADR-0009 charged a session's spend at pre-approval time; a facilitator that never settled left that charge in place until the session expired.

### Decision
`approveAuthorization` records `{key, token, nonce, value, validBefore}` per digest. `reclaimApproval(digest)` is permissionless: after `validBefore`, and only if the token's `authorizationState(account, nonce)` is still false (the transfer never happened), it deletes the approval and restores the value on the session and its whole lineage. The gateway tracks pending pre-approvals, marks them settled on confirmation, and `POST /v1/maintenance/reclaim` (admin; idempotent) reclaims the expired ones and writes a `preapproval.reclaimed` receipt. If the chain answers `ApprovalAlreadyUsed`, the record is closed as settled.

### Consequences
* Threat-model row 23 is resolved: an orphaned pre-approval costs the principal nothing after the authorization window.
* Operators run reclaim on a schedule (every few minutes); the demo shows one orphan reclaimed after a 2-second window.
