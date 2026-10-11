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

- Packages import each other from `dist/`, so rebuild `@spendmarshal/core` before typechecking dependants.
- The demo uses anvil dev keys only; `data/` and `evidence/*.json` are gitignored.
- Docker is installed but the daemon was not running when `docker-compose.yml` was written; it is untested.
