# Scalability and real-world readiness review (11 Oct 2026)

Question from the user: is this built for real-world use at scale, with no bottlenecks? Scope: gateway, store drivers, chain client, payee middleware, SDK. Evidence is from the code on `phase-1` at commit 901faf8.

## What is already right (architecture)

- Policy evaluation is a pure function over an intent and a ledger view. Stateless, so it scales horizontally once the store is shared.
- Hard limits are enforced on-chain (caps, per-tx max, payee allowlist, expiry, pause). A slow or wrong gateway cannot move funds outside those limits.
- Receipts are an append-only hash chain per principal. The principal is a natural partition key: tenants shard cleanly.
- Store, Signer, rails and Lightning backends are interfaces. Postgres, KMS/HSM signing and new rails plug in without redesign.
- Standard x402 interop pushes settlement to public facilitators (someone else's relayer fleet) while caps stay on-chain. MPP and L402 keep micro-volume off the relayer.
- Nothing CPU-heavy per request: HMAC credential checks, one Ed25519 verify, one secp256k1 signature per receipt (about 1–2 ms). Fastify on Node handles thousands of concurrent in-flight payments per instance; the work is I/O.

## Bottlenecks found, ranked

| # | Finding | Evidence | Fix | Effort | Severity |
|---|---|---|---|---|---|
| 1 | **Receipt append reads the whole chain.** Every append loads and parses every receipt of the principal to find the last one, so cost grows with history: quadratic overall. | `packages/gateway/src/receipts.ts` `append()` calls `store.receiptsFor(principalId)`; no `lastReceipt` in `store.ts` | `store.lastReceipt(principalId)` (`ORDER BY seq DESC LIMIT 1`, already indexed on `(principal_id, seq)`); cache the head per principal in `ReceiptLog` | 1 h | critical |
| 2 | **Relayer nonce races.** One gateway key sends every grant, pre-approval and settlement through viem's default account with no nonce manager; concurrent payments collide on the nonce ("nonce too low", replacement errors, stuck txs). | `packages/gateway/src/chain.ts` line 44: `privateKeyToAccount(cfg.gatewayPrivateKey)` with no `nonceManager`; nine `waitForTransactionReceipt` call sites | `privateKeyToAccount(key, { nonceManager })` plus a per-chain send queue now; a pool of funded relayer keys later | 1–2 h | high |
| 3 | **Off-chain budgets can be overspent under concurrency.** `decide()` reads the ledger, then the code awaits (receipt appends, on-chain simulate) before `reserve()` inserts. Two concurrent intents for one agent can both pass a daily cap and both reserve. On-chain caps are unaffected; org/team budgets, velocity and `rate_limit` caveats are off-chain only. | `pay.ts`: decide at line 347, reserve at line 365 with awaits between; `store-sqlite.ts` `reserve()` inserts without re-checking | Re-check ledger-dependent limits and reserve in one synchronous section (better-sqlite3 is synchronous); with Postgres, a per-principal advisory lock or `SELECT … FOR UPDATE` on a budget row | half a day | high |
| 4 | **No timeouts on outbound payee requests.** A slow or hostile payee holds the request, its reservation and the relayer slot indefinitely. | `pay.ts` `payeeFetch()` passes no `signal`; no `AbortSignal` anywhere in the gateway | `AbortSignal.timeout(cfg.payeeTimeoutMs ?? 15_000)` on probe and paid retry; release the reservation on timeout; same for the facilitator and directory fetches | 1 h | high |
| 5 | **No idempotency key on `POST /v1/intents`.** A client retry after a network error is a new intent and can pay twice within policy. | no "idempot" anywhere in gateway or SDK; intent ids are random per request | Optional `Idempotency-Key` header (or `clientRef`) stored with the intent; a replay within 24 h returns the stored result; SDK sends one automatically on retry | half a day | high |
| 6 | **Single-instance state.** SQLite is single-writer; the receipt queue, `NonceWindow`, the registration `inflight` map, the payee challenge map and `SubscriptionBook` live in process memory. Two gateway instances on one store would interleave chains. | `receipts.ts` per-principal promise chain; `httpauth.ts`, `credentials.ts`, `payee/middleware.ts`, `payee/subscriptions.ts` in-memory maps | Postgres driver with a per-principal advisory lock around append and reserve; nonce windows and challenges in the store or Redis; `SubscriptionBook` behind a store interface. Already the roadmap's Postgres item; the lock requirement is the part to make explicit | 1–2 weeks | required before multi-instance |
| 7 | **Evidence export and verification are whole-chain.** `exportEvidence` loads every receipt into memory; the verifier walks from genesis. | `server.ts` `exportEvidence()` uses `store.receiptsFor`; `verifyBundle` walks the full chain | Anchor every N receipts or T minutes; export ranges between anchors; verifier accepts a bundle that starts from an anchored head | 1–2 days | medium (bites near a million receipts) |
| 8 | **Denied attempts write receipts without bound.** Every denied intent writes two receipts; a compromised agent can spam denials and grow storage. Same class as the refused-charge flood fixed in ADR-0016. | 15 `payment.denied` sites in `pay.ts` | Per-credential denial budget (after N denials in a window, one receipt per minute carrying a count) plus a metric | 2 h | medium |
| 9 | **Gas economics in agent-account mode.** The relayer pays gas for each `payWithAuthorization`, roughly one tx per payment. Fractions of a cent on Base, prohibitive on L1 for micropayments. | design | Standard mode (public facilitators) and MPP/L402 already take settlement off the relayer; batched EIP-3009 nanopayments are on the v1.0 roadmap | roadmap | design-level, known |
| 10 | **Confirmation depth is one block.** Settlement is confirmed at inclusion; an L1 reorg could invalidate a settled receipt. | threat model row 19; `chain.ts` waits for the receipt only | `confirmations` per chain and a "settled, pending finality" state finalised later | 1 day | medium on L1, low on Base |
| 11 | **Hot keys in process memory.** `LocalSigner` holds the gateway key and the session-secret. | `signer.ts` | The `Signer` interface already allows a KMS/HSM implementation; ship a reference one and document that the bounded-operator root session caps the blast radius | 2–3 days | deployment concern |
| 12 | **Approvals are delivered by polling.** SDK `waitForApproval` polls every second. | `sdk-ts/src/index.ts` line 175 | Fine at hundreds of pending approvals; add webhooks or SSE later | later | low |
| 13 | **No inbound rate limiting.** Per-credential limits exist only through policy; a flood of invalid credentials is cheap to reject but still a request each. | `server.ts` has no rate-limit plugin | Put a reverse proxy in front; add `@fastify/rate-limit` keyed by credential id on the pay routes | 2 h | low |

## Capacity model for one instance after fixes 1–5

- Per payment: two payee round trips, one on-chain transaction (agent-account mode) or one pre-approval plus a facilitator settle (standard mode), three or four receipts, about ten SQLite statements.
- The chain is the hard limiter, not the gateway. One relayer key with a nonce manager sends sequential nonces: on Base at about 2 s blocks that is on the order of 10–50 settlements per second per key. More keys, standard mode, MPP and L402 raise it; batching raises it further.
- Receipts: a per-principal chain is sequential by design; after fix 1 it sustains hundreds of appends per second per principal. Scale across tenants by sharding on principal id.
- Storage: 1–2 KB per receipt, so a million receipts is 1–2 GB; anchored ranges keep export and verification bounded.

## Status (11 Oct 2026, same day)

Fixes 1, 2, 3, 4, 5 and 8 are implemented (ADR-0017): `Store.lastReceipt` + cached heads and per-principal queues; `nonceManager` on the gateway and payee relayer accounts; synchronous re-check before `reserve()` in `payInner` and `charge()`; `payeeTimeoutMs` plus deadlines on the payee's outbound calls; `Idempotency-Key` with an in-flight guard and 24 h store; `DenialThrottle`. Covered by `packages/gateway/test/scale.test.ts` and three new Phase 1 demo steps. Items 6, 7, 10 and 13 wait for the Postgres driver; 9, 11 and 12 are roadmap.

## Plan

- Now, before the testnet run and anything public: fixes 1, 2, 3, 4, 5 and 8. About two to three days.
- With the Postgres driver (remaining v0.2 work): 6, 7, 10, inbound rate limiting, webhook delivery. Two to three weeks.
- v1.0: relayer key pool, batched settlements, KMS signer reference, OpenTelemetry.

None of the findings is an architectural dead end; they are single-node assumptions and missing production hygiene in code that was written to prove the design end to end first.
