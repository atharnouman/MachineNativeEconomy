# Live run on Base Sepolia (plan)

Goal: the same flows the local demos prove, on a public chain with a public x402 facilitator and real testnet USDC, recorded as a transcript with block-explorer links. This is the last step before anyone outside this repository is asked to try the gateway.

## What is already known (checked 11 Oct 2026)

| Fact | Value | How checked |
|---|---|---|
| Chain | Base Sepolia, chain id 84532, CAIP-2 `eip155:84532` | `eth_chainId` on https://sepolia.base.org |
| EIP-7702 | live since the Isthmus upgrade (Prague features, April 2025) | Base docs |
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, FiatToken v2.2 (EIP-3009 and EIP-1271 for contract payers) | `name()`, `version()` over RPC |
| Public facilitator | `https://x402.org/facilitator`: x402 v2, scheme `exact` on `eip155:84532` (also `upto` and `batch-settlement`) | `GET /supported` |
| Our payload | `x402Mode: "standard"`: the account pre-approves the EIP-3009 digest on-chain and the facilitator settles a plain `transferWithAuthorization`; verification is ERC-1271 against the account | ADR-0009, `Erc3009Interop.t.sol` |

The one thing no local test can prove is whether the public facilitator's verifier accepts an ERC-1271 signer (a contract `from`) for `transferWithAuthorization`. If it does not, the fallback is the gateway's bundled facilitator on the same chain, which already does; the run then still proves 7702, on-chain caps and anchoring on a public chain.

## Keys and funding (the user's part)

Two fresh keys, generated for this run only, never used elsewhere, stored under `local/` (git-ignored) and passed by path:

- `local/testnet-owner.key`: the agent's EOA. Needs Base Sepolia ETH for gas (the 7702 delegation and the on-chain pre-approvals are paid by the account itself, the facilitator pays the transfer) and testnet USDC from the Circle faucet (https://faucet.circle.com, network Base Sepolia).
- `local/testnet-gateway.key`: the gateway's relayer and signer. Needs Base Sepolia ETH only (it deploys the contracts, grants sessions and relays pre-approvals).

Base Sepolia ETH: the Coinbase Developer Platform faucet or the Alchemy faucet, 0.05 ETH is plenty. The runner prints both addresses and refuses to start until both balances are non-zero.

## The runner (`examples/testnet`)

`pnpm demo:testnet` with `SPENDMARSHAL_TESTNET_OWNER_KEY_FILE` and `SPENDMARSHAL_TESTNET_GATEWAY_KEY_FILE` pointing at the two files:

1. Deploys `AgentAccount` implementation, the three enforcers and `ReceiptRegistry` from the gateway key (once; addresses cached in `local/testnet-deploy.json`).
2. Delegates the owner EOA to `AgentAccount` with one type-4 transaction; the USDC stays where it is.
3. The owner grants the gateway a root session: cap 0.10 USDC, per-tx 0.02, payee allowlist, 24 h.
4. Starts the gateway (`x402Mode: "standard"`, SQLite store under `local/testnet-data`) and the example payee on loopback with `facilitatorUrl: https://x402.org/facilitator`.
5. Issues a research-agent credential, pays for `/v1/quote` (0.01 USDC) through the public facilitator; checks the USDC transfer on-chain; a second payment above the policy threshold escalates and is approved with a signed resolution; a third is denied by the cap.
6. Anchors the receipt chain in `ReceiptRegistry`, exports the evidence bundle, verifies it offline, and writes `docs/testnet-transcript.md` with Basescan links for every transaction.

What is not in the run: MPP (no public MPP payee exists to pay yet), Lightning (mock only), subscriptions (needs a public payee). Those stay on the local demos.

## Cost

Gas on Base Sepolia is free testnet ETH; the USDC moved is 0.03 test USDC. Nothing of value is at risk, and the keys are discarded after the transcript is recorded.
