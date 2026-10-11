# ADR-0008: Policy versions as evidence

**Status:** accepted (Phase 1)

## Context
A policy that can be edited silently makes every past decision receipt ambiguous: "allowed under which rules?" Phase 0 stamped each decision with the policy hash but had no record of which hash was in force when.

## Decision
Policies are versioned per principal. Version 1 is the configured document at first start; `PUT /v1/policies/:principal` activates a new version after validation, and a configured document that differs from the active version at startup is treated as an update too. Each activation is a `policy.updated` receipt with the previous and new hash, a structural diff (budgets, agents, rules, velocity) and an **impact analysis**: recently allowed intents re-evaluated under the new document against an empty ledger, listing those that would now be denied or escalated and why.

The evidence bundle carries every version with its activation time. The verifier recomputes each hash, checks the `prevHash` chain and numbering, and requires every decision receipt to cite the version that was active at its timestamp, not merely some known version.

Rejected: signed policy documents only (does not answer "when"), storing policy in receipts (bloat), impact against the live ledger (reports budget exhaustion instead of rule changes).

## Consequences
* Policy changes are auditable and attributable (`activatedBy`).
* Budgets gained periods (daily / weekly / monthly / lifetime, UTC calendar) and the ledger became entries with timestamps, which is also what velocity limits and `rate_limit` caveats evaluate over.
* Operators get a dry-run of a policy change before it bites.
