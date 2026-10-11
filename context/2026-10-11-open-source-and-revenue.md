# Open source and revenue (11 Oct 2026)

Question from the user: does open source suit this project, how do we earn on that path, and does it make the project successful? Unbiased view recorded here so later sessions do not re-argue it.

## Does open source suit it?

Yes, and it is close to mandatory. The thesis is "the neutral control plane no rail owner can be". Neutral means auditable, self-hostable and not owned by a rail, and no bank, enterprise or rail partner will route money through a closed box from a one-person company. Open source is also the only realistic adoption path for a solo founder: contributions, adapters and payees come from other people.

Keep **Apache-2.0 for the core** (policy, credentials, receipts, contracts, SDKs, payee middleware). Do not use AGPL (cuts enterprise adoption), and never BSL or SSPL for the core (source-available, not open source; HashiCorp, Redis and Elastic each lost trust and forks when they switched). Protect the **name**, not the code: anyone may fork the code, nobody may use the brand. That is why the naming and trademark step matters.

## How money is made on this path

Ranked by how early and how large, from what has worked for open infrastructure (Kong, HashiCorp, Temporal, Supabase, Envoy and Istio vendors) and from this product's own shape:

1. **Hosted gateway.** Run it for organisations that do not want to self-host: managed relayers with gas, key custody with HSM, upgrades, SLAs. Pricing by settled volume and by principals or agents. This is the main business.
2. **Enterprise pack (open core).** SSO, audit exports (accounting CSV, ISO 20022-shaped), compliance reports from evidence bundles, multi-region, Postgres HA, HSM signer reference. Sold to the finance and compliance buyer, who is not the developer who adopted the core.
3. **Design partners and support.** The first revenue, within months: two to five companies paying for a managed deployment, an integration and a support contract. Not scalable, but it funds the next six months and shapes the roadmap.
4. **Ecosystem grants.** x402 ecosystem and Base ecosystem programmes, Ethereum and Optimism public-goods funding, Gitcoin rounds. Realistic early money for open payments infrastructure; apply as soon as the testnet run is public.
5. **Dispute and arbiter marketplace (v1.0).** Listing fees and a share of bonded challenges. Only once payments flow.
6. **Receipt-grounded reputation (v1.0).** A trust index computed only from settled receipts, sold as an API to payees and platforms, privacy-preserving aggregates only. This is the data moat; it is only possible from the settlement path.

Not recommended: a take rate baked into the open-source gateway (kills neutrality and adoption), or becoming a wallet, facilitator or chain.

## Does it make the project successful?

Open source wins adoption; it does not pay by itself. The usual shape for open infrastructure is twelve to twenty-four months to meaningful revenue, with the first money from design partners and the scale money from the hosted service. Success is receipts flowing through other people's deployments; revenue follows that number.

Two honest risks. The timing risk is larger than the monetisation risk: this only works if agent payments reach real volume in the next one to two years. And the big players (Coinbase, Stripe, Cloudflare, the card networks) can each bundle a policy layer for their own rail; the answer is to be the layer that spans all of them, with the best receipts and evidence.

## Personal suggestion

- Go open source now, Apache-2.0 core, trademark the name, open core plus hosted service as the business.
- Spend the next two months on the testnet run, the scalability fixes and the launch; apply for ecosystem grants the same week the launch post goes out.
- Get two paying design partners before building more features; let their needs choose between the enterprise pack and the marketplace.
- Keep a non-crypto exit open: the policy, credential and receipt layer is rail-agnostic. A **virtual-card rail** (card issuing APIs) would put the same control plane over ordinary company spending by agents, the market finance teams already understand. If crypto rails stall, that is the pivot, and it costs one adapter, not a rewrite.
- Decide the company question only when the first partner wants a contract: a company around the hosted service, with the core staying open and, if rail owners ever want to co-govern, a foundation for the core.
