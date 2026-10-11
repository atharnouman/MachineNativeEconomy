# Phase 1 transcript

Recorded 2026-10-11T08:17:55Z on Windows 11, Node v20.17.0, anvil 1.8.5 (prague), SQLite store, mock Lightning, with `pnpm demo:phase1` from a clean `data/`. Exit code 0.

```text
anvil up on :8545 (~\.foundry\bin\anvil.exe, prague)
✔ EIP-7702 delegation: EOA 0x90F79bf6EB2c4f870365E785982E1f101E93b906 now runs AgentAccount code (tx 0xe4120b21…), owner is itself, balance unchanged at 10 USDC
✔ initialize is self-only: a stranger calling initialize on Alice's account reverted: NotSelf(…)
✔ gateway is a bounded operator: owner granted gateway 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 a root session: cap 3, perTx 0.5, payee allowlist
✔ services: gateway http://127.0.0.1:4402 (store: sqlite), payee http://127.0.0.1:4403, policy v1 0x5d17ef1d…
✔ payee requires Web Bot Auth: anonymous GET → 401 Accept-Signature: sig1=("@authority" "signature-agent");tag="web-bot-auth"; gateway key PT_2-y7luc7q… published in a signed directory
✔ credential chain mirrors on-chain: research-agent session 0x4BdBB91E… has parent = gateway root session; fetcher is its child
✔ sub-agent pays over both rails: x402 0.01 USDC tx 0x039257c9… | mpp 0.01 USDC tx 0x8f1f1483… | x402 0.01 USDC tx 0x3bd85f24…
✔ payee saw a signed, governed agent: Signature-Agent http://127.0.0.1:4402, key PT_2-y7luc7q…
✔ gateway refuses to fetch private addresses: 403 outbound blocked: host 169.254.169.254 is private or link-local
✔ stolen credential is useless without the holder key: 401 holder signature required: unknown key UmThAL6YDXVtdKhH2H7bqCYdty8TTr6y66B_Di0D7Jc
✔ rate_limit caveat stops the 4th payment in 10m: denied: CAVEAT:rate_limit:cred_29835898591300f084b98d85:04812aab6a257aed
✔ escalation returns 202: report costs 0.04 > 0.03 threshold → approval apr_75f6c74bae97c96ef97439db pending (RULE_ESCALATE:escalate-above-3c)
✔ CFO signs the approval: approver cfo (0x15d34AAf…), signature 0xea7890d441…
✔ resume settles under the approval: x402 0.04 USDC tx 0x9a31821f…
✔ rejected approval cannot be resumed: approval apr_374d086b72ffcbeb2843b6c8 is rejected
✔ standard x402 payload via ERC-1271: account pre-approved the EIP-3009 digest (tx 0xaccdba1b…), facilitator settled with transferWithAuthorization (tx 0xb63acb19…): works with any x402 facilitator
✔ orphaned pre-approval reclaimed after expiry: 30 s window; charge +0.001 at approval; reclaim inside the window → 0 (pending 1); chain clock +45 s → 1 reclaimed (tx 0xc8bb3feb…), session spent back to 0.08
✔ subscription opened with its first charge: fixed 0.01 USDC every 1s, max 3 charges; payee holds charge token for subscriptions/sub_179f290ff157d0cdd8145bb3/charges
✔ subscription visibility follows the credential chain: child sees 0, opener sees 1, admin sees 1; child cancel -> 404
✔ payee charges on cadence; agent cancels: too early → 429 (next 08:15:27); on time → settled 0.01 tx 0x50f1889e…; after cancel → 410 subscription is cancelled
✔ metered stream: 30 tokens × 0.0001 → settled 0.003 USDC; 60 tokens (0.006) → 403 charge exceeds amountPerCharge
✔ L402 over Lightning: 10 sats at 1600 sats/USDC = 0.00625 USDC against policy; preimage dcedbe4e4638… matches invoice hash 1479e8c28e4a…
✔ daily budget period: every rail and subscription charge counts against the same daily cap; next: daily from 2026-10-11T00:00:00.000Z: spent 139350 + 10000 vs cap 140000
✔ lineage spend on-chain: gateway root spent 0.1331 = research-agent 0.1331 = payee USDC balance 0.1331 (Lightning spend is off-chain: 10 sats); fetcher 0.03
✔ policy v2 receipted with impact: diff rules ~escalate-above-3c,+deny-full-reports; impact: 1 past intent(s) now deny (RULE_DENY:deny-full-reports); simulate now cites v2 0x72014fdc…
✔ kill switch: session key pauses, owner unpauses: gateway paused on-chain (0x55071aaf…); gateway unpause → owner-required: NotOwner(…); owner unpause → paused=false
✔ five concurrent payments settle through one relayer key: x402 0.01 USDC tx 0x3528eaec… | x402 0.01 USDC tx 0x34fb3702… | x402 0.01 USDC tx 0xa0b78ad7… | x402 0.01 USDC tx 0x45ef8a3b… | x402 0.01 USDC tx 0x36e1464d…
✔ a retried request with the same Idempotency-Key pays once: first x402 0.01 USDC tx 0x4720ee05…; retry replayed=true, same settlement=true
✔ a payee that never answers times out, nothing reserved: 502 payee unreachable: timeout
✔ metrics + OpenAPI: /metrics has spendmarshal_payments_total (standard x402 settled = 1); /openapi.json is OpenAPI 3.1.0 with 29 paths
✔ evidence bundle: 94 receipts, 2 policy versions, 3 credentials, anchor #93; approvals: 1 granted, 2 signature-verified → E:\MachineNativeEconomy\evidence\phase1-2026-10-11T08-15-39-530Z.json
VERIFIED: 11/11 checks
  PASS  schema
  PASS  policy.hash  (0x72014fdc3a46a69c91e0c4f5080e8ac89bd35009932f0a58b4d21f3b06e81074 vs 0x72014fdc3a46a69c91e0c4f5080e8ac89bd35009932f0a58b4d21f3b06e81074)
  PASS  policy.versions  (2 versions)
  PASS  receipts.chain  (94 receipts)
  PASS  receipts.policyHash
  PASS  credentials.ids
  PASS  credentials.monotonic  (3 credentials)
  PASS  anchors.match  (1 anchors)
  PASS  settlements.have_allow_decision
  PASS  approvals  (1 granted, 2 signature-verified)
  PASS  anchors.onchain  (0x71e5c56c @ block 36)

balances: Alice (EOA account) 9.8069 USDC, payee 0.1331 USDC

PHASE 1 PASSED: 31/31 steps
```
