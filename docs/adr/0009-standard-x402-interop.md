# ADR-0009: Standard x402 interop through on-chain pre-approval and ERC-1271

**Status:** accepted (Phase 1, milestone 1.7)

## Context
Public x402 facilitators (Coinbase CDP, Stellar/OpenZeppelin, Cloudflare's) settle the `exact` scheme with EIP-3009 `transferWithAuthorization`, which expects a signature from the payer. A smart account cannot produce an ECDSA signature, and even if it could, the token would not consult the account's caveats. Phase 0 solved this with a custom `agent-account` payload that only the bundled facilitator understands. Neutrality demands working with every facilitator.

## Decision
Two payload shapes, same policy engine, same receipts:

* **agent-account** (default): one transaction, `AgentAccount.payWithAuthorization`, needs a facilitator that knows the account.
* **standard**: the session key signs a `TokenAuthorization` (token, to, value, window, nonce, intentHash). The gateway relays `AgentAccount.approveAuthorization`, which runs every enforcer and the lineage checks, charges the spend, computes the EIP-3009 digest under the token's own domain (`DOMAIN_SEPARATOR()`) and records it. The gateway then sends the plain standard payload (`{ signature, authorization: { from: account, … } }`). The facilitator calls `transferWithAuthorization`; the token sees that `from` has code and asks `isValidSignature(digest, sig)`, which the account answers from its approved set. Replay is prevented by the token's nonce state, and the account refuses to re-approve a used nonce. A paused account answers `isValidSignature` with zero, so the kill switch also voids pending approvals.

Circle's FiatToken v2.2 already performs this ERC-1271 check for contract authorizers, including EIP-7702-delegated EOAs; `MockUSDC` mirrors it. The bundled facilitator accepts both shapes and verifies standard payloads exactly as a public one would (fields, balance, unused nonce, ECDSA-or-ERC-1271 via `verifyHash`).

Rejected: holding funds in a plain EOA signed by the gateway (loses the on-chain backstop); a one-time "approve all" allowance to the facilitator (loses per-payment caveats); ERC-6492 wrapped signatures (the token, not a verifier contract, is the caller).

## Consequences
* Any x402 facilitator can settle against an AgentAccount or a delegated EOA. Interop costs one extra transaction per payment, paid by the gateway, and gas-free for the agent.
* The spend is charged at approval time. If the facilitator never settles, funds stay put but the session's `spent` is not reclaimed until a future `reclaim` function (tracked in the roadmap); the gateway's denial receipt records the orphaned approval.
* `x402Mode` is configurable per gateway and overridable per payment, so a deployment can use the cheap path with its own facilitator and the standard path elsewhere.

## Addendum (11 Oct 2026): x402 v2 wire shape, checked against the public facilitator

The live Base Sepolia run against https://x402.org/facilitator showed that the client payload must follow the v2
specification literally: `{ x402Version: 2, resource?, accepted: <the PaymentRequirements the client chose>, payload }`,
with `scheme` and `network` inside `accepted` rather than at the top level, and `resource` at the top level of the
402 body rather than inside each entry of `accepts`. Facilitator calls are `POST <facilitatorUrl>/verify` and
`/settle` with `{ x402Version: 2, paymentPayload, paymentRequirements }`; the bundled facilitator lives at
`<gatewayUrl>/facilitator` so the same convention applies to both. `core/rails.ts`, the gateway's paid retry, the
bundled facilitator and the payee middleware were aligned; the facilitator's own HTTP errors are surfaced as a 402 reason.
