# Thin slice transcript

Recorded 2026-10-11T07:32:08Z on Windows 11, Node v20.17.0, anvil 1.8.5, with `pnpm demo` from a clean `data/`. Exit code 0.

```text
anvil up on :8545 (~\.foundry\bin\anvil.exe)
✔ deploy: AgentAccount 0x5fc8d32690cc91d4c39d9d3abcbd16989f875707 funded with 10.00 USDC on anvil chain 31337
✔ services: gateway http://127.0.0.1:4402 (signer 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266), payee http://127.0.0.1:4403 (treasury 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC)
✔ credentials: research-agent cap 1.00/0.30 → fetcher cap 0.10/0.02; on-chain session 0xc591bC78C479CE8894C022a970D729142dfAB023 perTxMax=0.02
✔ delegation is monotonic: sub-sub-agent appended per_tx_max=0.50 but its on-chain session still has perTxMax=0.02
✔ pay via x402: x402 settled 0.01 USDC in tx 0x2dd05726… → {"symbol":"ETH","price":1985,"currency":"USD","asOf":"2026-10-11T07:31:33.726Z"}
✔ pay via MPP: mpp settled 0.01 USDC in tx 0xe43d3576… → {"symbol":"ETH","price":1985,"currency":"USD","asOf":"2026-10-11T07:31:37.815Z"}
✔ pay via auto: x402 settled 0.01 USDC in tx 0x9234b69e… → {"symbol":"ETH","price":1985,"currency":"USD","asOf":"2026-10-11T07:31:38.409Z"}
✔ simulate reports both denials: policy: CAVEAT:per_tx_max | account.simulate: PerTxLimitExceeded(40000,20000)
✔ gateway denies over-limit: denied: CAVEAT:per_tx_max (nothing signed, nothing sent)
✔ parent agent allowed same purchase: mpp settled 0.04 USDC in tx 0xf8f27d1e… → {"symbol":"ETH","summary":"ETH 30-day report","pages":12,"asOf":"2026-10-11T07:31:42.547Z"}
✔ chain denies with stolen key: payWithAuthorization reverted: PerTxLimitExceeded(40000, 20000)
✔ kill switch: gateway: KILL_SWITCH; account.paused=true (tx 0xb5ef2dcc…)
✔ anchor: receipt head 0x7d59c20c… (#26) anchored in tx 0xe7a88c43… block 18
✔ evidence bundle: 27 receipts, 3 credentials, 1 anchor → E:\MachineNativeEconomy\evidence\thin-slice-2026-10-11T07-31-43-679Z.json
VERIFIED: 11/11 checks
  PASS  schema
  PASS  policy.hash  (0xdee0c5c06cccbad55b873eff60e0e1da6ca4a491d6dde6ff2b819fee16fc155b vs 0xdee0c5c06cccbad55b873eff60e0e1da6ca4a491d6dde6ff2b819fee16fc155b)
  PASS  policy.versions  (1 versions)
  PASS  receipts.chain  (27 receipts)
  PASS  receipts.policyHash
  PASS  credentials.ids
  PASS  credentials.monotonic  (3 credentials)
  PASS  anchors.match  (1 anchors)
  PASS  settlements.have_allow_decision
  PASS  approvals  (0 granted, 0 signature-verified)
  PASS  anchors.onchain  (0x7d59c20c @ block 18)

balances: AgentAccount 9.93 USDC, payee 0.07 USDC
ledger:   {"research":"0.07","org":"0.07"} by budget; 2 credential nodes charged

THIN SLICE PASSED: 14/14 steps
```
