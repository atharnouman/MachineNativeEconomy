# Phase 1 transcript

Recorded 2026-10-11T07:32:08Z on Windows 11, Node v20.17.0, anvil 1.8.5 (prague), SQLite store, mock Lightning, with `pnpm demo:phase1` from a clean `data/`. Exit code 0.

```text
anvil up on :8545 (~\.foundry\bin\anvil.exe, prague)
✔ EIP-7702 delegation: EOA 0x90F79bf6EB2c4f870365E785982E1f101E93b906 now runs AgentAccount code (tx 0xe4120b21…), owner is itself, balance unchanged at 10 USDC
✔ initialize is self-only: a stranger calling initialize on Alice's account reverted: NotSelf(…)
✔ gateway is a bounded operator: owner granted gateway 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 a root session: cap 3, perTx 0.5, payee allowlist
✔ services: gateway http://127.0.0.1:4402 (store: sqlite), payee http://127.0.0.1:4403, policy v1 0x66250b3e…
✔ payee requires Web Bot Auth: anonymous GET → 401 Accept-Signature: sig1=("@authority" "signature-agent");tag="web-bot-auth"; gateway key PT_2-y7luc7q… published in a signed directory
✔ credential chain mirrors on-chain: research-agent session 0xE6a8F615… has parent = gateway root session; fetcher is its child
✔ sub-agent pays over both rails: x402 0.01 USDC tx 0xd17c01e7… | mpp 0.01 USDC tx 0x984ac107… | x402 0.01 USDC tx 0x42b351a0…
✔ payee saw a signed, governed agent: Signature-Agent http://127.0.0.1:4402, key PT_2-y7luc7q…
✔ gateway refuses to fetch private addresses: 403 outbound blocked: host 169.254.169.254 is private or link-local
✔ stolen credential is useless without the holder key: 401 holder signature required: unknown key FwjLrODpi-JkqDqtXiTiYBPcpsxZt2vtRGdnS2K6MoQ
✔ rate_limit caveat stops the 4th payment in 10m: denied: CAVEAT:rate_limit:cred_562ba18ab1b8ca1d2b89f7b9:62ab94d47124640c
✔ escalation returns 202: report costs 0.04 > 0.03 threshold → approval apr_e34455f75fae3aca4c43854e pending (RULE_ESCALATE:escalate-above-3c)
✔ CFO signs the approval: approver cfo (0x15d34AAf…), signature 0xc4b4448513…
✔ resume settles under the approval: x402 0.04 USDC tx 0x60f2c32a…
✔ rejected approval cannot be resumed: approval apr_24847de4bbefe7049ca1e288 is rejected
✔ standard x402 payload via ERC-1271: account pre-approved the EIP-3009 digest (tx 0x875ba777…), facilitator settled with transferWithAuthorization (tx 0x167e5b7b…): works with any x402 facilitator
✔ orphaned pre-approval reclaimed after expiry: 30 s window; charge +0.001 at approval; reclaim inside the window → 0 (pending 1); chain clock +45 s → 1 reclaimed (tx 0x03dbf874…), session spent back to 0.08
✔ subscription opened with its first charge: fixed 0.01 USDC every 1s, max 3 charges; payee holds charge token for subscriptions/sub_f0e443de9f74d3b6c4d45d2d/charges
✔ subscription visibility follows the credential chain: child sees 0, opener sees 1, admin sees 1; child cancel -> 404
✔ payee charges on cadence; agent cancels: too early → 429 (next 07:31:08); on time → settled 0.01 tx 0x45f85f83…; after cancel → 410 subscription is cancelled
✔ metered stream: 30 tokens × 0.0001 → settled 0.003 USDC; 60 tokens (0.006) → 403 charge exceeds amountPerCharge
✔ L402 over Lightning: 10 sats at 1600 sats/USDC = 0.00625 USDC against policy; preimage 10a189d8d0f5… matches invoice hash 970b3471d567…
✔ daily budget period: every rail and subscription charge counts against the same daily cap; next: daily from 2026-10-11T00:00:00.000Z: spent 139350 + 10000 vs cap 140000
✔ lineage spend on-chain: gateway root spent 0.1331 = research-agent 0.1331 = payee USDC balance 0.1331 (Lightning spend is off-chain: 10 sats); fetcher 0.03
✔ policy v2 receipted with impact: diff rules ~escalate-above-3c,+deny-full-reports; impact: 1 past intent(s) now deny (RULE_DENY:deny-full-reports); simulate now cites v2 0x1c79c3f4…
✔ kill switch: session key pauses, owner unpauses: gateway paused on-chain (0x41776cde…); gateway unpause → owner-required: NotOwner(…); owner unpause → paused=false
✔ metrics + OpenAPI: /metrics has spendmarshal_payments_total (standard x402 settled = 1); /openapi.json is OpenAPI 3.1.0 with 29 paths
✔ evidence bundle: 72 receipts, 2 policy versions, 2 credentials, anchor #71; approvals: 1 granted, 2 signature-verified → E:\MachineNativeEconomy\evidence\phase1-2026-10-11T07-31-18-473Z.json
VERIFIED: 11/11 checks
  PASS  schema
  PASS  policy.hash  (0x1c79c3f47c2fd9be53cd32e7032486cc10e5421558bc9166012db17496e9304c vs 0x1c79c3f47c2fd9be53cd32e7032486cc10e5421558bc9166012db17496e9304c)
  PASS  policy.versions  (2 versions)
  PASS  receipts.chain  (72 receipts)
  PASS  receipts.policyHash
  PASS  credentials.ids
  PASS  credentials.monotonic  (2 credentials)
  PASS  anchors.match  (1 anchors)
  PASS  settlements.have_allow_decision
  PASS  approvals  (1 granted, 2 signature-verified)
  PASS  anchors.onchain  (0xd80db736 @ block 31)

balances: Alice (EOA account) 9.8669 USDC, payee 0.1331 USDC

PHASE 1 PASSED: 28/28 steps
```
