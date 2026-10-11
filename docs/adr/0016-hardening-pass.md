# ADR-0016: Hardening pass before the first Phase 1 commit

Date: 11 October 2026. Status: accepted.

## Context

A high-effort review of the Phase 1 branch found that several conveniences built for the local demos would be
dangerous on a public deployment: the gateway fetched any URL an agent named (an open proxy into the operator's
network, including cloud metadata addresses), followed redirects with payment headers attached, and the payee
middleware fetched any `Signature-Agent` origin a caller claimed. It also found that the structural pre-check at
amount zero tripped amount-conditioned rules, that any credential of a principal could list or cancel every
subscription of that principal, that refused charge calls each wrote a receipt, and that any active session key,
including a sub-agent's, could pause the whole account.

## Decisions

1. **Outbound hygiene is a core primitive** (`net.ts`: `isPrivateHost`, `checkOutboundUrl`). The gateway applies
   it at the request→intent boundary and again inside `payeeFetch`; the payee applies it to `Signature-Agent`
   origins. Defaults are the safe ones: http(s) only, no credentials in URLs, loopback, private, link-local and
   CGNAT ranges refused. Deployments opt in with `outbound.allowLoopback` (a payee on this machine: demos) or
   `outbound.allowPrivate` (in-cluster payees; link-local metadata addresses stay refused unless this is set) and may pin
   `outbound.allowedHosts`. Redirects are never followed: a 3xx from a payee ends the attempt.
2. **Policy evaluation has a stage.** `evaluate({ stage: "structural" })` answers "could this intent ever be
   allowed?" before the price is known: deny and escalate rules with amount predicates are skipped, allow rules
   count if they could match at some amount, and amount-dependent checks wait for the binding stage on the quote.
3. **Subscription management follows the credential chain.** A credential sees and cancels subscriptions opened
   by itself or by any of its descendants; the admin token manages a whole principal.
4. **Refusal receipts are throttled** to one per subscription interval, carrying the count of refusals since the
   last one. Every refusal still counts in metrics.
5. **`pause()` is for the owner and root session keys.** Stopping spending is always safe, but a leaked sub-agent
   key must not be able to halt the whole account; the gateway's root session keeps the kill switch.
6. Smaller fixes: one bounded `NonceWindow` in core shared by inbound and payee replay checks; nonces from
   `crypto.randomBytes`; MPP challenges pruned and used preimages bounded; `onSettled` carries a `unit`;
   concurrent `register()` calls share one transaction; the SQLite intent trim runs every 500 inserts.

## Consequences

Local demos set `outbound: { allowLoopback: true }` and list the loopback gateway in the payee's
`agentAuth.allowedAgents`. Operators get three new settings (`APGW_OUTBOUND_ALLOW_LOOPBACK`,
`APGW_OUTBOUND_ALLOW_PRIVATE`, `APGW_OUTBOUND_ALLOWED_HOSTS`) and a demo step proving the gateway refuses a link-local address.
Threat model rows 34–38 record the new controls.
