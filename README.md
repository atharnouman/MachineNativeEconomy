# apgw — Agentic Payment Gateway

**The neutral policy, settlement and evidence control plane between AI agents and any payment rail.**
Open source (Apache-2.0), self-hostable, no vendor key on the core path.

Envoy + OPA + Stripe Radar for machine money, with enforcement in cryptography and smart contracts rather than in the LLM.

```
agent / MCP client ──▶ gateway ──▶ payee (x402 | MPP | …)
                         │  policy below the model
                         │  session-key signer
                         ▼
                   AgentAccount.sol  (caveats enforced on-chain, kill switch)
                   ReceiptRegistry.sol (anchored evidence)
```

## Why this exists

As of October 2026 every payment rail for agents is vendor-bundled and none of them interoperate: x402 (Coinbase → Linux Foundation), MPP (Stripe/Tempo), L402, AP2 (Google), Visa TAP, Mastercard Agent Pay. Wallets from Coinbase, Cloudflare and Circle each bundle custody + policy + one rail. Disputes, refunds, multi-agent budgets, portable audit evidence and sybil-resistant reputation are unsolved. More than $45M was lost in 2026 to prompt-injected agents with wallet access.

`apgw` is the piece nobody ships: rail-agnostic on both the paying and the accepting side, with spending policy enforced *below* the model (gateway + on-chain caveats), hierarchical delegation that can only shrink, and a signed receipt chain an auditor verifies offline.

Full positioning: [`context/positioning.md`](context/positioning.md). Landscape research: [`context/2026-10-08-agentic-payments-landscape.md`](context/2026-10-08-agentic-payments-landscape.md).

## Phase 0: the thin slice (this repo, today)

> One agent, under one org budget with one sub-agent credential, pays one payee for the same resource over **x402** and then over **MPP** with no change to agent code. One attempt violates policy and is denied by the gateway **and** by the on-chain account. Every step, including denials, produces a signed receipt, and the run ends with an auditor-ready evidence bundle exported by the CLI and verified offline.

```bash
pnpm demo
```

Output of a real run (abridged; full transcript in [`docs/thin-slice-transcript.md`](docs/thin-slice-transcript.md)):

```
✔ credentials: research-agent cap 1.00/0.30 → fetcher cap 0.10/0.02; on-chain session … perTxMax=0.02
✔ delegation is monotonic: sub-sub-agent appended per_tx_max=0.50 but its on-chain session still has perTxMax=0.02
✔ pay via x402: x402 settled 0.01 USDC in tx 0xcc8b9ffe… → {"symbol":"ETH","price":1985,…}
✔ pay via MPP:  mpp  settled 0.01 USDC in tx 0x6bf7bee5… → {"symbol":"ETH","price":1985,…}
✔ simulate reports both denials: policy: CAVEAT:per_tx_max | account.simulate: PerTxLimitExceeded(40000,20000)
✔ gateway denies over-limit: denied: CAVEAT:per_tx_max (nothing signed, nothing sent)
✔ chain denies with stolen key: payWithAuthorization reverted: PerTxLimitExceeded(40000, 20000)
✔ kill switch: gateway: KILL_SWITCH; account.paused=true
✔ anchor: receipt head 0xcb3fd60a… (#24) anchored in tx 0x98970e28… block 18
✔ evidence bundle: 25 receipts, 3 credentials, 1 anchor → evidence/thin-slice-….json
VERIFIED: 9/9 checks
THIN SLICE PASSED: 14/14 steps
```

## Quick start

Prerequisites: Node ≥ 20.17, pnpm 9, [Foundry](https://getfoundry.sh) (`forge`, `anvil` on PATH).

```bash
pnpm install
pnpm contracts:build && node scripts/sync-abi.mjs   # compile Solidity, copy ABIs into @apgw/core
pnpm build                                          # TypeScript packages
pnpm test                                           # Foundry (unit/fuzz/invariant) + vitest (unit/property/e2e)
pnpm demo                                           # the thin slice, from a clean clone, one command
```

The demo starts a local anvil chain, deploys the contracts, runs the gateway and an example payee in-process, drives the scenario through the public SDK, and writes `evidence/thin-slice-<timestamp>.json`.

Verify any bundle offline, and optionally confirm its anchor on-chain:

```bash
pnpm --filter @apgw/cli start verify evidence/thin-slice-<timestamp>.json --rpc http://127.0.0.1:8545
```

## Using it from an agent

**SDK (TypeScript)** — the whole integration is `pay()`:

```ts
import { ApgwClient } from "@apgw/sdk";
const agent = new ApgwClient("http://127.0.0.1:4402", process.env.APGW_CREDENTIAL!);
const r = await agent.pay({ url: "https://data.example/v1/quote?symbol=ETH", maxAmount: "0.02", purpose: "research" });
// r.ok, r.rail ("x402" | "mpp"), r.settlement.txHash, r.body, r.receipts[]

// delegate a narrower credential to a sub-agent, offline, no root key needed
const fetcher = await agent.delegate({ agentId: "fetcher", caveats: [{ type: "per_tx_max", value: "20000" }] });
```

**MCP server** — for Claude, ChatGPT, Gemini, Cursor or any MCP client:

```json
{ "mcpServers": { "apgw": { "command": "npx", "args": ["-y", "@apgw/mcp-server"], "env": { "APGW_URL": "http://127.0.0.1:4402", "APGW_CREDENTIAL": "<base64url credential>" } } } }
```

Tools: `apgw_pay`, `apgw_simulate`, `apgw_receipts`, `apgw_whoami`. The model never sees a key.

**Any framework** — `apgwTools(client)` returns JSON-Schema tool definitions for OpenAI function calling, Vercel AI `jsonSchema()`, LangChain, Google ADK.

## Accepting agent payments (the missing merchant side)

One configuration block sells any Fastify route over x402 and MPP at once:

```ts
import { paid } from "@apgw/payee";
app.get("/v1/quote", { preHandler: paid({
  rails: ["x402", "mpp"],
  price: { amount: "10000", token: USDC, chainId: 8453 },   // 0.01 USDC
  payTo: TREASURY,
  facilitatorUrl: "https://x402.org/facilitator",            // x402: any facilitator
  mpp: { rpcUrl, relayerPrivateKey },                        // MPP: you settle, no facilitator
}) }, handler);
```

An unpaid request gets a 402 carrying **both** an x402 `PAYMENT-REQUIRED` header and an MPP `WWW-Authenticate: Payment` challenge; the agent picks.

## Repository layout

| Package | What |
|---|---|
| `packages/contracts` | Solidity (Foundry): `AgentAccount` (session caveats, enforcers, pause, EIP-7702-ready), `MockUSDC` (EIP-3009), `ReceiptRegistry`. 24 tests incl. fuzz + invariants. |
| `packages/core` | Canonical types: `PaymentIntent`, macaroon-style attenuable `Credential`, policy evaluator, signed `Receipt`, `EvidenceBundle` + offline verifier, x402/MPP wire formats, ABIs. Property tests prove delegation monotonicity. |
| `packages/gateway` | The service: policy below the model, session-key signer, x402 + MPP pay-side adapters, local x402 facilitator, hash-chained receipt log, evidence export, kill switch. |
| `packages/payee` | Accept-side middleware `paid()` + example payee. |
| `packages/sdk-ts` | `ApgwClient` / `ApgwAdmin`, framework-neutral tool definitions. |
| `packages/mcp-server` | MCP server over the SDK. |
| `packages/cli` | `apgw export-evidence`, `apgw verify`, `apgw policy lint`. |
| `examples/thin-slice` | The Phase 0 demo + its end-to-end vitest. |
| `docs/` | [ARCHITECTURE](docs/ARCHITECTURE.md), [THREAT_MODEL](docs/THREAT_MODEL.md), [ROADMAP](docs/ROADMAP.md), [ADRs](docs/adr/). |

## Design principles

1. **Enforcement below the model.** No LLM output can move funds outside policy; the agent never holds an unconstrained key.
2. **Rail-agnostic core, adapters at the edge.** One `PaymentIntent`, one `Receipt`.
3. **Monotonic delegation.** A sub-agent's authority is a strict subset of its parent's, verifiable offline (and re-checked on-chain).
4. **Minimise facilitator trust.** Every settlement is confirmed on-chain by the gateway itself.
5. **Evidence by default.** Every decision and settlement is a signed, hash-chained receipt.
6. **Human escalation is a first-class path.**
7. **Fail closed.** Kill switch, expiry on everything.
8. **Self-hostable in one command.** Apache-2.0.

## Status

Phase 0 complete on a local chain. Not audited. Do not use with real funds. See [ROADMAP](docs/ROADMAP.md).
