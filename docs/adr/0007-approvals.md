# ADR-0007: Escalation as a signed, receipted approval workflow

**Status:** accepted (Phase 1)

## Context
"Human escalation is a first-class path" was a principle in Phase 0 and a `deny` in practice. Real organisations need the agent to pause, a named human to decide, and the decision to be provable later.

## Decision
An `escalate` decision creates an **approval request** (pending, with an expiry) and returns 202 with its id. The agent polls or waits, then calls `resume`, which re-runs the whole payment flow with the approval attached: the quote must still match the approved amount, payee and rail; every other check (caps, budgets, velocity, deny rules) still applies; only the escalation rule is satisfied by the approval. A used approval is consumed.

Resolutions are made with the admin token, or, when approver keys are registered, with an EIP-191 signature over a canonical message that binds the approval id, principal, intent hash, amount and verdict. `requireSignedApprovals` makes signatures mandatory. Every transition (requested, granted, rejected, expired, consumed) is a receipt; signed resolutions are verified offline by the evidence verifier against the registered approver addresses.

The pre-check that runs before the payee is contacted is **structural** (payee, purpose, rail, deny rules, kill switch, validity window, rate-limit counts) and evaluates at amount zero. Amount-dependent checks run once, on the real quoted price. The agent's `maxAmount` is a ceiling, not a price, and must not cause spurious denials.

Rejected: blocking HTTP long-poll (ties up the agent and the gateway), approving by editing policy (loses the per-intent binding), unsigned approvals only (no offline proof of who decided).

## Consequences
* Agents need two calls for escalated purchases; the SDK and MCP server expose `resume` and `approval`.
* The request body is kept with the approval for replay but never written into receipts.
* An approval cannot be reused for a different quote: the gateway denies with 409 and the agent must request a new one.
