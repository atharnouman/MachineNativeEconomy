# MachineNativeEconomy — project instructions

## What this repo is
`apgw`, an open-source Agentic Payment Gateway: the neutral policy, settlement and evidence control plane between AI agents and any payment rail (x402, MPP, …). Phase 0 thin slice is complete and passing (8 Oct 2026). See `README.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, and the product prompt in `output/agentic-payment-gateway-prompt.md`.

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

- Contracts target `evm_version = "prague"`; `@apgw/devnet` starts anvil with `--hardfork prague` so EIP-7702 type-4 transactions work.
- Phase 1 plan and status: `docs/PHASE1.md`. Work happens on the `phase-1` branch.
- `buildGateway()` is async (it opens the store). Store drivers: `json` (thin slice) and `sqlite` via better-sqlite3 (Phase 1 demo); the prebuilt native binary installed fine on this machine.
- x402 payload modes: `agent-account` (bundled facilitator) and `standard` (pre-approval + ERC-1271, any facilitator); see ADR-0009.
- RFC 9421 (core `httpsig.ts`): outbound Web Bot Auth to payees (`APGW_SIGN_OUTBOUND`, `APGW_PUBLIC_URL`), payee `agentAuth`, holder-bound credentials (`holder_key` caveat; SDK `delegate({ bindTo: "new" })`). Keep caveat JWKs to `{kty,crv,x}` only (strict schema).
- `/metrics` (prom-client), `/openapi.json`; regenerate `docs/openapi.json` with `node scripts/gen-openapi.mjs` after building the gateway.
- Subscriptions/streams: `POST /v1/subscriptions` (agent), `POST /v1/subscriptions/:id/charges` (payee, Bearer charge token); payee side `SubscriptionBook.charge()`. L402: `cfg.lightning` + `cfg.fx.satsPerUsdc`; `MockLightning` in devnet. Rails enum is `x402 | mpp | l402`.
- Demo arithmetic: 1 USDC = 1600 sats in the demo, so 10 sats = 0.00625 USDC; daily cap 0.14 is sized for the whole scenario.
- Outbound hygiene (core `net.ts`, ADR-0016): the gateway refuses loopback payee URLs unless `outbound.allowLoopback` (both demos set it) and private/link-local ones unless `outbound.allowPrivate` (`APGW_OUTBOUND_ALLOW_LOOPBACK` / `_PRIVATE`), optional `outbound.allowedHosts`; a loopback gateway must be listed in the payee's `agentAuth.allowedAgents`. Redirects are never followed. `pause()` is owner or root session only. The policy pre-check runs with `stage: "structural"` (amount predicates wait for the quote).
- `POST /v1/maintenance/reclaim` (admin) restores charges of expired, unused standard-x402 pre-approvals; run it on a schedule in deployments. ERC-4337: `setEntryPoint` + `validateUserOp` (session-key signed); no bundler in the demos, Foundry covers it.

- Packages import each other from `dist/`, so rebuild `@apgw/core` before typechecking dependants.
- The demo uses anvil dev keys only; `data/` and `evidence/*.json` are gitignored.
- Docker is installed but the daemon was not running when `docker-compose.yml` was written; it is untested.
