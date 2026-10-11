import type { FastifyInstance } from "fastify";
import type { Address } from "viem";
import { z } from "zod";
import {
  X402SignatureSchema,
  X402AcceptSchema,
  isAgentAccountPayload,
  verifyAgentAccountPayload,
  settleAgentAccountPayload,
  verifyStandardPayload,
  settleStandardPayload,
} from "@spendmarshal/core";
import type { GatewayConfig } from "./config.js";
import type { ChainClient } from "./chain.js";

/**
 * A minimal x402 V2 facilitator (verify / settle / supported). Runs inside the gateway for local development so
 * the demo needs no third party. It accepts both payload shapes:
 *   - standard EIP-3009 payloads (EOA signatures or ERC-1271 accounts), exactly as public facilitators do
 *   - the `agent-account` payload settled through `AgentAccount.payWithAuthorization`
 * Design principle 4 still holds: the gateway never *trusts* a facilitator; it confirms every settlement on-chain.
 */
export function registerFacilitator(app: FastifyInstance, cfg: GatewayConfig, chain: ChainClient) {
  const network = `eip155:${cfg.chainId}`;
  const Body = z.object({ paymentPayload: X402SignatureSchema, paymentRequirements: X402AcceptSchema });

  app.get("/facilitator/supported", async () => ({
    kinds: [
      { x402Version: 2, scheme: "exact", network, payloads: ["eip3009", "agent-account"] },
    ],
  }));

  app.post("/facilitator/verify", async (req, reply) => {
    const b = Body.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ isValid: false, invalidReason: "bad request" });
    const { paymentPayload: p, paymentRequirements: r } = b.data;
    if (p.network !== network || r.network !== network) return { isValid: false, invalidReason: "unsupported network" };
    const requirements = { chainId: cfg.chainId, token: r.asset as Address, payTo: r.payTo as Address, minAmount: BigInt(r.amount) };
    if (isAgentAccountPayload(p.payload)) {
      const v = await verifyAgentAccountPayload(chain.pub, p.payload, requirements);
      return v.ok ? { isValid: true, payer: p.payload.account } : { isValid: false, invalidReason: v.reason, payer: p.payload.account };
    }
    const v = await verifyStandardPayload(chain.pub, p.payload, requirements);
    return v.ok ? { isValid: true, payer: v.payer } : { isValid: false, invalidReason: v.reason, payer: p.payload.authorization.from };
  });

  app.post("/facilitator/settle", async (req, reply) => {
    const b = Body.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ success: false, errorReason: "bad request", network });
    const { paymentPayload: p, paymentRequirements: r } = b.data;
    const requirements = { chainId: cfg.chainId, token: r.asset as Address, payTo: r.payTo as Address, minAmount: BigInt(r.amount) };
    if (isAgentAccountPayload(p.payload)) {
      const v = await verifyAgentAccountPayload(chain.pub, p.payload, requirements);
      if (!v.ok) return { success: false, errorReason: v.reason, network, payer: p.payload.account };
      const s = await settleAgentAccountPayload(chain.wallet, chain.pub, p.payload);
      return s.ok ? { success: true, transaction: s.txHash, network, payer: p.payload.account } : { success: false, errorReason: s.reason, network, payer: p.payload.account };
    }
    const v = await verifyStandardPayload(chain.pub, p.payload, requirements);
    if (!v.ok) return { success: false, errorReason: v.reason, network, payer: p.payload.authorization.from };
    const s = await settleStandardPayload(chain.wallet, chain.pub, p.payload, requirements.token);
    return s.ok ? { success: true, transaction: s.txHash, network, payer: v.payer } : { success: false, errorReason: s.reason, network, payer: v.payer };
  });
}
