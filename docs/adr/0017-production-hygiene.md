# ADR-0017: Production hygiene for real load

Date: 11 October 2026. Status: accepted.

## Context

A scalability review of the Phase 1 code ([context note](../../context/2026-10-11-scalability-review.md)) found that the
architecture scales (pure policy evaluation, on-chain hard limits, per-principal receipt chains, pluggable store and
signer) but that the implementation carried single-node shortcuts that would fail under real load: every receipt append
loaded the principal's whole chain to find the head; one relayer key sent transactions with no nonce management; the
ledger-dependent decision and the reservation were separated by awaits, so concurrent intents could both pass an
off-chain budget; requests to payees had no timeout; a client retry after a network error could pay twice; and a
looping agent could grow the receipt chain without bound through denials.

## Decisions

1. **The receipt log keeps the chain head.** `Store.lastReceipt(principalId)` is an indexed point read; `ReceiptLog`
   caches the head per principal after the first append and keeps one append queue per principal, so an append costs
   one signature and one insert regardless of history, and principals never wait for each other.
2. **Relayer sends use viem's nonce manager.** The gateway's wallet and the payee's MPP relayer wallet create their
   accounts with `{ nonceManager }`, so concurrent `writeContract` calls get sequential nonces instead of colliding.
   A pool of relayer keys is the next step when one key's throughput is the limit.
3. **Reserve is atomic with the decision.** Immediately before `store.reserve()` the gateway re-runs the
   ledger-dependent decision synchronously, with no await between the re-check and the reservation. In one process
   that makes the pair atomic; with Postgres the same section takes a per-principal advisory lock. On-chain caps remain
   the hard backstop either way.
4. **Every outbound request has a deadline.** `payeeFetch` aborts after `payeeTimeoutMs` (default 15 s,
   `SPENDMARSHAL_PAYEE_TIMEOUT_MS`); a timed-out probe answers 502 "payee unreachable: timeout" with nothing reserved.
   The payee middleware's directory fetch (5 s), facilitator call (20 s) and subscription charge (15 s) have deadlines too.
   Every viem client (gateway, devnet, payee) polls for receipts every 500 ms instead of viem's 4 s default, so an
   MPP settlement relayed by the payee inside the paid request finishes well inside the deadline.
5. **Idempotency-Key on `POST /v1/intents` and `POST /v1/subscriptions`.** Same credential plus same key returns the
   stored outcome for 24 hours with `replayed: true` and an `Idempotent-Replayed: true` header. Final outcomes (settled,
   202 pending approval, 403 denied) are stored; transient failures are not, so a retry tries again. Concurrent
   duplicates share one execution. The SDK sends the header from `PayRequest.idempotencyKey`.
6. **Denial receipts are throttled per credential.** After 50 denials in 10 minutes the receipts stop; the first denial
   of the next window records how many were suppressed. The request still answers 403 and still counts in metrics.

## Consequences

The Phase 1 demo gained three steps: five concurrent payments settling through one relayer key, a retried request with
the same key paying once, and a payee that never answers timing out with nothing reserved. Unit tests cover the chain
head across a restart, concurrent appends for two principals, the idempotency guard and the throttle. Threat model rows
39 to 41 record the new controls. What remains for multi-instance deployments is the Postgres driver with the
per-principal lock, anchored evidence ranges and a relayer key pool.
