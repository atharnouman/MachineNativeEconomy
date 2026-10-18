# Live run on Base Sepolia

Goal: the same flows the local demos prove, on a public chain with a public x402 facilitator and real testnet USDC, recorded as a transcript with block-explorer links. This is the last step before anyone outside this repository is asked to try the gateway.

**Status, 11 October 2026: passed, 12 of 12 steps.** Both payments were settled by the public x402 facilitator from an EIP-7702 delegated account: [testnet-transcript.md](testnet-transcript.md). The run's evidence bundle is [testnet-evidence.json](testnet-evidence.json); after `pnpm build`, `node packages/cli/dist/index.js verify docs/testnet-evidence.json` checks it offline.

## What is already known (checked 11 Oct 2026)

| Fact | Value | How checked |
|---|---|---|
| Chain | Base Sepolia, chain id 84532, CAIP-2 `eip155:84532` | `eth_chainId` on https://sepolia.base.org |
| EIP-7702 | live since the Isthmus upgrade (Prague features, April 2025) | Base docs |
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, FiatToken v2.2 (EIP-3009 and EIP-1271 for contract payers) | `name()`, `version()` over RPC |
| Public facilitator | `https://x402.org/facilitator`: x402 v2, scheme `exact` on `eip155:84532` (also `upto` and `batch-settlement`) | `GET /supported` |
| Our payload | `x402Mode: "standard"`: the account pre-approves the EIP-3009 digest on-chain and the facilitator settles a plain `transferWithAuthorization`; verification is ERC-1271 against the account | ADR-0009, `Erc3009Interop.t.sol` |

The one thing no local test could prove was whether the public facilitator's verifier accepts an ERC-1271 signer (a contract `from`) for `transferWithAuthorization`. **Answered on 11 October 2026: it does.** The first attempts failed for two reasons on our side that looked like a refusal. The gateway sent the paid request before the pre-approval was readable at `latest`, because Base serves receipts for the block still being built. And the placeholder signature was 65 zero bytes, which the facilitator's secp256k1 parser refuses when it splits the signature for USDC's (v, r, s) `transferWithAuthorization`. Both are fixed ([ADR-0018](adr/0018-live-chain-fixes.md)), and the recorded run settled both payments through https://x402.org/facilitator. `SPENDMARSHAL_TESTNET_FACILITATOR=bundled` still selects the gateway's own facilitator.

## Keys and funding (the user's part)

Two fresh keys, generated for these runs only, never used elsewhere, stored under `local/` (git-ignored) and passed by path:

- `local/testnet-owner.key`: the agent's EOA. Needs Base Sepolia ETH for gas (the 7702 delegation and the on-chain pre-approvals are paid by the account itself, the facilitator pays the transfer) and testnet USDC from the Circle faucet (https://faucet.circle.com, network Base Sepolia).
- `local/testnet-gateway.key`: the gateway's operator. Needs Base Sepolia ETH only: it deploys the contracts once and funds a fresh session key for every run, which is the gateway's relayer and signer for that run.

Base Sepolia ETH: the Coinbase Developer Platform faucet or the Alchemy faucet, 0.05 ETH is plenty. The runner prints both addresses and refuses to start until the operator has ETH and the owner has USDC; an owner without ETH gets a quarter of the operator's.

## The runner (`examples/testnet`)

`pnpm demo:testnet` with `SPENDMARSHAL_TESTNET_OWNER_KEY_FILE` and `SPENDMARSHAL_TESTNET_GATEWAY_KEY_FILE` pointing at the two files (defaults: `local/testnet-owner.key` and `local/testnet-gateway.key`). `SPENDMARSHAL_TESTNET_FACILITATOR` picks the facilitator: the public one by default, `bundled` for the gateway's own.

1. Deploys `AgentAccount` implementation, the three enforcers and `ReceiptRegistry` from the operator key (once; the addresses, the payee's treasury address and the gateway's secrets are cached in `local/testnet-deploy.json`). A cached registry from before per-chain anchors ([ADR-0021](adr/0021-anchors-per-receipt-chain.md)) cannot take a new anchor, so the runner replaces it once from the operator and updates the cache; bundles anchored in the old one still verify against it.
2. Delegates the owner EOA to `AgentAccount` with one type-4 transaction; the USDC stays where it is.
3. Generates this run's session key in memory, and the owner grants it a root session: cap 0.10 USDC, per-tx 0.05, payee allowlist, 24 h. The operator funds it with gas; what is left goes back to the operator when the run ends.
4. Starts the gateway (`x402Mode: "standard"`, SQLite store under `local/testnet-data`) and the example payee on loopback with the chosen facilitator.
5. Issues a research-agent credential and pays for `/v1/quote` (0.01 USDC); checks the USDC transfer on-chain; a second payment above the policy threshold escalates and is approved with a signed resolution; a third is denied by the budget.
6. Anchors the receipt chain in `ReceiptRegistry`, exports the evidence bundle to `local/`, and verifies it offline. The console output, with a Basescan link for every transaction, is the transcript: [testnet-transcript.md](testnet-transcript.md).
7. Last, on whatever gas the session key has left, reclaims pre-approvals that an earlier failed run left charged once their 15-minute windows have closed; open ones wait for a later run. The session key's remaining ETH then goes back to the operator.

What the public chain taught the runner:

- Base's public RPC hands out receipts for transactions in the block still being built (Flashblocks preconfirmations), one block ahead of what `eth_call` at `latest` reads. Every write in the gateway, the facilitator and the devnet helpers therefore waits until its block is the latest ([ADR-0018](adr/0018-live-chain-fixes.md)); the runner still polls the balances it expects to change.
- The public facilitator splits a 65-byte signature into (v, r, s) and refuses r = 0, so a pre-approved payload carries a well-formed placeholder. It also fails to send now and then, so the payee retries a failed settlement once; the EIP-3009 nonce makes that safe.
- The store persists across runs, but each run uses its own principal (`org-acme-<UTC minute>`). The budget and the receipt chain therefore belong to that run alone, and its evidence bundle verifies against the approver key that run generated. Balances and the root session's spend are checked as the run's own deltas. This is how the run found that the ledger shared budget spend, and the evidence export shared anchors, between principals; both are fixed in ADR-0018. Chains written before the evidence key were signed by earlier runs' session keys. When the reclaim step writes into one, the runner declares the keys that signed its own chain heads, so that chain records one `gateway.key.rotated` receipt without a handover (the earlier session key is gone), and its bundle verifies with both keys pinned ([ADR-0022](adr/0022-key-history-review-fixes.md)).
- A session key is single-use on-chain: once granted it can be revoked, but never re-granted or widened. The runner therefore generates a fresh session key for every run instead of reusing the gateway key, so `local/testnet-gateway.key` never needs replacing. Receipts are signed by a separate evidence key, generated once and kept with the runner's secrets in `local/testnet-deploy.json`, so a new session key never changes a receipt chain ([ADR-0023](adr/0023-separate-evidence-key.md)).

What is not in the run: MPP (no public MPP payee exists to pay yet), Lightning (mock only), subscriptions (needs a public payee). Those stay on the local demos.

## Cost

Gas on Base Sepolia is free testnet ETH: a run costs the operator about 0.000007 ETH and the owner about 0.000001 ETH at 0.006 gwei. Each run moves 0.05 test USDC to the payee's treasury address, whose key was never kept. Nothing of value is at risk. Session keys live only in memory, and the two key files are discarded once the transcripts are recorded.
