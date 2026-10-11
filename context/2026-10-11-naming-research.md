# Product naming research (11 Oct 2026)

Why: `apgw` is a placeholder. The user asked for name candidates that are safe on trademark and existing-name grounds and that work end to end (npm scope, CLI command, GitHub org, domains, a future company or foundation name).

## Method

- Availability signals checked by HTTP, unauthenticated: npm registry (`registry.npmjs.org/<name>`), PyPI (`pypi.org/pypi/<name>/json`), GitHub user or org (`api.github.com/users/<name>`), GitHub repositories named exactly (`search/repositories?q=<name>+in:name`), `.com` via rdap.org / Verisign RDAP, `.dev` via Google Registry RDAP, `.io` via DNS only (NXDOMAIN = probably unregistered; weak signal).
- Existing companies and marks: web searches for each finalist. This is not a clearance search. Before filing or publishing under a name, run a formal search at USPTO (tmsearch.uspto.gov), EUIPO eSearch and WIPO Global Brand Database in classes 9 (software), 36 (financial services) and 42 (SaaS).
- Names are protected by trademark, not copyright. Copyright does not cover names or short phrases.

## Results

| Name | npm | PyPI | GitHub user | GitHub repos | .com | .dev | .io | Found in the wild |
|---|---|---|---|---|---|---|---|---|
| payreeve | free | free | free | 0 | **free** | free | free | nothing; nearest is PayReel (US payroll company, 1995), one letter apart |
| spendmarshal | free | free | free | 0 | **free** | free | free | nothing |
| tollreeve | free | free | free | 0 | **free** | free | free | nothing; "toll reeve" is the medieval officer who collected tolls |
| paymarshal | free | free | free | 0 | taken | free | free | nothing |
| chitline | free | free | free | 0 | taken | free | ? | nothing |
| paylatch | free | free | taken | 1 | taken | free | registered | nothing; PAYLAX (German escrow) is close in sound |
| tollrail | free | free | free | ? | taken | free | free | "Toll Rail" was a New Zealand railway brand (Toll Group, 2004); Toll Group holds TOLL marks in logistics |
| agentbursar | free | free | free | ? | taken | free | free | nothing; descriptive, "agent" prefix is crowded in AI |
| payfence | free | **taken** | free | 3 | taken | free | registered | **PayFence, "API monetization middleware" SDK on PyPI since Feb 2026, payfence.io. Same space. Avoid.** |
| spendfence | free | free | free | ? | taken | taken | free | nothing; "fence" also means a receiver of stolen goods |
| apgw | free | taken | taken | 57 | taken | free | ? | acronym; weak as a mark, crowded on GitHub |
| bridle, reeve, reins, cordon, sluice, penstock, leash, quaestor, quittance, countersign, procura, delega, counterfoil | mostly taken | taken | taken | many | taken | taken | ? | dictionary or Latin words; crowded, hard to own |

Avoided on sight: anything with Ledger (hardware wallet mark in the same field), Harness (Harness.io), Turnstile (Cloudflare), Tether, Mandatum (Finnish financial group), Obol and Tessera (crypto and semiconductor marks), Greenlight, Settle, Vault or Wallet words (the gateway never holds funds), "-gate" suffixes (scandal connotation), "Agent Pay" (Mastercard's product name).

## Ranking for end-to-end success

1. **PayReeve** (recommended). A reeve was the steward who ran an estate's accounts on the owner's behalf and the officer who collected tolls; "shire-reeve" became "sheriff", so the word also carries enforcement. That is the product: a steward that governs agent spending. Coined, pronounceable, every handle free including the `.com`. Risk to clear: PayReel (payroll services) is one letter away; a formal search must show PAYREEL is not registered in classes 9/36/42, or the examiner may cite it.
2. **SpendMarshal**. Clear meaning (marshals agent spend), every handle free including `.com`, nothing found anywhere. Longer, more descriptive, so a weaker mark than a coined word, and "marshal" invites the "marshall" misspelling.
3. **PayMarshal**. Same meaning, shorter; `.com` is registered by someone else.
4. **TollReeve**. Historically exact (the 402 "payment required" toll), fully ownable, but obscure and "toll" reads as "fees".
5. **ChitLine**. A chit is a receipt or IOU; on theme, ownable, but opaque outside South Asia and the UK.

Not recommended: PayFence (taken in the same space), PayLatch (GitHub handle taken, PAYLAX nearby), TollRail (Toll Group), apgw (unownable acronym).

## When a name is chosen (same day)

1. Register `<name>.com` and `<name>.dev`, the npm organisation, the GitHub organisation, the PyPI name, and the social handles.
2. Formal clearance search (USPTO, EUIPO, WIPO) in classes 9, 36, 42; if clear, file an intent-to-use application in the home market and use the TM mark from the first publication.
3. Rename packages (`@<name>/core` …), the CLI command, the env prefix (`APGW_*`), the OpenAPI title and the docs. One mechanical pass; do it before any npm publish.
4. Keep `apgw` as a redirect name in the README for a release or two.

## Clearance searches (11 Oct 2026, built-in browser, public databases)

Validated each search with a control term ("paypal" returns 43 US marks; EUIPO results only run from the page's own search box, hash URLs do not re-run the query).

| Term | USPTO (contains word) | EUIPO basic | WIPO Global Brand Database (contains) |
|---|---|---|---|
| payreeve | 0 | 0 | 0 |
| payreel | 0 (PayReel the payroll company holds no US mark) | 0 | not run |
| reeve | 42, including **REEVE, Cardano Foundation, LIVE REGISTERED, classes 9, 35, 36, 42**, serial 79421885 | not run (WIPO covers it) | 94, including the Cardano Foundation's Swiss registration 820696 (26 Sep 2024), US registration 8105820 (20 Jan 2026) and International Registration 1850327 (15 Jan 2025) designating the USA, the EU, the UK, China and most of Europe, classes 9, 35, 36, 42 |
| spendmarshal | 0 | 0 | 0 |
| paymarshal | 0 | not run | not run |
| marshal | 180, mostly dead or unrelated (tires, tobacco, pesticides); live class-9 marks are Nidec (motor starters and motor-control software) and no live payments mark | 161 (fuzzy includes "marshall": Marshall Amplification, Marshalls paving; Trustwave's MARSHAL, WEBMARSHAL, MAILMARSHAL class-9 security software, IR 2006) | not run |
| spendsheriff / spendsteward | 0 / 0; "sheriff" alone has 309 marks including a pending AI SHERIFF | not run | not run |

UK IPO's own search sat behind a bot check, which I did not bypass; the UK is covered by the WIPO database and by the Cardano IR's UK designation.

**Verdict.** PayReeve is blocked: "Reeve" is a live registered mark of the Cardano Foundation for blockchain software and financial services in the same classes, in the US, the EU, the UK and China, and PAYREEVE contains that mark entirely. TollReeve falls with it. **SpendMarshal is clear**: no mark anywhere contains it, the shared element "marshal" is a common word with no live payments mark, no company uses the name (web, Companies House), and every handle is free: npm, PyPI, crates.io, Docker Hub, GitHub, YouTube, X and LinkedIn slugs, and spendmarshal.com, .dev, .app, .net, .ai, .co, .io. PayMarshal is the fallback (.com taken). SpendSheriff is fully free but "sheriff" is a crowded element with a pending AI SHERIFF mark.

Brand conventions: product "SpendMarshal", handles and packages `spendmarshal`, packages `@spendmarshal/*`, CLI `spendmarshal`, environment prefix `SPENDMARSHAL_`.

## Registered (11 Oct 2026)

The user bought spendmarshal.com ($10.46/year) and spendmarshal.dev ($8.20 first year, $12.20 after) at Cloudflare Registrar under the personal account. RDAP at Verisign, Google Registry and Cloudflare confirms: registrar Cloudflare, registered 11 Oct 2026, expiry 11 Oct 2027, registrant DATA REDACTED, Cloudflare nameservers; the dashboard shows auto-renew scheduled for 11 Sep 2027 on both. Organization field left blank (no legal entity yet). Private operational notes live in `local/HANDOVER.md`.
