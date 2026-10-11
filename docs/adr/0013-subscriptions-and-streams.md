# ADR-0013: Subscriptions and metered streams as gateway-held standing authorizations

**Status:** accepted (Phase 1, milestone 1.9)

## Context
Stripe/Tempo's MPP added subscriptions and streaming on top of one-shot HTTP 402 payments. Agents need the same: a feed billed per cycle, a model or data stream billed per token. The payee must be able to collect without the agent's model being in the loop, and the principal must keep every guarantee it has for one-shot payments.

## Decision
A subscription is a record the gateway holds: payee, resource, purpose, credential, and terms (`fixed` amount per cycle, or `metered` up to a cap per cycle with a unit price), plus an interval, optional `maxCharges`, `maxTotal` and an expiry.

* **Opening** reuses the normal MPP payment flow: the payee advertises an offer in its 402 challenge (`methods[].subscription`), the agent's `subscribe()` checks the offer fits its caps, the first charge is paid as any payment (policy, on-chain simulate, settlement, receipts), and the MPP credential carries the subscription block: a charge URL on the gateway and a random charge token. The payee registers it and acknowledges with a payee-side id in its `Payment-Receipt`.
* **Charging** is payee-initiated: `POST {chargeUrl}` with the token (stored hashed). The gateway enforces cadence (429 with `nextAllowedAt`), caps (403), count and total limits, expiry and cancellation (410), then runs the full policy on the charge with the stored credential, asks the account contract, reserves, signs with the session key, relays `payWithAuthorization` itself, settles the ledger and writes `payment.settled` plus `subscription.charged`. Refusals are receipted too (`subscription.refused`), so a payee that hammers the endpoint leaves evidence.
* **Cancelling** is agent-initiated and immediate; the next payee charge gets 410.

A metered stream is a `metered` subscription with a short interval: the payee reports usage (`units`, or an explicit amount) and the gateway computes `units × unitPrice`, capped per cycle.

Rejected: on-chain streaming primitives (a second settlement model to audit; cadence and caps are already enforced by the gateway and the chain's session caps bound the total); letting the payee hold a signed authorization per cycle (the agent would have to pre-sign the future, which defeats per-charge policy).

## Consequences
* Every charge is a normal policy decision: budgets with periods, velocity and rate-limit caveats, deny rules and the kill switch all apply mid-subscription.
* The payee needs no facilitator for charges and never sees a key: only a bearer token scoped to one subscription.
* Escalation is not available for charges (a human cannot be in the loop of a billing job); an `escalate` decision refuses the charge with its reasons.
* The agent's `rail` for subscriptions is MPP; x402 has no equivalent challenge/credential shape for recurring terms yet.
