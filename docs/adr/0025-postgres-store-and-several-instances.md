# ADR-0025: A Postgres store for several gateway instances

Date: 18 October 2026. Status: accepted.

## Context

The roadmap asks for a Postgres driver behind the `Store` interface, with versioned migrations, so that a deployment can
run several gateway instances. The review behind ADR-0022 put it next to per-organisation scope (ADR-0024) as what a
hosted gateway needs.

Today one gateway process owns its state.

1. **The `Store` interface is synchronous.** Both drivers run in the process: JSON rewrites one file, and SQLite uses one
   WAL file through better-sqlite3. No Postgres client for Node answers synchronously without blocking the event loop.
2. **Correctness rests on that process being alone.**
   - Budgets: `decide()` runs again right before `store.reserve()`, with no `await` in between (ADR-0017). Two payments
     in one process cannot both pass a cap, but two processes can.
   - Receipt chains: each principal has one append queue and a cached head (ADR-0017). A second process would build
     on a stale head. SQLite's unique index on (principal, sequence number) rejects the second write, as an unhandled
     error.
   - Approver keys: `ApproverKeys` caches the keys each chain holds. A second process would register a key again with
     a stale `prevAddress`, and every later bundle would then fail `approvers.history`.
   - Idempotency: concurrent duplicates share one in-flight execution through an in-memory map.
   - On-chain sends: viem's nonce manager counts the gateway key's nonces in memory.
   - Denial receipts are throttled per credential in memory.
3. **Some check-then-act sequences wait in between, so they race even in one process.**
   - Resolving an approval: the status is checked, then signature verification and approver sync are awaited, and
     only then is the approval written. Two resolutions at once can both be receipted, and the last write wins.
   - Using an approval: a payment checks at the start that its approval is granted, and consumes it after settlement.
     Two resumptions at once can both pay.
   - Charging a subscription: the interval, `maxCharges` and `maxTotal` are checked before the on-chain simulation,
     the receipts and the signing, and not again before the reservation. Concurrent charges from the payee can both
     pass. The policy's budget caps still hold, because `decide()` runs again right before the reservation.
   - Updating a policy: the next version number is computed from the latest one. Two updates at once get the same
     number: SQLite rejects the second with an unhandled error, and JSON keeps both.

## Decisions

1. **The Store becomes asynchronous.**
   - Every method returns a Promise. JSON and SQLite keep their synchronous internals and resolve at once, and every
     caller awaits.
   - The durability rule stays: a store write completes before the receipt or response that depends on it.
2. **Every check-then-act becomes one store operation that each driver makes atomic.**
   - JSON and SQLite run the operation without an `await` inside it (SQLite in a transaction).
   - Postgres runs it in one transaction. Where the operation reads more than one row, it holds a per-principal
     advisory lock.

   The operations:
   - **Budget reservation.** `reserveIf(entry, decide)` replaces "decide, then reserve".
     - `decide` is a pure function of a ledger view, and the caller fixes `now`.
     - Postgres calls it at least twice. The first run gets a view that answers zero and records each question. The
       driver then fetches every recorded figure in one round trip, and the next run decides on those figures.
     - Today's checks only fail sooner on real figures, so the second run asks a prefix of the first run's questions.
       If a future check asks for a figure that was not fetched, the driver fetches it and runs `decide` again. Under
       the lock the figures cannot change, so this ends.
     - The reservation is inserted in the same transaction, under the principal's lock.
     - Decisions that only report (the pre-check, the decision on the quote, simulation) use
       `withLedger(principalId, decide)`: the same two runs, without the lock.
   - **Receipt chains.**
     - `appendReceipt` refuses a receipt whose sequence number is taken, with a `ChainConflict` error. SQLite and
       Postgres use the unique index; JSON checks in memory.
     - `ReceiptLog` then drops its cached head, reloads it, and writes the receipt again on the real head. The key check
       of ADR-0020 and ADR-0022 runs again on the reloaded head.
   - **Approver keys.**
     - `ApproverKeys.sync` reads the keys a chain holds from its receipts every time. It is one indexed query, and
       syncs run only at startup and before signed resolutions.
     - It asks `ReceiptLog` to report a conflict instead of rewriting the receipt, so it can read the keys again and
       decide again.
   - **Approval status.** `transitionApproval(id, from, next)` writes only when the stored status is still `from`. It
     covers expiry on read, resolution and consumption. The loser gets 409 and writes no receipt.
   - **Leases, for work that spans awaits.**
     - `acquireLease(name, holder, ttl)` and `releaseLease(name, holder)` share one table. A lease expires, so a
       crashed instance never blocks anything for good.
     - A payment under an approval holds `approval:<id>` until it settles or fails. A second payment gets 409.
     - A subscription charge holds `subscription:<id>`. It reads the subscription again under the lease and checks the
       interval and limits there.
     - A reclaim holds `preapproval:<digest>`.
     - An idempotent request holds `idempotency:<scope>:<key>`. A duplicate on another instance waits for the stored
       outcome while the lease lives, then replays it. If the first attempt ended in a transient failure, nothing is
       stored, and the duplicate runs.
   - **Policy versions.** `addPolicyVersion` refuses a version number that is taken, and the API answers 409. At
     startup, an instance that loses the race to record the same document carries on without a receipt.
3. **The gateway key's transactions are serialized across instances.**
   - With Postgres, every send takes the advisory lock for (chain id, gateway address).
   - It uses the larger of two nonces: the next one recorded in the database and the chain's pending count.
   - It sends with that nonce and records the next one.
   - JSON and SQLite keep viem's in-process nonce manager.
4. **Migrations are versioned.**
   - **Postgres:** migrations are an ordered list in the gateway package, applied at startup under an advisory lock, so
     instances that start together apply each one once. `schema_migrations` records each migration's version, name
     and checksum. An instance refuses to start if the text of an applied migration has changed.
   - **SQLite:** the same kind of list, tracked with `PRAGMA user_version`. Version 1 is today's schema, created only
     where it is missing, so existing files adopt it. Later versions add the lease table and the columns the new
     operations need.
   - **JSON:** unversioned (one process, demo use).
5. **Configuration.**
   - `storeDriver: "postgres"` takes `databaseUrl` (`SPENDMARSHAL_DATABASE_URL`).
   - Every instance of a deployment shares the database and the evidence key. If the evidence keys differed, each
     instance's append would be a key rotation, which ADR-0022 refuses.
   - They also share the gateway key, the credential root key, the session secret (from which the outbound Web Bot Auth
     key and every credential's session key are derived), the admin tokens, the approvers and the principals.
   - Rotating the evidence key means stopping every instance. An instance still on the old key refuses chains the new
     key has continued (409), which fails safe.
6. **What stays per instance:** the denial throttle, so each instance allows up to one window's limit; metrics; and the
   cached chain heads, which are refreshed on a conflict.

Rejected:

- **A synchronous Postgres client** (a worker thread with `Atomics.wait`, or `pg-native`'s synchronous calls): every
  query would block the event loop.
- **State kept in memory and written behind:** a crash could lose a receipt already returned to a caller.
- **One active instance with standbys:** simpler, but it does not scale out. Requests would still need routing to the
  leader, and the store would have to become asynchronous anyway.
- **`SERIALIZABLE` transactions with retries instead of advisory locks:** `decide` runs in JavaScript between the
  reads, so retries under load would repeat the fetches and the decisions. A per-principal lock is simpler to reason
  about, and it only serializes that principal.
- **An asynchronous `SpendLedgerView` and `evaluate()` in core:** that would change the policy engine and every one of
  its tests, for something the gateway can do around it.

## Consequences

- A deployment can run several gateway instances against one Postgres database behind any load balancer, without
  routing by principal.
- The four races above are fixed in all three drivers, each with a test.
- The `Store` interface changes in a breaking way for code that uses it directly. The testnet runner opens the store
  itself; the other examples go through the gateway.
- Cost:
  - With Postgres, a decision takes one extra round trip, for the figures.
  - A payment holds its principal's lock only for the reservation, never during the payee call or on-chain
    confirmation.
- Delivered in two commits:
  1. the asynchronous store, the atomic operations, the race fixes and SQLite migrations;
  2. the Postgres driver, its migrations, the cross-instance nonce lock and the two-instance tests.
- Not in this change:
  - copying existing SQLite or JSON data into Postgres;
  - read replicas;
  - cache invalidation across instances (`LISTEN`/`NOTIFY`);
  - rate limits across instances.
- Tests:
  - One contract suite covers every store operation, run against JSON, SQLite and, when `SPENDMARSHAL_TEST_POSTGRES_URL`
    is set, Postgres. The gateway tests that already run per driver also run on Postgres.
  - The race fixes are also tested in one process, on JSON and SQLite.
  - Two gateway instances on one database (SQLite file, or Postgres) are tested with simultaneous:
    - startups, which must record one policy version 1 and register each approver once;
    - appends to one chain, which must stay one linear chain that verifies;
    - resolutions of one approval, payments under it, and charges of one subscription;
    - duplicate idempotent requests, run once.
  - Two store handles reserve against one budget cap without passing it.
  - On anvil, two instances sending at once never reuse a nonce of the gateway key.
