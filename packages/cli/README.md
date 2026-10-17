# @spendmarshal/cli

Operator command line: `spendmarshal export-evidence`, `spendmarshal verify <bundle.json>` (offline, no network), `spendmarshal policy lint <policy.yaml>`.

```bash
npx @spendmarshal/cli verify evidence.json
```

The verifier re-checks every receipt signature (against the gateway key in force at its position), the hash chain and its gateway key history, policy versions and activation times, credential monotonicity, approvals and anchors from the bundle alone. `--gateway-key ADDRESS` (repeatable) pins the gateway keys you trust: the chain must end with one of them, or with a key handed over from one. `--rpc URL` also checks each anchor on-chain under the address that sent it.

Part of [SpendMarshal](https://github.com/atharnouman/MachineNativeEconomy), the open-source Agentic Payment Gateway: policy, settlement and evidence between AI agents and any payment rail. Apache-2.0. Alpha: APIs change between 0.0.x versions.
