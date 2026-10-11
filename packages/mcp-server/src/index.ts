#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SpendMarshalClient } from "@spendmarshal/sdk";

/**
 * MCP server: any MCP client (Claude, ChatGPT, Gemini, Cursor, ...) gets `spendmarshal_pay`, `spendmarshal_simulate`,
 * `spendmarshal_resume`, `spendmarshal_approval`, `spendmarshal_receipts`, `spendmarshal_whoami`. The model only ever sees URLs, amounts,
 * approval ids and receipts; keys stay in the gateway.
 *
 * Env: SPENDMARSHAL_URL (gateway base URL), SPENDMARSHAL_CREDENTIAL (base64url credential for this agent).
 */
const url = process.env.SPENDMARSHAL_URL ?? "http://127.0.0.1:4402";
const credential = process.env.SPENDMARSHAL_CREDENTIAL;
if (!credential) {
  console.error("SPENDMARSHAL_CREDENTIAL is required");
  process.exit(1);
}
const client = new SpendMarshalClient(url, credential);

const server = new McpServer({ name: "spendmarshal", version: "0.0.2" });

const payShape = {
  url: z.string().url().describe("Resource URL to buy"),
  maxAmount: z.string().regex(/^\d+(\.\d+)?$/).describe("Ceiling in USDC, e.g. '0.05'"),
  purpose: z.string().describe("Why; must match a policy-allowed purpose"),
  rail: z.enum(["auto", "x402", "mpp"]).optional().describe("Payment rail; default auto"),
};

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

server.tool(
  "spendmarshal_pay",
  "Pay for an HTTP resource through the Agentic Payment Gateway under this agent's spending policy. Returns the resource body, the decision and signed receipts. If denied, do not retry with a higher amount; report the reasons. If status is 202, a human must approve: report pending.approvalId and call spendmarshal_resume once approved.",
  payShape,
  async (args) => json(await client.pay(args)),
);
server.tool("spendmarshal_simulate", "Dry-run a payment: would policy and the on-chain account allow it? Nothing is paid.", payShape, async (args) => json(await client.simulate(args)));
server.tool("spendmarshal_resume", "Continue a payment that was waiting for human approval.", { approvalId: z.string() }, async ({ approvalId }) => json(await client.resume(approvalId)));
server.tool("spendmarshal_approval", "Check the status of an approval request.", { approvalId: z.string() }, async ({ approvalId }) => json(await client.approval(approvalId)));
server.tool("spendmarshal_receipts", "List signed receipts (decisions, settlements, denials, approvals) for this principal.", {}, async () => json(await client.receipts()));
server.tool("spendmarshal_whoami", "Show this agent's credential (public view) and its on-chain session.", {}, async () => json(await client.whoami()));

const transport = new StdioServerTransport();
await server.connect(transport);
