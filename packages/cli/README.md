# @spendmarshal/cli

Operator command line: `spendmarshal export-evidence`, `spendmarshal verify <bundle.json>` (offline, no network), `spendmarshal policy lint <policy.yaml>`, `spendmarshal audit-logs <spend-logs.json>` (offline diagnostic over a LiteLLM spend-log export).

```bash
npx @spendmarshal/cli verify evidence.json
```

The verifier re-checks every receipt signature (against the gateway key in force at its position), the hash chain and its gateway key history, policy versions and activation times, credential monotonicity, approvals and anchors from the bundle alone. `--gateway-key ADDRESS` (repeatable) pins the gateway keys you trust: every key that signed the chain must be one of them, or linked to one by handovers. Without it, a key change that the previous key did not hand over fails. `--rpc URL` also checks each anchor on-chain under the address that sent it.

`spendmarshal audit-logs spend-logs.json [--budgets keys.json] [--prices model_prices.json] [--format text|html|json]` reads a LiteLLM spend-log export (`/spend/logs/v2` pages or a plain array) and prints a one-page exceptions report: repeated requests, retry storms, failed and empty spend, expensive models on small outputs, and caps against real use, each with its source rows and a label that says what the data supports. Offline, metadata only; prompts and responses are never printed. See [docs/AUDIT_LOGS.md](../../docs/AUDIT_LOGS.md).

Part of [SpendMarshal](https://github.com/atharnouman/MachineNativeEconomy), the open-source Agentic Payment Gateway: policy, settlement and evidence between AI agents and any payment rail. Apache-2.0. Alpha: APIs change between 0.0.x versions.
