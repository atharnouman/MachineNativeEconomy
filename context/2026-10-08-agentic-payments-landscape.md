# Agentic payments landscape — research notes (checked 8 Oct 2026)

Purpose: ground the "Agentic Payment Gateway" prompt in what actually exists so the product targets real gaps.

## 1. Payment rails / protocols (HTTP 402 family)
| Protocol | Owner / governance | Status (Oct 2026) | Notes |
|---|---|---|---|
| x402 | Coinbase → Linux Foundation x402 Foundation (2 Apr 2026); co-governed w/ Cloudflare, Stripe | V2 live; 165M cumulative tx, ~$50M volume, 69k active agents (Apr 2026) | Facilitator API: /verify /settle /supported /discovery/resources. EVM + SVM + Stellar facilitators. USDC-centric. |
| MPP (Machine Payments Protocol) | Stripe + Tempo (Paradigm) | Launched 18 Mar 2026 with Tempo mainnet; streaming primitive added 29–30 Apr 2026; ~30k tx by Aug 2026 | Challenge/Credential/Receipt over HTTP 402. IETF draft `draft-ryan-httpauth-payment`. Subscriptions, streaming, cancellation, reconciliation. Rail-agnostic (stablecoin, card, BNPL). |
| L402 | Lightning Labs | 6 yrs production | Macaroons with caveats = reusable attenuated credentials (good prior art for delegation). |

## 2. Mandate / checkout / identity protocols
| Protocol | Owner | Status | Notes |
|---|---|---|---|
| AP2 (Agent Payments Protocol) | Google + 60+ partners (PayPal, Mastercard, Amex, Coinbase) | v0.2.0 Apr 2026; Universal Cart at I/O 2026 | Signed Mandates (Checkout, Payment; Open/Closed stages; human-present and human-not-present). Extension of A2A + MCP. Integrates with UCP. |
| UCP (Universal Commerce Protocol) | Google + Shopify | Jan 2026 | Full commerce lifecycle; powers Google Search/Gemini shopping. |
| ACP (Agentic Commerce Protocol) | OpenAI + Stripe (+Meta) | ChatGPT Instant Checkout shuttered Mar 2026; only ~a dozen Shopify merchants adopted | Protocol fine; distribution failed. |
| Visa TAP (Trusted Agent Protocol) + ICC | Visa | GitHub Oct 2025; OpenAI partnership 10 Jun 2026 | RFC 9421 HTTP Message Signatures; merchant-specific, purpose-specific, time-bound. Partners: Anthropic, OpenAI, Microsoft, Perplexity, Shopify, Stripe, Worldpay. |
| Mastercard Agent Pay | Mastercard | First live tx 29 Sep 2025; Agent Suite expansion 26 May 2026; live 10+ markets | SD-JWT credentials with spending constraints. |
| Amex ACE | Amex | Dev kit Apr 2026 | Includes purchase protection. |
| Alibaba/Ant | — | 120M agent tx in one week (Feb 2026) | Closed ecosystem. |

## 3. Agent identity / reputation
- **ERC-8004 Trustless Agents**: ratified Jan 2026, mainnet 29 Jan 2026, 45k+ registered. Three registries: Identity (ERC-721 passport, CAIP-10), Reputation, Validation.
  - arXiv 2606.26028 empirical study: only 3% (Ethereum) / 4% (BSC) / 15% (Base) of registrations have live endpoints; 60–90% of reviewers show sybil behaviour; after sybil removal 16–87% of agents have no valid rating. Reputation "not commensurable, rarely grounded in verifiable interactions, manipulable at minimal cost."
- **ERC-8183**: mainnet Jan 2026; on-chain Jobs with escrow + evaluator; completed jobs feed ERC-8004 reputation.
- **Skyfire KYA / KYAPay** (USDC settlement), **Catena Labs ACK-ID** (Circle co-founders; guardrails: limits, approved counterparties, max balances), **Nevermined ID**.

## 4. Wallets / guardrails / custody
- **Coinbase Agentic Wallets** (11 Feb 2026): MPC + x402 client + policy engine (per-token allowances, session caps, allowlists, activity log) + gasless on Base; CLI/MCP install. Agentic.Market marketplace on x402 Bazaar.
- **Cloudflare**: Pay-per-crawl (Jul 2025) → Monetization Gateway (1 Jul 2026, charge for pages/APIs/datasets/MCP tools via x402) → Wallets + cloudflare.pay handles (4 Aug 2026) with per-payment limits and merchant whitelists. AWS + Cloudflare embed x402 at edge (InfoQ Jul 2026).
- **Circle**: Agent Stack (wallets, CLI, marketplace), Nanopayments on Circle Gateway (EIP-3009 authorizations verified instantly, batched on-chain; $0.000001 min; Arc testnet). Arc L1 with USDC gas. ARC token presale $222M.
- **Amazon Bedrock AgentCore payments** built with Coinbase + Stripe.
- **Openfort** (open-source smart accounts, 4337 + 7702 session keys), **Agent Payment Node (APN)** (local-first CLI, ERC-7715 grants), **Coinbase AgentKit** (no built-in spend limits).
- **IRSB** (github jeremylongshore/irsb): EIP-7702 WalletDelegate + 5 enforcers (SpendLimit, TimeWindow, AllowedTargets, AllowedMethods, Nonce), execution receipts, dispute module with bonds (80/15/5 split). Sepolia only, BUSL-1.1, 2 stars, no audit, no framework integrations. Closest prior art to "on-chain guardrails + receipts + disputes."
- Standards: EIP-7702 (Pectra, May 2025), ERC-4337, ERC-7715 (permission requests), ERC-7710 (delegation), ERC-7683 (cross-chain intents), EIP-3009 (transferWithAuthorization), RFC 9421.

## 5. Security findings (2026)
- arXiv 2605.30998 "Free-Riding the Agentic Web": x402 weaknesses — free-riding (service without payment), replay of payment tokens, facilitator trust/single point of failure, settlement race conditions, LLM-inference-specific fraud. Mitigations: commitment schemes, better token validation, facilitator decentralisation, finality guarantees.
- arXiv 2604.11430: PII leakage in x402 metadata; pre-execution filtering.
- arXiv 2604.15367 SoK on agentic commerce security.
- Incidents (corrected 19 Oct 2026 after a source check): Grok/Bankrbot Morse-code prompt injection moved about 3B DRB on 4 May 2026, worth roughly $150–200k per the OECD.AI incident record, later recovered per Ledger: the only documented 2026 prompt-injection drain of an agent wallet. Other 2026 agent-wallet losses were trading-bot failures (Polycule about $230k, January; Lobstar Wilde about $250k nominal, February), not injection. A reported ~$500k drain through instructions injected into an LLM router (April 2026) is weakly sourced (Ledger Academy citing a news piece with no named victim). The earlier ">$45M protocol-level agent-infra losses in 2026" figure came from April 2026 marketing posts recycling a 2025 Coinbase phone-scam total and the Step Finance device compromise; no security firm publishes a 2026 total for agent or prompt-injection losses, and the sum of documented agent-wallet incidents is about $1.2M.
- Surveys: Gravitee (December 2025 survey, 900+ respondents) found 88% reporting a confirmed or suspected AI-agent security incident in the past year (59% confirmed); its April 2026 wave (750 CIOs/CTOs, UK and US) found 54% (35% confirmed). AvePoint with Osterman Research (June 2026, 750 enterprise leaders) found 88.4% reporting at least one AI-agent-related security breach in 12 months. Both are vendor surveys; neither defines "incident" or limits the base to organisations running agents.
- Consensus mitigation: policy enforced at the signing layer, independent of the model, with kill switches.

## 6. Policy / settlement research
- **APEX** (arXiv 2604.02023): declarative policies for agent API spend; single-agent; future work = multi-agent shared budgets, formal verification, auto-generated policy.
- **Agentic Settlement Protocol** (arXiv 2609.02208): hold → capture → refund, delayed fulfilment, layered on x402/MPP. Leaves open: fulfilment oracles, dispute resolution, multi-party coordination.
- **Agent-OSI** (arXiv 2602.13795): interoperability layering for agent communication + settlement.
- **Decision Evidence Maturity Model** (arXiv 2605.04093): evidence properties for agent decisions.

## 7. Regulation
- GENIUS Act (law 18 Jul 2025); OCC/FDIC/Treasury rulemakings Mar–Aug 2026; by 18 Jul 2028 only permitted issuers' stablecoins may be offered in the US. Agents have no legal personhood, so every payment must bind to a human/legal principal. KYC/AML designed for persons; "Know Your Agent" is unregulated. EU AI Act and Travel Rule applicability to machine payments unresolved.

## 8. Stated gaps ("nobody does X")
1. **No interoperability** between rails/protocols; a single transaction stacks 3–4 layers from different vendors. (dhyabi2 landscape; Applied Technology Index Jun 2026.)
2. **Merchant/acceptance side barely exists**; buyer side is built (Lex "missing half"; EPI). Need a neutral orchestrator that translates between network agentic tokens, gateway tokens, and stablecoin rails.
3. **Disputes, refunds, chargebacks, delayed fulfilment unsolved** ("payments are ready, disputes are not").
4. **Reputation is sybil-ridden**; feedback not grounded in verifiable paid interactions.
5. **No native audit/compliance evidence** in x402/L402; "the protocol is half the answer."
6. **Multi-agent / hierarchical budgets and delegation** with formal guarantees: open.
7. **Vendor lock**: policy + custody + rail bundled by Coinbase/Cloudflare/Circle; the only open guardrail project is testnet/BUSL.
8. **Agent-fraud detection**: most agent-initiated card txns would be declined; 60% of FIs have no agent-fraud plan.

## Sources
- x402: https://x402.org/ · https://www.spark.money/research/x402-protocol-ai-agent-payments · https://www.openfort.io/blog/x402-agentic-payments · https://metamask.io/news/what-is-x402
- AP2: https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol · https://thenextweb.com/news/google-universal-cart-agent-payments-shopping-io-2026 · https://codelabs.developers.google.com/next26/adk-agent-commerce
- MPP: https://thedefiant.io/news/blockchains/tempo-launches-mainnet-unveils-machine-payments-protocol-with-stripe · https://eco.com/support/en/articles/14845486-stripe-machine-payments-protocol-mpp
- ERC-8004: https://eips.ethereum.org/EIPS/eip-8004 · https://arxiv.org/abs/2606.26028 · https://github.com/sudeepb02/awesome-erc8004 · ERC-8183: https://bex.co/blog/2026/03/10/erc-8183-agentic-commerce-ai-agent-trustless-economy
- Card networks: https://www.digitalcommerce360.com/2026/04/02/visa-mastercard-in-agentic-commerce/ · https://www.pymnts.com/news/artificial-intelligence/2026/visa-openai-unlock-agentic-commerce/
- Wallets: https://eco.com/support/en/articles/14845485-coinbase-agentic-wallets-explained · https://cryptobriefing.com/agentic-market-ai-agents-hub/ · https://aws.amazon.com/blogs/machine-learning/agents-that-transact-introducing-amazon-bedrock-agentcore-payments-built-with-coinbase-and-stripe/ · https://github.com/jeremylongshore/irsb · https://github.com/PDiTO/agent-wallet · https://github.com/nuanu-ai/agent-payment-node
- Cloudflare: https://blog.cloudflare.com/monetization-gateway/ · https://www.infoq.com/news/2026/07/cloudflare-aws-x402-micropayment/ · https://www.searchenginejournal.com/cloudflare-gives-ai-agents-wallets-that-pay-for-what-they-access/584959/
- Circle: https://www.circle.com/nanopayments · https://www.circle.com/pressroom/circle-launches-ai-infrastructure-to-power-the-agentic-economy · https://www.crowdfundinsider.com/2026/05/278131-circle-introduces-nanopayments-framework-for-agentic-ai-economies-on-arc/
- Security: https://arxiv.org/pdf/2605.30998 · https://arxiv.org/pdf/2604.11430 · https://arxiv.org/pdf/2604.15367 · https://cryptobriefing.com/virtuals-protocol-agent-wallet-prompt-injection/ · https://www.ledger.com/academy/topics/agentic-ai/agentic-ai-security-guide
- Research: https://arxiv.org/pdf/2604.02023 (APEX) · https://arxiv.org/pdf/2609.02208 (ASP) · https://arxiv.org/pdf/2602.13795 (Agent-OSI)
- Gaps: https://github.com/dhyabi2/agent-payment-protocols · https://appliedtechnologyindex.com/research/2026-comparative-analysis-agentic-commerce-payment-protocols/ · https://lex.substack.com/p/analysis-the-missing-half-of-agentic · https://www.electronicpaymentsinternational.com/comment/infrastructure-gap-agentic-commerce-disputes-not-ready/ · https://www.fenwick.com/insights/publications/is-2026-the-year-of-agentic-payments
- Regulation: https://www.federalregister.gov/documents/2026/08/18/2026-16796/genius-act-regulations-on-payment-stablecoin-issuance-offer-and-sale · https://www.airwallex.com/en-us/blog/ai-agent-payments
- Governance: https://blog.modelcontextprotocol.io/posts/2025-12-09-mcp-joins-agentic-ai-foundation/ (MCP → AAIF Dec 2025; A2A joined 20 Aug 2026)
