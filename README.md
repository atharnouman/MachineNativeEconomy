# SpendMarshal — Agentic Payment Gateway

Formerly `apgw` (renamed 11 October 2026); the old name still appears in early design notes.

**The neutral policy, settlement and evidence control plane between AI agents and any payment rail.**
Open source (Apache-2.0), self-hostable, no vendor key on the core path.

Envoy + OPA + Stripe Radar for machine money, with enforcement in cryptography and smart contracts rather than in the LLM.

```
agent / MCP client ──▶ gateway ──▶ payee (x402 | MPP | …)
                         │  policy below the model · approvals · policy versions
                         │  session-key signer (bounded operator)
                         ▼
                   AgentAccount.sol  (capability chain enforced on-chain, kill switch; EIP-7702-ready)
                   ReceiptRegistry.sol (anchored evidence)
```

## Why this exists

As of October 2026 every payment rail for agents is vendor-bundled and none of them interoperate: x402 (Coinbase → Linux Foundation), MPP (Stripe/Tempo), L402, AP2 (Google), Visa TAP, Mastercard Agent Pay. Wallets from Coinbase, Cloudflare and Circle each bundle custody + policy + one rail. Disputes, refunds, multi-agent budgets, portable audit evidence and sybil-resistant reputation are unsolved. More than $45M was lost in 2026 to prompt-injected agents with wallet access.

SpendMarshal is the piece nobody ships: rail-agnostic on both the paying and the accepting side, with spending policy enforced *below* the model (gateway + on-chain caveats), hierarchical delegation that can only shrink, human approvals that are signed and verifiable, and a signed receipt chain an auditor verifies offline.

Full positioning: [`context/positioning.md`](context/positioning.md). Landscape research: [`context/2026-10-08-agentic-payments-landscape.md`](context/2026-10-08-agentic-payments-landscape.md).

## Two demos, one command each

**Phase 0, the thin slice** (`pnpm demo`): one agent, one budget, one sub-agent credential pays one payee for the same resource over x402 and then MPP with no change to agent code; an over-limit attempt is denied by the gateway and, independently, by the account contract; a stolen session key still cannot exceed its caveats on-chain; kill switch; anchored evidence bundle verified offline. 14 steps. Transcript: [`docs/thin-slice-transcript.md`](docs/thin-slice-transcript.md).

**Phase 1** (`pnpm demo:phase1`): an EOA that already holds USDC becomes the agent account via EIP-7702 without moving funds; the gateway is a bounded operator, not the owner; the payee refuses anonymous bots and serves the gateway's signed requests; the sub-agent's credential is holder-bound and useless when stolen; sub-agent stopped by a rate-limit caveat and a daily budget; an escalated purchase approved with a CFO-key signature, resumed and settled, another rejected; the same `pay()` call in `standard` mode settles through a plain EIP-3009 `transferWithAuthorization` after an on-chain pre-approval, the shape every public x402 facilitator accepts; a subscription the payee charges on a cadence (early charge refused, on-time charge settled, cancelled by the agent) and a metered stream capped per cycle; a Lightning purchase over L402 with the preimage as proof, counted against the same daily budget; a policy update receipted with a diff and impact analysis; the gateway pauses from its session key and only the owner can unpause; metrics and OpenAPI served; evidence verifies 11 of 11 checks including policy versions and approval signatures. Runs on the SQLite store. 26 steps. Transcript: [`docs/phase1-transcript.md`](docs/phase1-transcript.md).

```
✔ EIP-7702 delegation: EOA 0x90F7… now runs AgentAccount code, owner is itself, balance unchanged at 10 USDC
✔ gateway is a bounded operator: owner granted gateway a root session: cap 3, perTx 0.5, payee allowlist
✔ payee requires Web Bot Auth: anonymous GET → 401 Accept-Signature: sig1=("@authority" "signature-agent");tag="web-bot-auth"
✔ gateway refuses to fetch private addresses: 403 outbound blocked: host 169.254.169.254 is private or link-local
✔ subscription visibility follows the credential chain: child sees 0, opener sees 1, admin sees 1; child cancel -> 404
✔ five concurrent payments settle through one relayer key: x402 0.01 USDC tx 0x3528eaec… | x402 0.01 USDC tx 0x34fb3702… | …
✔ a retried request with the same Idempotency-Key pays once: retry replayed=true, same settlement=true
✔ a payee that never answers times out, nothing reserved: 502 payee unreachable: timeout
✔ stolen credential is useless without the holder key: 401 holder signature required: unknown key …
✔ rate_limit caveat stops the 4th payment in 10m: denied: CAVEAT:rate_limit:cred_…
✔ escalation returns 202: report costs 0.04 > 0.03 threshold → approval apr_… pending
✔ CFO signs the approval: approver cfo (0x15d3…), signature 0xb68f…
✔ resume settles under the approval: x402 0.04 USDC tx 0xf9ec…
✔ standard x402 payload via ERC-1271: account pre-approved the EIP-3009 digest, facilitator settled with transferWithAuthorization: works with any x402 facilitator
✔ lineage spend on-chain: gateway root spent 0.11 = research-agent 0.11 = payee balance 0.11; fetcher 0.03
✔ policy v2 receipted with impact: impact: 1 past intent(s) now deny (RULE_DENY:deny-full-reports)
✔ kill switch: gateway paused on-chain; gateway unpause → owner-required: NotOwner(…); owner unpause → paused=false
✔ payee charges on cadence; agent cancels: too early → 429; on time → settled 0.01; after cancel → 410
✔ metered stream: 30 tokens × 0.0001 → settled 0.003 USDC; 60 tokens (0.006) → 403 charge exceeds amountPerCharge
✔ L402 over Lightning: 10 sats at 1600 sats/USDC = 0.00625 USDC against policy; preimage matches invoice hash
✔ orphaned pre-approval reclaimed after expiry: charge +0.001 at approval; after expiry → 1 reclaimed, session spent back
✔ metrics + OpenAPI: /metrics has spendmarshal_payments_total; /openapi.json is OpenAPI 3.1.0 with 29 paths
VERIFIED: 12/12 checks
PHASE 1 PASSED: 31/31 steps
```

## Quick start

Prerequisites: Node ≥ 20.17, pnpm 9, [Foundry](https://getfoundry.sh) (`forge`, `anvil` on PATH).

```bash
pnpm install
pnpm contracts:build && node scripts/sync-abi.mjs   # compile Solidity, copy ABIs into @spendmarshal/core
pnpm build                                          # TypeScript packages
pnpm test                                           # Foundry (unit/fuzz/invariant/7702) + vitest (unit/property/e2e)
pnpm demo                                           # Phase 0
pnpm demo:phase1                                    # Phase 1
```

Each demo starts a local anvil chain (Prague hardfork), deploys the contracts, runs the gateway and an example payee in-process, drives the scenario through the public SDK, and writes `evidence/<name>-<timestamp>.json`. Verify any bundle offline, and optionally confirm its anchor on-chain:

```bash
pnpm --filter @spendmarshal/cli start verify evidence/phase1-<timestamp>.json --rpc http://127.0.0.1:8545
```

## Using it from an agent

**SDK (TypeScript)** — the whole integration is `pay()`; a 202 means a human must approve:

```ts
import { SpendMarshalClient } from "@spendmarshal/sdk";
const agent = new SpendMarshalClient("http://127.0.0.1:4402", process.env.SPENDMARSHAL_CREDENTIAL!);

const r = await agent.pay({ url: "https://data.example/v1/report", maxAmount: "0.05", purpose: "research" });
if (r.status === 202) {
  await agent.waitForApproval(r.pending!.approvalId);   // a human decides; the decision is a signed receipt
  const done = await agent.resume(r.pending!.approvalId);
}

// delegate a narrower credential to a sub-agent, offline, no root key needed; the chain enforces it too
const fetcher = await agent.delegate({
  agentId: "fetcher",
  caveats: [{ type: "per_tx_max", value: "20000" }, { type: "rate_limit", window: "10m", max_count: 3 }],
});
```

**Operator** — approve with a signature, version a policy, pull the evidence:

```ts
import { SpendMarshalAdmin } from "@spendmarshal/sdk";
const admin = new SpendMarshalAdmin("http://127.0.0.1:4402", process.env.SPENDMARSHAL_ADMIN_TOKEN!);
await admin.resolveApproval(id, "approve", "cfo", { signer: cfoAccount, principalId: "org-acme" });
const { diff, impact } = await admin.updatePolicy("org-acme", newYaml, "alice@org-acme");
const bundle = await admin.exportEvidence("org-acme");
```

**MCP server** — for Claude, ChatGPT, Gemini, Cursor or any MCP client:

```json
{ "mcpServers": { "spendmarshal": { "command": "npx", "args": ["-y", "@spendmarshal/mcp-server"], "env": { "SPENDMARSHAL_URL": "http://127.0.0.1:4402", "SPENDMARSHAL_CREDENTIAL": "<base64url credential>" } } } }
```

Tools: `spendmarshal_pay`, `spendmarshal_simulate`, `spendmarshal_resume`, `spendmarshal_approval`, `spendmarshal_receipts`, `spendmarshal_whoami`. The model never sees a key.

**Any framework** — `spendmarshalTools(client)` returns JSON-Schema tool definitions for OpenAI function calling, Vercel AI `jsonSchema()`, LangChain, Google ADK.

## Accepting agent payments (the missing merchant side)

One configuration block sells any Fastify route over x402 and MPP at once:

```ts
import { paid } from "@spendmarshal/payee";
app.get("/v1/quote", { preHandler: paid({
  rails: ["x402", "mpp"],
  price: { amount: "10000", token: USDC, chainId: 8453 },   // 0.01 USDC
  payTo: TREASURY,
  facilitatorUrl: "https://x402.org/facilitator",            // x402: any facilitator
  mpp: { rpcUrl, relayerPrivateKey },                        // MPP: you settle, no facilitator
}) }, handler);
```

An unpaid request gets a 402 carrying **both** an x402 `PAYMENT-REQUIRED` header and an MPP `WWW-Authenticate: Payment` challenge; the agent picks.

## Subscriptions, streams and Lightning

A payee can offer a resource on a cadence. The agent opens it with one call, the first cycle is paid at once, and the payee bills later cycles itself against the gateway, within the terms and under the agent's full policy every time:

```ts
const feed = await agent.subscribe({ url: "https://data.example/v1/feed", purpose: "research", maxAmountPerCharge: "0.02", maxCharges: 30 });
// payee side, each billing cycle:
await book.charge(payeeSubscriptionId, { units: 30 });   // 429 too early · 403 over cap · 410 cancelled · 200 settled on-chain
await agent.cancelSubscription(feed.subscription!.id);
```

A metered stream is a subscription with a unit price and a per-cycle cap. [ADR-0013](docs/adr/0013-subscriptions-and-streams.md).

Lightning works through the same `pay()`: an L402 challenge is converted at a configured sats-per-USDC rate, policy runs on that amount, the invoice is paid through your Lightning backend, and the preimage is verified against the invoice hash and kept as proof. [ADR-0014](docs/adr/0014-l402-lightning.md).

## Works with standard x402 facilitators

Two payload modes, one policy engine (`x402Mode` per gateway, overridable per payment):

| Mode | How it settles | Needs |
|---|---|---|
| `agent-account` (default) | one transaction: `AgentAccount.payWithAuthorization` | a facilitator that knows the account (the bundled one) |
| `standard` | the account pre-approves the EIP-3009 digest under its caveats, then the facilitator calls plain `transferWithAuthorization`; the token asks the account via ERC-1271 | a facilitator that checks contract payers through ERC-1271; proven live with the public x402.org facilitator on Base Sepolia ([transcript](docs/testnet-transcript.md)) |

Either way every caveat is enforced on-chain and the gateway confirms the settlement itself. Details in [ADR-0009](docs/adr/0009-standard-x402-interop.md).

## Who is calling

**To payees** the gateway signs every request as a Web Bot Auth agent (RFC 9421, Ed25519) and publishes its key in a signed directory at `/.well-known/http-message-signatures-directory`, the shape Visa's Trusted Agent Protocol and Cloudflare verify. The payee middleware can require it: `paid({ agentAuth: { require: true } })` answers anonymous bots with 401 and `Accept-Signature`, and tells your handler which gateway stood behind each settlement. Pin `allowedAgents` in production: unlisted origins must be public, and loopback or private origins are never fetched.

**To the gateway** a credential can be holder-bound: `agent.delegate({ ..., bindTo: "new" })` binds the sub-agent's credential to a fresh Ed25519 key that never leaves its process. Every request is then signed over method, authority, path and body digest, so a leaked credential is useless on its own. [ADR-0011](docs/adr/0011-http-message-signatures.md).

## Operations

`/metrics` (Prometheus: payments by rail and outcome, denial reasons, approvals, receipts, latency), `/openapi.json` (OpenAPI 3.1 generated from the route validators; also exported to [`docs/openapi.json`](docs/openapi.json)), structured logs with secrets redacted (`SPENDMARSHAL_LOG_LEVEL`). [ADR-0012](docs/adr/0012-observability-openapi.md).

## Storage

`SPENDMARSHAL_STORE=json` (zero-dependency file, demos), `SPENDMARSHAL_STORE=sqlite` (WAL file via better-sqlite3, recommended for a single self-hosted gateway, no server to run) or `SPENDMARSHAL_STORE=postgres` with `SPENDMARSHAL_DATABASE_URL` (several gateway instances on one database, behind any load balancer). Same interface, same tests; SQLite and Postgres migrate themselves on start. [ADR-0010](docs/adr/0010-store-drivers.md), [ADR-0025](docs/adr/0025-postgres-store-and-several-instances.md).

## Policy in one glance

```yaml
budgets:
  org:            { cap: "5.00" }                                   # lifetime
  research:       { cap: "2.00", parent: org, period: monthly }
  research-daily: { cap: "0.11", parent: research, period: daily }
agents:
  research-agent: { budget: research-daily }                        # sub-agents inherit via credential lineage
velocity:
  - { id: principal-burst, scope: principal, window: 10m, max_count: 20 }
rules:
  - { id: deny-blocked-payees, effect: deny,     match: { payees: [evil.example] } }
  - { id: escalate-above-3c,   effect: escalate, match: { amount_gt: "0.03" } }
  - { id: allow-research-data, effect: allow,    match: { purposes: [research], rails: [x402, mpp] } }
```

Credential caveats (`spend_cap`, `per_tx_max`, `allowed_payees`, `allowed_rails`, `purposes`, `chains`, `expires_at`, `not_before`, `rate_limit`) can only ever shrink along a delegation chain, off-chain and on-chain.

## Repository layout

| Package | What |
|---|---|
| `packages/contracts` | Solidity (Foundry): `AgentAccount` (capability chain of sessions, enforcers, lineage spend, pause; EIP-7702 self-only `initialize`; EIP-3009 pre-approval + ERC-1271 + reclaim; ERC-4337 `validateUserOp` for session keys), `MockUSDC` (EIP-3009 with ERC-1271 like FiatToken v2.2), `ReceiptRegistry`. 46 tests incl. fuzz, invariants, 7702 delegation, standard-facilitator interop and 4337 validation. |
| `packages/core` | Canonical types: `PaymentIntent`, macaroon-style attenuable `Credential`, policy evaluator (periods, velocity, approvals), signed `Receipt`, `EvidenceBundle` + offline verifier (policy versions, approval signatures), x402 (both payload shapes) / MPP wire formats, on-chain verify/settle helpers, ABIs. |
| `packages/gateway` | The service: policy below the model, derived session-key signer, x402 (agent-account and standard modes) + MPP pay-side adapters, local x402 facilitator accepting both payload shapes, approvals, policy versions, hash-chained receipt log, evidence export, kill switch, JSON and SQLite store drivers. |
| `packages/payee` | Accept-side middleware `paid()` for x402, MPP and L402, Web Bot Auth verification, subscription offers and the `SubscriptionBook` billing client; example payee. |
| `packages/sdk-ts` | `SpendMarshalClient` / `SpendMarshalAdmin`, framework-neutral tool definitions. |
| `packages/mcp-server` | MCP server over the SDK. |
| `packages/cli` | `spendmarshal export-evidence`, `spendmarshal verify`, `spendmarshal policy lint`. |
| `packages/devnet` | anvil lifecycle, deployment, EIP-7702 delegation helper, dev keys. |
| `examples/thin-slice`, `examples/phase1` | The two demos and their end-to-end tests; each ships a real sample evidence bundle. |
| `docs/` | [ARCHITECTURE](docs/ARCHITECTURE.md), [PHASE1](docs/PHASE1.md), [THREAT_MODEL](docs/THREAT_MODEL.md), [ROADMAP](docs/ROADMAP.md), [ADRs](docs/adr/). |

## Design principles

1. **Enforcement below the model.** No LLM output can move funds outside policy; the agent never holds an unconstrained key.
2. **Rail-agnostic core, adapters at the edge.** One `PaymentIntent`, one `Receipt`.
3. **Monotonic delegation.** A sub-agent's authority is a strict subset of its parent's, verifiable offline and re-checked on-chain, with spend charged to every ancestor.
4. **Minimise facilitator trust.** Every settlement is confirmed on-chain by the gateway itself.
5. **Evidence by default.** Every decision, settlement, approval and policy change is a signed, hash-chained receipt.
6. **Human escalation is a first-class path.** Signed approvals, resume, expiry.
7. **Fail closed.** Kill switch from the gateway flag or any root session key, owner-only unpause, expiry on everything. The gateway refuses private destinations and never follows a payee redirect.
8. **Self-hostable in one command.** Apache-2.0.

## Status

All Phase 1 milestones (1.1–1.11) complete on a local chain (see [PHASE1.md](docs/PHASE1.md)). Live on Base Sepolia since 11 October 2026: an EIP-7702 delegated account paying through the public x402.org facilitator with Circle's testnet USDC, with escalation, budget denial and offline-verified evidence, 12 of 12 steps ([transcript](docs/testnet-transcript.md), [run notes](docs/TESTNET.md)). Not audited. Do not use with real funds.
