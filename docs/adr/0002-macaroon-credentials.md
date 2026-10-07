# ADR-0002: Macaroon-style credentials with offline attenuation

**Status:** accepted (Phase 0)

## Context
Multi-agent systems delegate constantly (planner → worker → tool). Each hop must be able to narrow authority without a round trip and without the root secret, and a verifier must be able to prove the narrowing is monotonic.

## Decision
Credentials are HMAC chains (as in Google's macaroons and Lightning's L402): `sig_i = HMAC(sig_{i-1}, caveat_i)`. A holder appends caveats and recomputes the signature; removal is impossible without the previous signature. Effective limits are the conjunction (min of caps, intersection of allowlists, latest not-before, earliest expiry). A `delegate` caveat names the sub-agent, so the chain also encodes the org tree.

Rejected: JWTs with nested signatures (needs the issuer for every hop), ERC-7715 alone (on-chain only; no off-chain hostname/purpose caveats), capability tokens with revocation lists (bearer anyway).

## Consequences
* Monotonicity is by construction and property-tested (500 random parent/child pairs).
* Credentials are bearer tokens: treat like API keys; evidence bundles export only the public view (no `sig`).
* Revocation is by expiry and by on-chain `revokeSession`; Phase 1 adds a gateway-side revocation list keyed by credential id.
* The same effective limits compile to the on-chain session, so the chain enforces what the gateway enforces (hostname and purpose caveats are off-chain only; address allowlists are on-chain).
