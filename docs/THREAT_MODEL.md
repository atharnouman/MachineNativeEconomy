# Threat model (Phase 0)

Scope: an organisation runs `apgw` so its agents can buy resources with USDC. Attackers want to move funds outside policy, consume services without paying, or falsify the record.

| # | Threat | Control | Where enforced | Test |
|---|---|---|---|---|
| 1 | Prompt injection / memory poisoning makes the agent request a bad payment | Agent never signs; gateway evaluates policy on every intent; caveats + budgets + deny rules | gateway `evaluate()` | `policy.test.ts`; demo step "gateway denies over-limit" |
| 2 | Compromised agent framework bypasses the gateway | The framework holds only a bearer credential, not a key; nothing it can send moves funds | design | demo: credential alone cannot settle |
| 3 | Gateway host compromised; session key exfiltrated | On-chain session caveats (`perTxMax`, `spendCap`, targets, expiry) enforced by `AgentAccount` + enforcers | chain | `AgentAccount.t.sol` denials, fuzz `testFuzz_NeverExceedsCap`, invariant `SpentNeverExceedsCap`; demo "chain denies with stolen key" |
| 4 | Sub-agent escalates its own privileges | Attenuation can only append caveats (HMAC chain); effective limit is the conjunction; `grantChildSession` re-checks subset on-chain | core + chain | property test (500 runs); `test_RevertWhen_ChildWiderThanParent_*`; demo "delegation is monotonic" |
| 5 | Replay of a signed authorization | `nonce` single-use in `AgentAccount`; `validBefore`; MPP challenge ids single-use | chain + payee | `test_RevertWhen_Replay` |
| 6 | Free-riding: resource served without payment | Payee serves only after facilitator `/settle` success (x402) or its own on-chain settlement (MPP) | payee middleware | demo settlements have tx hashes |
| 7 | Malicious / lying facilitator or payee claims a settlement that did not happen | Gateway confirms the tx receipt contains `PaymentExecuted(intentHash, amount, to)` before committing budgets | gateway `confirmPayment` | `pay.ts` confirm stage |
| 8 | Settlement race (double service for one payment) | One nonce per intent; payee settles synchronously before serving | chain + payee | `test_RevertWhen_Replay` |
| 9 | Payee substitutes a different payTo or asset | Gateway signs the authorization with the quoted `payTo`; chain enforces target/token allowlists; gateway rejects non-configured asset | gateway + chain | `test_RevertWhen_TargetNotAllowed` |
| 10 | Kill switch bypass | Gateway flag (one request) + on-chain `pause()` (one block) | both | `test_RevertWhen_Paused`; demo "kill switch" |
| 11 | Tampered or deleted receipts | Hash chain + gateway signature; head anchored on-chain; verifier checks seq/prev/sig/anchor | core + chain | `receipt.test.ts`; `evidence.verifyBundle`; demo 9/9 |
| 12 | Stale policy applied silently | Every decision receipt carries `policyHash`; verifier flags receipts citing another version | core | `verifyBundle` check `receipts.policyHash` |
| 13 | PII leakage in payment metadata | Rails carry only the authorization struct and intent hash; no free-text metadata leaves the gateway | design | — (Phase 1: explicit filter + test) |
| 14 | Sybil reputation | Not in Phase 0; design: feedback only against settled receipts | — | Phase 2 |
| 15 | Insider edits policy | Policy hash in receipts; Phase 1 adds signed policy versions + change receipts | partial | — |
| 16 | Chain reorg after confirmation | Phase 0 waits for inclusion only; Phase 1 adds confirmation depth per chain | — | — |
| 17 | Gas griefing of the relayer | Relayer only submits authorizations that passed `simulate`; per-tx gas cap (Phase 1) | partial | — |

## Non-goals in Phase 0

Custody of the owner key, fiat, KYC/KYA of counterparties, dispute resolution, legal mandate binding to a verified human identity.
