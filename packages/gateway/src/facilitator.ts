import type { FastifyInstance } from "fastify";
import type { Address } from "viem";
import { z } from "zod";
import { X402SignatureSchema, X402AcceptSchema, verifyAgentAccountPayload, settleAgentAccountPayload } from "@apgw/core";
import type { GatewayConfig } from "./config.js";
import type { ChainClient } from "./chain.js";

/**
 * A minimal x402 V2 facilitator (verify / settle / supported). Runs inside the gateway for local development
 * so the demo needs no third party. Design principle 4: the gateway never *trusts* a facilitator, it confirms
 * every settlement on-chain itself, so swapping this for Coinbase's or Stellar's facilitator changes nothing.
 */
export function registerFacilitator(app: FastifyInstance, cfg: GatewayConfig, chain: ChainClient) {
  const network = `eip155:${cfg.chainId}`;
  const Body = z.object({ paymentPayload: X402SignatureSchema, paymentRequirements: X402AcceptSchema });

  app.get("/facilitator/supported", async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network }] }));

  app.post("/facilitator/verify", async (req, reply) => {
    const b = Body.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ isValid: false, invalidReason: "bad request" });
    const { paymentPayload: p, paymentRequirements: r } = b.data;
    if (p.network !== network || r.network !== network) return { isValid: false, invalidReason: "unsupported network" };
    if (p.payload.kind !== "agent-account") return { isValid: false, invalidReason: "only agent-account payloads in this facilitator" };
    const v = await verifyAgentAccountPayload(chain.pub, p.payload, { chainId: cfg.chainId, token: r.asset as Address, payTo: r.payTo as Address, minAmount: BigInt(r.amount) });
    return v.ok ? { isValid: true, payer: p.payload.account } : { isValid: false, invalidReason: v.reason, payer: p.payload.account };
  });

  app.post("/facilitator/settle", async (req, reply) => {
    const b = Body.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ success: false, errorReason: "bad request", network });
    const { paymentPayload: p, paymentRequirements: r } = b.data;
    if (p.payload.kind !== "agent-account") return { success: false, errorReason: "unsupported payload", network };
    const v = await verifyAgentAccountPayload(chain.pub, p.payload, { chainId: cfg.chainId, token: r.asset as Address, payTo: r.payTo as Address, minAmount: BigInt(r.amount) });
    if (!v.ok) return { success: false, errorReason: v.reason, network, payer: p.payload.account };
    const s = await settleAgentAccountPayload(chain.wallet, chain.pub, p.payload);
    return s.ok ? { success: true, transaction: s.txHash, network, payer: p.payload.account } : { success: false, errorReason: s.reason, network, payer: p.payload.account };
  });
}
