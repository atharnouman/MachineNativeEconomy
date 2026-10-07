# Phase 0 build notes (8 Oct 2026)

## What was built
pnpm monorepo at repo root. Packages: `contracts` (Foundry), `core`, `gateway`, `payee`, `sdk-ts`, `mcp-server`, `cli`; `examples/thin-slice`. Docs: README, ARCHITECTURE (Mermaid C4 + sequences), THREAT_MODEL, ROADMAP, SECURITY, 5 ADRs, LICENSE (Apache-2.0), docker-compose + Dockerfile (untested, Docker daemon off).

## Key design decisions made during the build
- **x402 payload kind `agent-account`**: standard x402 `exact` uses EIP-3009 signed by an EOA; a smart account can't sign that. So the facilitator accepts a payload `{kind:'agent-account', account, authorization, signature}` whose on-chain settlement is `AgentAccount.payWithAuthorization`. Wire protocol (PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE headers, /verify /settle) unchanged. EIP-3009 kind also schema'd but not used by the demo.
- **MPP** implemented at the draft's challenge/credential/receipt shape: `WWW-Authenticate: Payment realm, challenge=<b64>`; `Authorization: Payment <b64>`; `Payment-Receipt` header. Payee settles itself with a relayer key.
- **Session keys derived** from `HMAC(sessionSecret, credentialId)` → keccak → private key. Nothing stored; rotating the secret invalidates all sessions.
- **Receipts**: canonical JSON (sorted keys), keccak hash, EIP-191 signature by gateway key, `prev`/`seq` chain per principal; `ReceiptLog.append` serialised with a promise chain to avoid seq races.
- **Gateway confirms every settlement on-chain** (`PaymentExecuted(intentHash, amount, to)` log) before committing budgets; a lying payee/facilitator cannot charge the ledger.
- **simulate** fetches the real 402 (free) so it reports the quoted price, payee address, rail, and the account contract's own `simulate()` revert reason.
- Budget ledger counts reserved + settled; `release` clamps at 0.

## Gotchas hit
- `forge` must be on PATH for pnpm scripts (Git Bash: `export PATH="$HOME/.foundry/bin:$PATH"`).
- anvil 1.8.5 rejects `--block-time 0`.
- viem puts raw revert bytes in `ContractFunctionRevertedError.raw`; `data` is only populated when the ABI knows the error. `describeRevert` now walks `raw`, then `data`, then the selector in the message.
- Foundry `vm.prank` is consumed by the next external call, including a view helper call on a handler contract.
- Bash heredocs failed to parse in this tool environment; use the Write tool for files.

## Numbers from the passing run
AgentAccount funded 10.00 USDC; 4 settlements (x402, MPP, auto→x402, parent MPP) = 0.07 USDC; 25 receipts; 3 credentials; 1 anchor at block 18; verifier 9/9.
