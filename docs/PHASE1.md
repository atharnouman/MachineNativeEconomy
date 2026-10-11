# Phase 1 plan (v0.2 beta)

Phase 0 proved the thin slice on a local chain. Phase 1 turns it into something a team could run against a testnet: the account works for an existing EOA without moving funds, the gateway is a bounded operator rather than the owner, policy gains the budgeting primitives real organisations use, escalation becomes a real approval workflow, and policy changes are themselves evidence.

Each milestone ships with contracts/core tests, an end-to-end demo step, and docs. Status is kept here.

| # | Milestone | What it adds | Status |
|---|---|---|---|
| 1.1 | **Policy depth** | Budget periods (daily / weekly / monthly / lifetime, UTC calendar), velocity limits (count and amount per rolling window, per credential / agent / principal), `rate_limit` credential caveat (attenuable), entries-based ledger with time windows | done |
| 1.2 | **Approval workflow** | `escalate` creates an approval request (202 + id); admin approves or rejects, optionally with an EIP-191 signature from a registered approver key; agent resumes; approvals expire; every transition is a receipt and signatures verify in the evidence bundle | done |
| 1.3 | **Policy versions** | `PUT /v1/policies/:principal` with validation, diff, and impact analysis against recent intents; versions receipted (`policy.updated`) with prev/next hash; verifier checks every decision cites the version active at its time | done |
| 1.4 | **EIP-7702 path + on-chain capability chain** | Any EOA delegates to `AgentAccount` in one type-4 transaction and keeps its funds in place; `initialize` is self-only (no front-running); sessions form a chain (owner → gateway root session → agent → sub-agent): any ancestor may delegate within its bounds, spend propagates up the lineage so a root cap bounds the whole subtree, ancestor revocation disables descendants, any active session key may pause, only the owner may unpause | done |
| 1.5 | **Devnet package** | `@spendmarshal/devnet`: anvil lifecycle, deployment, EOA delegation helper, shared by examples and tests | done |
| 1.6 | **Store abstraction + SQL** | `Store` interface with a JSON file driver and a SQLite driver (WAL, 64-bit amounts, windowed SQL aggregates); same tests on both; Phase 1 demo runs on SQLite (ADR-0010) | done |
| 1.7 | **Standard x402 interop** | Standard EIP-3009 `exact` payloads: plain-EOA payers, and smart accounts / delegated EOAs via `approveAuthorization` + ERC-1271 so any public facilitator can settle under on-chain caveats; the bundled facilitator accepts both shapes; `x402Mode` per gateway or per payment (ADR-0009) | done |
| 1.8 | **RFC 9421 request signing** | Outbound Web Bot Auth signatures on every payee request with a signed key directory; payee middleware can require them; inbound holder-bound credentials (`holder_key` caveat, positional, never removable) so a leaked credential is useless without the agent's Ed25519 key (ADR-0011) | done |
| 1.9 | **MPP subscriptions + streaming; L402 adapter** | Subscriptions and metered streams as gateway-held standing authorizations charged by the payee within cadence and caps, policy on every charge, settled on-chain by the gateway (ADR-0013); L402 over Lightning with a reference-currency conversion and preimage proof, mock node for tests (ADR-0014) | done |
| 1.10 | **Observability + OpenAPI** | Prometheus metrics, redacted structured logs, OpenAPI 3.1 generated from the zod route schemas and exported to `docs/openapi.json` (ADR-0012); OpenTelemetry deferred | done |
| 1.11 | **ERC-4337 validator** | `validateUserOp` (EntryPoint v0.7): session-key-signed user operations validate with the session's window; owner-only calls still revert through the EntryPoint; tests with a mock EntryPoint (ADR-0015). Plus `reclaimApproval` for orphaned standard-x402 pre-approvals with a gateway maintenance endpoint | done |
| — | **Audit** | Third-party audit of `packages/contracts` before any mainnet funds | blocker for mainnet |

## Acceptance criteria for the Phase 1 demo (`pnpm demo:phase1`) — all met on 8 Oct 2026

1. An EOA that already holds USDC becomes a guarded agent account with one transaction; its balance does not move; `initialize` by anyone other than the EOA reverts. ✔ steps 1–2
2. The gateway is **not** the owner. The owner grants the gateway a root session; everything the gateway later delegates is bounded by it, and the chain's `spent` on the root session equals the sum of all descendant settlements. ✔ steps 3, 5, 9
3. A sub-agent is stopped by a `rate_limit` caveat after 3 payments in 10 minutes, and the agent by a daily budget, with both reasons in receipts. ✔ steps 6–7, 12
4. A payment above the escalation threshold returns 202, is approved with a CFO-key signature, resumes, settles; a second one is rejected and cannot be resumed; both are receipted and the signatures verify offline. ✔ steps 8–11
5. A policy update produces a `policy.updated` receipt with a diff and an impact list; later decisions cite the new hash; the verifier accepts the bundle only because versions and activation times line up. ✔ step 13
6. The gateway pauses the account from its root session key (child session keys cannot pause since the hardening pass); unpausing requires the owner key. ✔ step 14
7. `pnpm test` is green across contracts (47), core (43), gateway (11, both store drivers) and both examples; the Phase 0 thin slice still passes unchanged (14/14). ✔
8. (1.7) The same agent call with `x402Mode: "standard"` settles through a plain `transferWithAuthorization` after an on-chain pre-approval, i.e. the shape every public facilitator accepts. ✔
9. (1.6) The whole Phase 1 scenario runs on the SQLite driver. ✔
10. (1.8) The payee refuses an anonymous request with 401 and `Accept-Signature`, serves the gateway's signed requests, and records which gateway key stood behind each settlement; the gateway publishes its key in a signed directory. ✔
11. (1.8) The sub-agent's credential is holder-bound; the same credential with a different key is refused with 401 before anything is signed. ✔
12. (1.10) `/metrics` reports payments by rail, outcome and payload kind; `/openapi.json` is a valid OpenAPI 3.1 document with every route. ✔
13. (1.9) A subscription opens with its first charge; the payee's early charge gets 429 with the next allowed time, an on-time charge settles on-chain, and after the agent cancels the payee gets 410. A metered stream settles 30 tokens' usage and refuses 60 tokens for exceeding the per-cycle cap. ✔
14. (1.9) An L402 purchase pays a Lightning invoice through the configured backend, verifies the preimage against the invoice hash, and counts the converted amount against the same daily budget as the USDC rails. ✔
15. (reclaim) A pre-approval that no facilitator ever settled is reclaimed after its window: the session's on-chain spend returns to its previous value, with a receipt. ✔ (26 steps in total)
16. (1.11) Foundry proves ERC-4337 validation: a session-key-signed user operation validates and executes `payWithAuthorization` through a mock EntryPoint; unknown signers, garbage signatures, a paused account, a non-EntryPoint caller, and owner-only calls all fail as they should. ✔

Transcript: [phase1-transcript.md](phase1-transcript.md). Sample bundle: `examples/phase1/sample-evidence.json` (50 receipts, 2 policy versions, 1 signature-verified approval grant and 1 rejection).

## Design notes that came out of the build

* The pre-check before contacting the payee is **structural** and evaluates at amount zero; the agent's `maxAmount` is a ceiling, not a price, and amount checks run once on the real quote (ADR-0007).
* Budgets are checked before escalation, so an escalated purchase must fit the budget; the demo's daily cap is sized for that.
* Impact analysis runs against an empty ledger so it reports rule changes, not spend state (ADR-0008).

## Hardening pass (11 Oct 2026)

A high-effort code review of the Phase 1 branch produced 17 findings; the fixes landed before the first Phase 1 commit ([ADR-0016](adr/0016-hardening-pass.md)):

- the gateway is not a proxy: payee URLs are checked at the intent boundary and in `payeeFetch` (scheme, credentials, private/loopback/link-local, optional allowlist); redirects are never followed;
- the payee's `Signature-Agent` directory fetch has the same hygiene, and `allowedAgents` is recommended;
- the policy pre-check runs as a `structural` stage so amount-conditioned deny/escalate rules cannot fire on a price that does not exist yet;
- subscription list/cancel are scoped to the opening credential's lineage; the admin token manages a whole principal;
- refusal receipts on the charge URL are throttled to one per subscription interval;
- `pause()` is restricted to the owner and root session keys;
- replay windows share one bounded `NonceWindow` (core), nonces come from `crypto.randomBytes`, MPP challenges are pruned, used Lightning preimages are bounded;
- `onSettled` carries `unit: "base" | "sat"`; concurrent `register()` calls for one credential share one transaction, and a session the chain already holds for the key is adopted instead of failing; expiry of pre-approvals is judged by chain time; the SQLite intent trim runs every 500 inserts; the SDK no longer prints a warning.
