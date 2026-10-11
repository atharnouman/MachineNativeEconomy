# @spendmarshal/gateway

The gateway service: one HTTP server an organisation runs between its agents and the payment rails.

- credentials for agents (bounded delegation, holder binding), policy evaluation on every intent
- settlement over x402, MPP and L402 with on-chain caps enforced by the `AgentAccount` contract
- approvals (202 + signed resolutions), subscriptions and metered streams, kill switch
- signed receipt chain per principal, evidence export, on-chain anchoring, Prometheus metrics, OpenAPI
- store drivers: JSON (dev) and SQLite (self-hosted default)

```ts
import { buildGateway, configFromEnv } from "@spendmarshal/gateway";
const gw = await buildGateway(configFromEnv(process.env));
await gw.listen();
```

Configuration is documented in the repository's `.env.example`; the demos in `examples/` show every flow end to end.

Part of [SpendMarshal](https://github.com/atharnouman/MachineNativeEconomy), the open-source Agentic Payment Gateway: policy, settlement and evidence between AI agents and any payment rail. Apache-2.0. Alpha: APIs change between 0.0.x versions.
