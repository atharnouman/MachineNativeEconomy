# ADR-0014: L402 (Lightning) as a non-EVM rail with preimage proof

**Status:** accepted (Phase 1, milestone 1.9)

## Context
L402 has six years of production use for machine payments over Lightning (`WWW-Authenticate: L402 macaroon=…, invoice=…`; `Authorization: L402 macaroon:preimage`). A gateway that claims to be rail-agnostic must handle a rail whose settlement is not an EVM transaction.

## Decision
The L402 adapter follows the same pay-side flow as the others, with two differences:

* **Reference currency.** Policy, budgets, caveats and the ledger are in the reference asset (USDC base units). An invoice's sats are converted with a configured rate (`fx.satsPerUsdc`, rounded up) and the decision runs on that amount; the receipt records sats, the rate and the reference amount.
* **Proof instead of confirmation.** After paying through the configured `LightningBackend`, the gateway verifies `sha256(preimage) == paymentHash` of the invoice it was quoted, then presents the preimage. The payee verifies its own macaroon (HMAC over the payment hash and expiry) and the preimage, and marks it used. Lightning is final: if the payee refuses after payment, the gateway settles the ledger anyway and records `payment.settled` with `delivered: false` and the preimage as evidence, and returns the failure to the agent.

The on-chain account is not involved: an L402 payment is bounded by policy and by the Lightning wallet's balance, not by session caveats. This is stated in the threat model; operators should fund the Lightning wallet modestly.

`MockLightning` in `@apgw/devnet` implements both sides against an in-memory ledger so demos and tests need no node. A real backend wraps LND, CLN or an LSP behind the same two-method interface.

Rejected: converting at settlement time only (policy would run on unknown amounts); treating L402 as "trusted payee" (the preimage check is cheap and keeps principle 4).

## Consequences
* The first non-EVM rail works end to end with the same intent, policy and receipt shapes.
* A mis-configured or stale FX rate changes what policy sees; the rate is recorded in every receipt, and a future milestone can pull it from an oracle with a freshness bound.
* Mixed-rail budgets are coherent: a daily cap counts Lightning spend at the converted amount alongside USDC rails (demonstrated in the Phase 1 demo).
