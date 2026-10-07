# Positioning: how the gateway is useful where others are not (8 Oct 2026)

**Thesis:** be the neutral control plane no rail owner can be; win on policy, receipts, disputes, and reputation, not on the rail.

## Why incumbents structurally cannot do this
- Coinbase, Circle, Cloudflare, Stripe/Tempo each own a rail or custody product and route to it. Equal treatment of x402, MPP, L402, AP2, card tokens hurts their business.
- They monetise custody, so bring-your-own-key (KMS/HSM/MPC) will never be their default. Enterprises want it.
- Startups ship allowlists and caps. Provable delegation, cross-rail receipts, dispute protocol: slow, unglamorous, no fee. Nobody ships them.

## Five unique-value positions
1. **IAM + Cost Explorer for agent money** — org budget tree, shrink-only sub-agent credentials, simulate-before-spend, kill switch.
2. **Accept side** — any API/MCP server accepts any agent over any rail in one config block. Cloudflare's version is Cloudflare-only and x402-only.
3. **Receipt as unit of truth** — portable, offline-verifiable receipt (mandate → policy decision → settlement → fulfilment → dispute). Owns reconciliation, accounting, audit, compliance.
4. **Disputes without liability** — open contracts for hold/capture/refund/bonded challenge/pluggable arbiters; gateway never holds funds or risk.
5. **True reputation** — feedback only against settled receipts. Only possible from the settlement path. This is the data moat.

## Avoid
Wallet, facilitator, chain, consumer checkout (OpenAI ACP checkout shut Mar 2026). One chain or one stablecoin.

## Sequencing
Thin end-to-end slice first: one agent, one budget, one payee, paid over x402 AND MPP, with a policy denial and an auditor-ready receipt bundle. Distribute as MCP server + framework adapters. Depth in policy, disputes, reputation after payments already flow through it.
