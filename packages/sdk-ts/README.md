# @spendmarshal/sdk

TypeScript client for a SpendMarshal gateway, for agents and for operators.

```ts
import { SpendMarshalClient } from "@spendmarshal/sdk";
const agent = new SpendMarshalClient(gatewayUrl, credential, { holderKey });
const r = await agent.pay({ url: "https://data.example/v1/quote", maxAmount: "0.02", purpose: "research", idempotencyKey: "job-42" });
```

- `pay`, `simulate`, `resume`, `delegate` (sub-credentials that can only shrink), `subscribe`, `receipts`
- `SpendMarshalAdmin`: issue credentials, approvals, policy versions, evidence export, kill switch, reclaim
- `spendmarshalTools(client)` returns JSON-Schema tool definitions for OpenAI function calling, Vercel AI, LangChain and Google ADK

Part of [SpendMarshal](https://github.com/atharnouman/MachineNativeEconomy), the open-source Agentic Payment Gateway: policy, settlement and evidence between AI agents and any payment rail. Apache-2.0. Alpha: APIs change between 0.0.x versions.
