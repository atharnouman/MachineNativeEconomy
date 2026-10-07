# ADR-0003: Enforce caveats on-chain with a session-key account and enforcer modules

**Status:** accepted (Phase 0)

## Context
2026 incidents show that any policy living only in software next to the model gets bypassed (prompt injection, poisoned memory, malicious LLM routers, key exfiltration). The chain must be an independent backstop.

## Decision
`AgentAccount` holds funds. The owner grants sessions (key + caveats). A session key signs EIP-712 `PaymentAuthorization{token,to,amount,intentHash,validAfter,validBefore,nonce}`. Anyone may submit it; the account runs every registered `IEnforcer` (spend limit, time window, allowed targets/tokens) before transferring. `grantChildSession` re-checks that a child is no wider than its parent. `pause()` is the kill switch. `simulate()` lets the gateway, facilitators and payees dry-run with the exact revert reason.

The contract has no constructor-only state (`initialize`) so the same bytecode is an EIP-7702 delegate target; ERC-4337 validation is a Phase 1 module. Enforcers are stateless views so they can be audited and replaced independently.

Rejected: raw EOA + EIP-3009 (no on-chain limits); vendor MPC policy engines (not independent of the vendor); Safe modules (heavier, and the 7702 path matters for agents that start as EOAs).

## Consequences
* A stolen session key can lose at most `min(perTxMax, remaining spendCap)` per tx to allowlisted targets until `validUntil`.
* Gas is paid by the submitter (facilitator / payee / gateway relayer); the agent needs no ETH.
* The intent hash in the authorization binds every settlement to an off-chain receipt.
