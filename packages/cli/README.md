# @spendmarshal/cli

Operator command line: `spendmarshal export-evidence`, `spendmarshal verify <bundle.json>` (offline, no network), `spendmarshal policy lint <policy.yaml>`.

```bash
npx @spendmarshal/cli verify evidence.json
```

The verifier re-checks every receipt signature, the hash chain, policy versions and activation times, credential monotonicity, approvals and anchors from the bundle alone.

Part of [SpendMarshal](https://github.com/atharnouman/MachineNativeEconomy), the open-source Agentic Payment Gateway: policy, settlement and evidence between AI agents and any payment rail. Apache-2.0. Alpha: APIs change between 0.0.x versions.
