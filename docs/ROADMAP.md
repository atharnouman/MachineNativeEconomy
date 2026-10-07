# Roadmap

## v0.1 — Phase 0 thin slice (done, local chain)

* AgentAccount with session caveats, three enforcers, pause; MockUSDC (EIP-3009); ReceiptRegistry. 24 Foundry tests incl. fuzz + invariants.
* Core: attenuable credentials (property-tested monotonicity), policy engine, signed receipt chain, evidence bundle + offline verifier.
* Gateway: x402 + MPP pay side, local facilitator, kill switch, anchoring, evidence export.
* Payee middleware: both rails in one config block.
* SDK, MCP server, CLI, end-to-end demo + test.

## v0.2 — Base Sepolia / Base mainnet beta

* EIP-7702 delegation path (EOA → AgentAccount delegate) and ERC-4337 validator so the account works with any bundler.
* Postgres store; policy versions signed and receipted; approval workflow for `escalate` (human-in-the-loop with signed approvals).
* Budget periods (daily/monthly), velocity limits, unit-price ceilings for metered services.
* Real x402 facilitators (Coinbase CDP, Stellar/OZ) behind the same adapter; EIP-3009 `exact` for EOAs.
* MPP subscriptions + streaming; L402 adapter.
* RFC 9421 HTTP Message Signatures on the gateway API (Visa TAP / Web Bot Auth compatible).
* OpenTelemetry, Prometheus, OpenAPI 3.1.
* Third-party audit of contracts before any mainnet funds.

## v1.0 — multi-rail GA

* SettlementHub: hold / capture / partial capture / refund, delayed fulfilment, batched EIP-3009 nanopayments.
* DisputeModule: deterministic auto-resolution, bonded challenges, pluggable arbiters (ERC-8004 validation, optimistic oracle, human).
* AP2 mandate adapter (checkout + payment, human-present / not-present); card-network token adapter interface (Visa TAP, Mastercard Agent Pay).
* ERC-8004 identity read/write; receipt-grounded reputation (feedback only against settled receipts).
* Python SDK; adapters for Claude Agent SDK, OpenAI Agents SDK, LangGraph, Google ADK, Coinbase AgentKit, Bedrock AgentCore.
* Evidence exports: accounting CSV, ISO 20022-shaped record, Travel-Rule payload hook.
* Chains: Base, Ethereum, Arc, Tempo; Solana + Lightning via adapters.
