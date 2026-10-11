# MachineNativeEconomy — project instructions

## What this repo is
SpendMarshal (packages `@spendmarshal/*`, formerly `apgw`), an open-source Agentic Payment Gateway: the neutral policy, settlement and evidence control plane between AI agents and any payment rail (x402, MPP, …). Phase 0 thin slice is complete and passing (8 Oct 2026). See `README.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, and the product prompt in `output/agentic-payment-gateway-prompt.md`.

## File locations (set 8 Oct 2026)

Keep **everything** for this project inside `E:\MachineNativeEconomy`:

| Kind | Path |
|------|------|
| Memory (facts, feedback, project notes) | `memory\` — index in `memory\MEMORY.md` |
| Context (research notes, positioning, session summaries) | `context\` |
| Output (deliverables such as the prompt) | `output\` |
| Code | `packages\*`, `examples\*`, `docs\*` |

Rules:
- Read `memory\MEMORY.md` at the start of each session.
- Write memory files to `memory\` with the harness frontmatter (`name`, `description`, `metadata.type`) and add a pointer line in `memory\MEMORY.md`.
- Use the scratchpad only for throwaway files.

## Build and test
Foundry must be on PATH for pnpm scripts: in Git Bash, `export PATH="$HOME/.foundry/bin:$PATH"` (foundryup installs to `~/.foundry/bin`).

```bash
pnpm install
pnpm contracts:build && node scripts/sync-abi.mjs   # after any Solidity change
pnpm build                                          # TS packages (core first; others import from dist)
pnpm test                                           # forge + vitest unit/property + e2e thin slice
pnpm demo                                           # the Phase 0 thin slice
pnpm demo:phase1                                    # Phase 1: EIP-7702, bounded operator, approvals, policy versions
```

- Contracts target `evm_version = "prague"`; `@spendmarshal/devnet` starts anvil with `--hardfork prague` so EIP-7702 type-4 transactions work.
- Phase 1 plan and status: `docs/PHASE1.md`. Work happens on the `phase-1` branch.
- `buildGateway()` is async (it opens the store). Store drivers: `json` (thin slice) and `sqlite` via better-sqlite3 (Phase 1 demo); the prebuilt native binary installed fine on this machine.
- x402 payload modes: `agent-account` (bundled facilitator) and `standard` (pre-approval + ERC-1271, any facilitator); see ADR-0009.
- RFC 9421 (core `httpsig.ts`): outbound Web Bot Auth to payees (`SPENDMARSHAL_SIGN_OUTBOUND`, `SPENDMARSHAL_PUBLIC_URL`), payee `agentAuth`, holder-bound credentials (`holder_key` caveat; SDK `delegate({ bindTo: "new" })`). Keep caveat JWKs to `{kty,crv,x}` only (strict schema).
- `/metrics` (prom-client), `/openapi.json`; regenerate `docs/openapi.json` with `node scripts/gen-openapi.mjs` after building the gateway.
- Subscriptions/streams: `POST /v1/subscriptions` (agent), `POST /v1/subscriptions/:id/charges` (payee, Bearer charge token); payee side `SubscriptionBook.charge()`. L402: `cfg.lightning` + `cfg.fx.satsPerUsdc`; `MockLightning` in devnet. Rails enum is `x402 | mpp | l402`.
- Demo arithmetic: 1 USDC = 1600 sats in the demo, so 10 sats = 0.00625 USDC; daily cap 0.14 is sized for the whole scenario.
- Outbound hygiene (core `net.ts`, ADR-0016): the gateway refuses loopback payee URLs unless `outbound.allowLoopback` (both demos set it) and private/link-local ones unless `outbound.allowPrivate` (`SPENDMARSHAL_OUTBOUND_ALLOW_LOOPBACK` / `_PRIVATE`), optional `outbound.allowedHosts`; a loopback gateway must be listed in the payee's `agentAuth.allowedAgents`. Redirects are never followed. `pause()` is owner or root session only. The policy pre-check runs with `stage: "structural"` (amount predicates wait for the quote).
- Production hygiene (ADR-0017): `Store.lastReceipt` + cached heads in `ReceiptLog` (never call `receiptsFor` on a hot path); viem `nonceManager` on relayer accounts; re-run `decide()` synchronously right before `store.reserve()` (no await in between); `payeeTimeoutMs` (`SPENDMARSHAL_PAYEE_TIMEOUT_MS`, demo uses 3 s with the payee's `/v1/slow` route; every viem client polls receipts at 500 ms, the 4 s default made MPP settlements look like timeouts); `Idempotency-Key` on intents and subscriptions (`idempotency.ts`); denial receipts throttled by `denials.ts`. The Phase 1 e2e expects 19 settlements.
- Facilitator URL convention (x402): `facilitatorUrl` is the base and the payee calls `<base>/verify` and `<base>/settle`; the bundled facilitator lives at `<gatewayUrl>/facilitator`, the public one is `https://x402.org/facilitator`. Facilitator HTTP errors come back as 402 with the reason, never 500. Base's public RPC returns receipts for the block still being built (Flashblocks), one ahead of `latest`: always wait with core's `waitForInclusion(client, hash)`, never bare `waitForTransactionReceipt` (ADR-0018). The gateway clamps child sessions to its root session (caps, window).
- `POST /v1/maintenance/reclaim` (admin) restores charges of expired, unused standard-x402 pre-approvals; run it on a schedule in deployments. ERC-4337: `setEntryPoint` + `validateUserOp` (session-key signed); no bundler in the demos, Foundry covers it.

- Packages import each other from `dist/`, so rebuild `@spendmarshal/core` before typechecking dependants.
- The demo uses anvil dev keys only; `data/` and `evidence/*.json` are gitignored.
- Docker is installed but the daemon was not running when `docker-compose.yml` was written; it is untested.
- Ledger reads are per principal: `Store.ledgerView(principalId)` and `Store.spent(principalId)`; budget names and agent ids are only unique within a principal (ADR-0018).
- Live run: `pnpm demo:testnet` settles through the public x402.org facilitator (`SPENDMARSHAL_TESTNET_FACILITATOR=bundled` for the gateway's own). Keys in `local/testnet-*.key`, deploy cache and secrets in `local/testnet-deploy.json`, store in `local/testnet-data`. `local/testnet-gateway.key` is the operator: each run generates a fresh in-memory session key, funds it from the operator and sweeps the rest back (session keys are single-use on-chain). Standard payloads carry core's `PREAPPROVED_SIGNATURE`, never zero bytes: facilitators split it into (v, r, s). See `docs/TESTNET.md` and ADR-0018.
