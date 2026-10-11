# @spendmarshal/core

Canonical types and pure functions shared by every SpendMarshal component.

- `PaymentIntent`, attenuable credentials (macaroon-style caveats that can only shrink) and `credentialId`
- the policy engine: `evaluate({ policy, intent, credential, amountBase, rail, ledger, stage })`
- signed, hash-chained receipts and the offline evidence verifier (`verifyBundle`, `verifyChain`)
- wire formats for x402 (standard and agent-account payloads), MPP challenges and credentials, L402
- RFC 9421 HTTP message signatures (Web Bot Auth, holder-bound credentials), outbound URL hygiene

```ts
import { parsePolicyYaml, evaluate } from "@spendmarshal/core";
```

No network, no storage, no keys: everything here runs anywhere, including inside an auditor's offline verifier.

Part of [SpendMarshal](https://github.com/atharnouman/MachineNativeEconomy), the open-source Agentic Payment Gateway: policy, settlement and evidence between AI agents and any payment rail. Apache-2.0. Alpha: APIs change between 0.0.x versions.
