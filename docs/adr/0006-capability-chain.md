# ADR-0006: On-chain capability chain with lineage spend accounting

**Status:** accepted (Phase 1)

## Context
Phase 0 let only the owner grant sessions, and each session's cap stood alone: two children of a 1.00 cap could each be granted 1.00 and spend 2.00 in total. A production gateway must not be the account owner, and sub-agent delegation must stay bounded on-chain exactly as it is off-chain.

## Decision
Sessions carry a `parent`. `grantChildSession` may be called by the owner, by the parent key itself, or by any active ancestor of the parent, and re-checks every caveat against the parent. On every payment the account walks the lineage: each ancestor must be active and have cap left, then `spent` is incremented on the signer's session and on every ancestor. `revokeSession` by an ancestor therefore disables the whole subtree, and the root session's `spent` is the subtree's total settlements. The owner or any active root session key (one the owner granted directly) may `pause()`; child session keys cannot, so a leaked sub-agent key cannot halt the account (narrowed 11 Oct 2026, ADR-0016); only the owner may `unpause()`.

The gateway becomes a **bounded operator**: the owner grants the gateway key a root session (cap, per-tx, payees, expiry) and every credential the gateway registers is a child of it. A compromised gateway can lose at most that root session's remaining cap, to allowlisted payees, until it expires, and cannot unpause after a kill switch.

Rejected: a separate operator role with its own limit struct (duplicates session semantics); cap partitioning at grant time (stricter than the gateway's shared-pool model and would make the chain reject what the gateway allows).

## Consequences
* Lineage depth is capped at 16 to bound gas; walking it costs one storage read per ancestor.
* The gateway's off-chain ledger and the chain now agree on lineage semantics (shared pool, ancestors charged).
* `SessionExists` prevents silently replacing a session; revoke and grant a new key instead.
