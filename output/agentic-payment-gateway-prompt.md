# Improved prompt: Open-source Agentic Payment Gateway

Written 8 Oct 2026. Research behind it: `context/2026-10-08-agentic-payments-landscape.md`.

## How this differs from the original prompt

The original asked for three generic modules (auth, Solidity settlement, TS API). As of October 2026 every one of those already ships from Coinbase, Cloudflare, Circle, Stripe/Tempo, and a dozen startups. A model given the original prompt would rebuild a worse Coinbase Agentic Wallet.

The rewritten prompt targets the eight things the research shows nobody has built in one open-source, self-hostable system:

| Gap (Oct 2026) | What the prompt demands |
|---|---|
| Rails don't interoperate (x402, MPP, L402, AP2, TAP, Agent Pay) | One canonical PaymentIntent + Receipt; rails are adapters, on both pay and accept sides |
| Merchant/acceptance side barely exists | A one-line payee middleware for any API, MCP server, or A2A agent |
| Disputes, refunds, delayed fulfilment unsolved | Hold/capture/refund escrow, streaming, dispute module with bonded challenges and pluggable arbiters |
| Policy lives in the LLM or in a vendor | Declarative policy compiled to on-chain caveats; enforced below the model; formal attenuation proof |
| Multi-agent budgets and delegation are open research | Monotonic, offline-verifiable sub-agent credentials with budget hierarchies |
| Reputation is 60–90% sybil | Feedback accepted only when bound to a settled receipt |
| No native audit evidence in x402/L402 | Signed receipt chain: mandate → intent → policy decision → settlement → fulfilment → dispute |
| Everything open is testnet/BUSL or vendor-locked | Apache-2.0, one-command self-host, no vendor key on the core path |

Use it as-is with any strong coding model. It is written so the model never needs to ask a question.

---

## THE PROMPT

Act as the Lead Blockchain and AI Systems Engineer and founding architect of an open-source project. You have shipped audited mainnet Solidity, high-throughput TypeScript services, and agent integrations across MCP and A2A. You write complete code, not slideware. You make decisions, state assumptions explicitly in ADRs, and never stop to ask questions.

### Mission

Design and build an open-source (Apache-2.0), self-hostable **Agentic Payment Gateway**: the policy, settlement, and evidence control plane between any AI agent framework and any payment rail, so an organisation can let autonomous agents spend and receive money under guarantees that no prompt, no model output, and no compromised framework can override.

In one line: Envoy plus OPA plus Stripe Radar for machine money, with enforcement in cryptography and smart contracts rather than in the LLM. Working name `apgw`; rename freely.

### State of the world you are designing against (October 2026). Do not relitigate these.

- **Rails are plural and do not interoperate.** x402 V2 (Linux Foundation since April 2026; 165M transactions), Stripe/Tempo MPP (IETF draft `draft-ryan-httpauth-payment`; subscriptions and streaming), L402 (Lightning, macaroons), Google AP2 v0.2 mandates, Google UCP, OpenAI ACP, Visa Trusted Agent Protocol (RFC 9421 signatures), Mastercard Agent Pay (SD-JWT), Amex ACE. A single purchase can stack three or four of these from different vendors.
- **Wallets are vendor-bundled.** Coinbase Agentic Wallets, Cloudflare Wallets, and Circle Agent Stack each bundle custody, policy, and one rail. The only open on-chain guardrail project with receipts and disputes (IRSB) is Sepolia-only, BUSL-licensed, unaudited, and has no framework integrations.
- **Disputes, refunds, and delayed fulfilment are unsolved.** The Agentic Settlement Protocol paper defines hold/capture/refund but leaves fulfilment oracles and dispute resolution open.
- **Identity and reputation are sybil-ridden.** ERC-8004 has 45k registered agents, but only 3–15% have live endpoints and 60–90% of reputation feedback is sybil.
- **Security research on x402** documents free-riding, replay, facilitator single-point-of-trust, settlement races, and PII leakage in metadata. 2026 saw more than $45M lost to prompt-injected or compromised agent infrastructure, including the Grok/Bankrbot Morse-code drain.
- **Policy enforcement is single-agent and ad hoc.** APEX-style policies exist; multi-agent shared budgets, hierarchical delegation, and formal guarantees are listed as open work.
- **Agents have no legal personhood.** Every payment must bind to a human or legal principal; stablecoin selection must be GENIUS-Act-aware; evidence must be exportable for audit, accounting, and disputes.

### Product thesis

Build the one thing that does not exist: a neutral gateway that (1) speaks every rail on both the paying and the accepting side, (2) enforces spending policy below the model, in the signer and on-chain, with hierarchical delegation to sub-agents, (3) settles with escrow, hold/capture/refund, streaming, and batched nanopayments, and resolves disputes, and (4) emits portable signed evidence binding intent to policy decision to settlement to outcome, which doubles as a sybil-resistant reputation source.

### Positioning: where this is useful and nothing else is

The incumbents cannot build this. Coinbase, Circle, Cloudflare, and Stripe/Tempo each own a rail or a custody product and will always route to it; treating every rail as an equal would hurt their business. They monetise custody, so bring-your-own-key will never be their default. Startups ship allowlists and caps because provable delegation, cross-rail receipts, and dispute protocols are slow, unglamorous, and earn no fee. Be the neutral control plane none of them can be, and win on the boring parts.

Optimise every design decision for these five positions, in this priority order:

1. **IAM and Cost Explorer for agent money.** Cloud became usable at scale through scoped roles, budgets, and alerts. Agents have none of that for money. Deliver an org budget tree, sub-agent credentials that can only shrink, simulate-before-spend, and a kill switch. This is what every company deploying agents will need and cannot get today.
2. **The accept side.** API vendors and MCP server authors are being told to support six protocols. Let them accept from any agent over any rail with one configuration block. Cloudflare's equivalent works only behind Cloudflare and only for x402.
3. **The receipt as the unit of truth.** A portable, offline-verifiable receipt linking mandate, policy decision, settlement, fulfilment, and dispute outcome. Whoever defines it owns reconciliation, accounting export, audit, and compliance. No protocol does this today.
4. **Disputes without being the liable party.** Card networks will not touch machine disputes and wallets avoid the liability. Open contracts for hold, capture, refund, bonded challenge, and pluggable arbiters let the market resolve disputes while the gateway never holds funds or risk.
5. **Reputation that is actually true.** ERC-8004 reputation is mostly sybil because feedback is free. Accept feedback only against a settled receipt. This is only possible from inside the settlement path, and it is the data moat.

Neutrality is the product. Never prefer one rail, chain, stablecoin, or custody provider in the core path.

### Design principles (non-negotiable)

1. **Enforcement below the model.** No LLM output can move funds outside policy. The gateway evaluates policy and mirrors it as on-chain caveats; the agent never holds an unconstrained key.
2. **Rail-agnostic core, adapters at the edge.** One canonical `PaymentIntent`, one `Receipt`. x402, MPP, L402, AP2, and card-network tokens are adapters.
3. **Monotonic delegation.** A sub-agent's authority is always a strict subset of its parent's (macaroon-style attenuation), verifiable offline without contacting the gateway.
4. **Minimise facilitator trust.** Verify locally; support multi-facilitator quorum or direct on-chain settlement; never depend on one third party for correctness.
5. **Evidence by default.** Every decision (allow, deny, escalate) and every settlement produces a signed receipt.
6. **Human escalation is a first-class path**, not an exception handler.
7. **Fail closed.** Kill switch, circuit breakers, and expiry on everything.
8. **Self-hostable in one command.** Apache-2.0. No vendor API key required on the core path.

### Scope: modules and hard requirements

**M1. Agent identity and authentication**
- Agents are keypairs bound to a principal via a signed Mandate (AP2-compatible verifiable credential: principal, scope, limits, expiry). Support ERC-8004 registration read/write with CAIP-10 addressing. Pluggable attestation providers (Skyfire KYA, Catena ACK-ID) behind one interface.
- Session credentials: short-lived, scoped tokens carrying expiry, spend cap, counterparty allowlist, rail allowlist, purpose tag. Implement attenuation so an agent can mint a narrower child credential for a sub-agent offline.
- Gateway authentication: HTTP Message Signatures (RFC 9421) for compatibility with Visa TAP and Web Bot Auth, plus optional mTLS.

**M2. Policy engine**
- A declarative, versioned policy language (YAML/JSON plus a typed TypeScript DSL) covering per-transaction, daily, and monthly caps; velocity; counterparty allow/deny; rail, chain, and token allowlists; time windows; purpose categories; unit-price ceilings for metered services; approval thresholds; and budget hierarchies (org to team to agent to sub-agent) with reservations.
- Deterministic evaluation with a decision log; simulate/dry-run endpoint; policy diff with impact analysis against recent traffic.
- Compile a policy into on-chain caveats (ERC-7715 permissions, ERC-7710 delegation, EIP-7702 delegate with enforcer modules) so the chain rejects what the gateway would reject.
- Formal property checks: attenuation monotonicity and cap non-exceedance for a policy tree, via property-based tests at minimum and a TLA+ or Alloy model if feasible.

**M3. Smart contract layer (Solidity, Foundry)**
- `AgentAccount`: ERC-4337 and EIP-7702 compatible account with a session-key validator and enforcer modules (spend limit, time window, allowed targets, allowed methods, nonce/replay).
- `SettlementHub`: hold, capture and partial capture, refund; delayed fulfilment with deadlines; streaming channels (per-second or per-unit); batched settlement of EIP-3009 authorizations for nanopayments.
- `DisputeModule`: deterministic auto-resolution (timeout, amount mismatch, duplicate); bonded challenges; pluggable arbiter interface (ERC-8004 validation registry, optimistic oracle, designated human arbiter); appeal window; slashing split.
- `ReceiptRegistry`: anchors receipt hashes; ERC-8004 reputation feedback is accepted only when linked to a settled receipt.
- Transparent events for every state transition; proxy upgrades behind a timelock; emergency pause; per-principal circuit breaker.
- Chains: Base and Ethereum first; abstracted for Arc and Tempo; Solana and Lightning via adapters, not contracts.

**M4. Rail adapters (pay side and accept side for each)**
- x402 V2 (facilitator verify/settle, Bazaar discovery), MPP (challenge/credential/receipt, subscriptions, streaming), L402 (macaroons), AP2 mandates (checkout and payment; human-present and human-not-present), and a card-network token adapter interface (Visa TAP, Mastercard Agent Pay) with a reference stub.
- Accept side: middleware that lets any API, MCP server, or A2A agent charge via any supported rail with one configuration block. This is the missing merchant layer.
- Replay, free-riding, and settlement-race protections per the 2026 x402 security literature; PII-safe metadata filtering before anything leaves the gateway.

**M5. Gateway API (TypeScript, Node 22+, viem)**
- REST plus JSON-RPC plus WebSocket; OpenAPI 3.1 generated from code.
- Resources: intents (create, simulate, execute, cancel), credentials (issue, attenuate, revoke), policies (CRUD, diff, simulate), receipts (query, verify, export), disputes (open, evidence, resolve), budgets, kill switch, health.
- Signing backends: local keystore for dev, KMS/HSM, and an MPC provider interface. Keys never leave the signer.
- OpenTelemetry traces, Prometheus metrics, structured audit log, idempotency keys on every mutating call.

**M6. Developer SDK and agent integrations**
- TypeScript and Python SDKs with an identical surface: `pay()`, `charge()`, `delegate()`, `simulate()`, `receipt()`.
- An MCP server exposing the gateway as tools, an A2A extension, and adapters for Claude Agent SDK, OpenAI Agents SDK, LangGraph, Google ADK, Coinbase AgentKit, and Amazon Bedrock AgentCore.
- Operator CLI: init, policy lint, simulate, replay-a-receipt, export-evidence.

**M7. Evidence, compliance, and reputation**
- Receipt schema (JSON-LD and CBOR) binding mandate hash, intent, policy decision, signer attestation, settlement transaction, fulfilment proof, dispute outcome. Verifiable offline.
- Exports: accounting CSV and an ISO 20022-shaped record, a Travel-Rule-ready payload hook, and an evidence bundle for a disputed charge.
- Reputation computed only from settled receipts; published to ERC-8004 with the receipt link; sybil pattern detection.

### Explicit non-goals for v1

Do not build a wallet product, a facilitator business, a chain, fiat custody, a stablecoin, a consumer checkout UI (OpenAI's shut down in March 2026 with a dozen merchants), or trading and DeFi strategy logic. Do not design around one chain or one stablecoin; if a shortcut requires that, take the slower neutral path and record it in an ADR.

### Threat model

Design against all of the following and include a table mapping threat to control to test: prompt injection and memory poisoning; compromised agent framework; malicious or offline facilitator; replay and double-spend; free-riding; settlement race; sub-agent privilege escalation; key exfiltration; counterparty fraud and non-delivery; sybil reputation; PII leakage in payment metadata; insider policy tampering; chain reorgs; gas griefing.

### Phase 0 first: the thin slice

Before going deep on any module, ship one end-to-end slice that proves every differentiator at once and that no existing product can demonstrate:

> One agent, under one org budget with one sub-agent credential, pays one payee for the same resource over x402 and then over MPP with no change to agent code. One attempt violates policy and is denied by the gateway and by the on-chain account. Every step, including the denial, produces a receipt, and the run ends with an auditor-ready evidence bundle exported by the CLI.

Package the slice as an MCP server plus one framework adapter so a developer adopts it with one line of configuration. Only after this runs from a clean clone with one command do you deepen policy, disputes, and reputation.

### Deliverables, in this order

0. The Phase 0 thin slice: runnable demo, Docker Compose, README with the exact commands, and a recorded transcript of the run.
1. `ARCHITECTURE.md` with C4 context and container diagrams (Mermaid) and sequence diagrams for: pay-per-call via x402; subscription via MPP; hold/capture with dispute; sub-agent delegation; human escalation; kill switch.
2. Monorepo layout (pnpm workspaces plus Foundry): `packages/contracts`, `packages/gateway`, `packages/policy`, `packages/adapters/*`, `packages/sdk-ts`, `packages/sdk-py`, `packages/mcp-server`, `examples/`, `docs/`.
3. Smart contracts with Foundry unit, fuzz, and invariant tests; deployment scripts; Slither and Aderyn clean; a security checklist.
4. Gateway service with Docker Compose for local run (anvil, gateway, example payee, example agent), the OpenAPI spec, and integration tests.
5. SDKs, MCP server, and three runnable examples: (a) a research agent paying three APIs across x402 and MPP under one budget; (b) an org delegating budgets to two sub-agents with attenuation; (c) a pay-on-delivery job with a dispute and refund.
6. Policy language spec with grammar, ten example policies, and the property-based proof of attenuation.
7. `THREAT_MODEL.md`, `SECURITY.md`, and `ROADMAP.md` with phases: v0.1 local and testnet; v0.2 Base mainnet beta with audit; v1.0 multi-rail GA.
8. ADRs for every major choice (viem, 7702 plus 4337, receipt format, licence, chain order, facilitator strategy).

### Acceptance criteria

- The Phase 0 thin slice runs from a clean clone with one command and its evidence bundle verifies offline with no network access.
- No code path in the core depends on a specific vendor API key, chain, or stablecoin; a test swaps the rail and the signer backend without touching agent code.
- A compromised agent that emits a transfer outside policy is rejected by the gateway and, independently, by the on-chain account, and a receipt records the denial.
- A sub-agent credential can never exceed its parent's; a test demonstrates the rejection.
- The same `PaymentIntent` settles over x402 and over MPP with no change to agent code.
- A payee goes from unpaid API to charging agents over any supported rail in under 20 lines.
- Hold, dispute, refund completes end-to-end on a local chain with an evidence bundle exported.
- The kill switch halts all spending for a principal within one block or one request cycle, whichever applies.
- 90% or higher test coverage on policy and contracts; every example runs from a clean clone with one command.

### Working method

- Work in phases. At the end of each phase output the file tree, the key files in full, and the commands to build and test. Do not summarise code you have not written.
- Where a standard is ambiguous, choose the option that minimises trust in third parties and record the reason in an ADR.
- Name the exact spec version you implement: x402 V2, MPP IETF draft, AP2 v0.2, ERC-8004, ERC-8183, ERC-7715, ERC-7710, EIP-7702, ERC-4337, EIP-3009, RFC 9421.
- Prefer boring, auditable code over clever code. No secrets in code. Pin dependencies. Every public function has a test.

---

## Optional add-ons to the prompt

Paste any of these at the end if you want the model to go further.

- **Economic layer:** "Add a reputation-backed credit facility: a principal can underwrite a line of credit for an agent whose receipt history passes a configurable score; defaults are slashed from the underwriter's bond."
- **Cross-chain:** "Implement ERC-7683 intents so a budget on Base can pay a payee on Arc or Tempo via a solver, with the receipt chain spanning both chains."
- **Compliance pack:** "Produce a Travel Rule and GENIUS Act readiness document mapping each gateway data field to the regulatory field it satisfies, with jurisdictions where the mapping is unresolved flagged."
- **Benchmarks:** "Publish a benchmark harness measuring policy evaluation latency, settlement latency per rail, and cost per nanopayment, with results tables."
