# @spendmarshal/mcp-server

Model Context Protocol server exposing a SpendMarshal gateway to any MCP client (Claude, ChatGPT, Gemini, Cursor, ...).

Tools: `spendmarshal_pay`, `spendmarshal_simulate`, `spendmarshal_resume`, `spendmarshal_approval`, `spendmarshal_receipts`, `spendmarshal_whoami`.

Environment: `SPENDMARSHAL_URL` (gateway base URL) and `SPENDMARSHAL_CREDENTIAL` (the agent's credential). The model never holds a key: every call goes through the gateway's policy and leaves a signed receipt.

Part of [SpendMarshal](https://github.com/atharnouman/MachineNativeEconomy), the open-source Agentic Payment Gateway: policy, settlement and evidence between AI agents and any payment rail. Apache-2.0. Alpha: APIs change between 0.0.x versions.
