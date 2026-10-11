# @spendmarshal/payee

Accept paying agents on any API with one middleware call.

```ts
import { paid } from "@spendmarshal/payee";
app.get("/v1/quote", { preHandler: paid({ rails: ["x402", "mpp"], price, payTo, facilitatorUrl, agentAuth: { require: true, allowedAgents: [gatewayUrl] } }) }, handler);
```

- answers anonymous callers with 402 and a quote over every configured rail (x402, MPP, L402)
- verifies the payment, settles it (bundled facilitator or your own relayer) and tells your handler who paid
- verifies the calling agent's Web Bot Auth signature and can refuse unsigned bots
- subscriptions: register a payer and charge it later under the agent's policy

Fastify is the reference host; the `paid()` logic is framework-neutral.

Part of [SpendMarshal](https://github.com/atharnouman/MachineNativeEconomy), the open-source Agentic Payment Gateway: policy, settlement and evidence between AI agents and any payment rail. Apache-2.0. Alpha: APIs change between 0.0.x versions.
