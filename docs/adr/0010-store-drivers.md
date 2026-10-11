# ADR-0010: Store interface with JSON and SQLite drivers

**Status:** accepted (Phase 1, milestone 1.6)

## Context
Phase 0 kept all state in one JSON file rewritten on every mutation. That is fine for a demo and unfit for a gateway that handles thousands of receipts a day or answers windowed queries (budget periods, velocity, rate limits).

## Decision
`Store` is an interface. Two drivers implement it:

* **JSON** (`state.json`): zero dependencies, kept for demos and single-process development.
* **SQLite** (`spendmarshal.sqlite`, better-sqlite3, WAL mode): tables for receipts, credentials, ledger entries with lineage and budget join tables, approvals, intents, policy versions, kill switch and anchors; windowed sums are SQL aggregates; amounts are 64-bit integers read back as BigInt so nothing rounds.

Both drivers are synchronous, which keeps the receipt log's ordering guarantee (one append at a time, `seq` and `prev` never race) without a transaction layer. `openStore()` selects the driver from configuration; the same test suite runs against both.

Postgres was deferred: SQLite keeps "self-hostable in one command" true (no server), and the interface is what a Postgres driver would implement when multi-instance deployment is needed.

Rejected: an ORM (adds a large dependency for a dozen queries); storing receipts only in SQL rows rather than JSON blobs (the signed receipt must be reproducible byte-for-byte, so the canonical JSON is the source of truth and columns are indexes).

## Consequences
* Per-sum amounts must stay below 2^63 base units; at six decimals that is over nine trillion USDC, so it is a documented limit rather than a practical one.
* The Phase 1 demo runs on SQLite; the thin slice stays on JSON, so both drivers are exercised end to end in CI.
* Migrations are `CREATE TABLE IF NOT EXISTS` for now; a versioned migration table comes with the first schema change.
