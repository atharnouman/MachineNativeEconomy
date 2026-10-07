# ADR-0001: Rail-agnostic core, adapters at the edge

**Status:** accepted (Phase 0)

## Context
x402, MPP, L402, AP2 and the card-network protocols do not interoperate. Vendors bundle one rail with custody and policy. The product thesis is neutrality.

## Decision
The gateway's only internal objects are `PaymentIntent`, `Credential`, `Decision`, `Receipt`. Rails are adapters that (a) recognise a 402 challenge, (b) turn it into a quote `{amount, token, chain, payTo, rail}`, (c) attach the signed authorization in the rail's wire format, (d) extract the settlement tx. Policy, signing, confirmation and receipts never branch on the rail.

## Consequences
* Adding a rail is one file on the pay side and one branch in the payee middleware.
* The agent's call is identical across rails (`rail: "auto" | "x402" | "mpp"` is a preference, not a code path).
* Rails whose settlement is not an EVM tx (Lightning, card tokens) will implement `confirm` differently; the `Receipt.data.settlement` shape stays.
