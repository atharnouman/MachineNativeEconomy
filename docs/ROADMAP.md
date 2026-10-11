# Roadmap

## v0.1 — Phase 0 thin slice (done, local chain)

* AgentAccount with session caveats, three enforcers, pause; MockUSDC (EIP-3009); ReceiptRegistry. Foundry unit, fuzz and invariant tests.
* Core: attenuable credentials (property-tested monotonicity), policy engine, signed receipt chain, evidence bundle + offline verifier.
* Gateway: x402 + MPP pay side, local facilitator, kill switch, anchoring, evidence export.
* Payee middleware: both rails in one config block. SDK, MCP server, CLI, end-to-end demo + test.

## v0.2 — Phase 1 (in progress; plan and status in [PHASE1.md](PHASE1.md))

Done:
* EIP-7702 path: an existing EOA becomes the account in one transaction, funds in place, self-only `initialize`.
* On-chain capability chain: ancestors delegate, lineage spend accounting, ancestor revocation, root-session pause / owner-only unpause. Gateway as bounded operator.
* Policy depth: budget periods, velocity rules, `rate_limit` caveats, entries-based ledger.
* Approval workflow with EIP-191-signed resolutions, resume, expiry, offline verification.
* Policy versions with diff, impact analysis and activation-time verification.
* `@spendmarshal/devnet`; Phase 1 demo and end-to-end test.
* Store interface with JSON and SQLite drivers (ADR-0010).
* Standard x402 interop: EIP-3009 payloads for EOAs and, via on-chain pre-approval + ERC-1271, for AgentAccounts and delegated EOAs, so any public facilitator can settle (ADR-0009).
* RFC 9421: outbound Web Bot Auth with a signed key directory, payee-side verification, holder-bound credentials (ADR-0011).
* Prometheus metrics, redacted logs, OpenAPI 3.1 at `/openapi.json` and `docs/openapi.json` (ADR-0012).
* Subscriptions and metered streams (MPP-shaped, payee-charged, policy per charge) and the L402 Lightning rail with preimage proof (ADR-0013, ADR-0014).

* ERC-4337 `validateUserOp` for session keys; `reclaimApproval` + `/v1/maintenance/reclaim` for orphaned pre-approvals (ADR-0015).

Next (in order):
* Live run against a public facilitator and real USDC on Base Sepolia (needs a funded testnet key: the user's own).
* Postgres driver behind the same `Store` interface for multi-instance deployments; versioned migrations.
* FX oracle with a freshness bound for the L402 rail.
* OpenTelemetry tracing once there is a collector to send to.
* Third-party audit of `packages/contracts` before any mainnet funds.
* Third-party audit of contracts before any mainnet funds.

## v1.0 — multi-rail GA

* SettlementHub: hold / capture / partial capture / refund, delayed fulfilment, batched EIP-3009 nanopayments.
* DisputeModule: deterministic auto-resolution, bonded challenges, pluggable arbiters (ERC-8004 validation, optimistic oracle, human).
* AP2 mandate adapter (checkout + payment, human-present / not-present); card-network token adapter interface (Visa TAP, Mastercard Agent Pay).
* ERC-8004 identity read/write; receipt-grounded reputation (feedback only against settled receipts).
* Python SDK; adapters for Claude Agent SDK, OpenAI Agents SDK, LangGraph, Google ADK, Coinbase AgentKit, Bedrock AgentCore.
* Evidence exports: accounting CSV, ISO 20022-shaped record, Travel-Rule payload hook.
* Chains: Base, Ethereum, Arc, Tempo; Solana + Lightning via adapters.
