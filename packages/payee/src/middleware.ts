import type { FastifyReply, FastifyRequest } from "fastify";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  X402_HEADERS,
  MPP_HEADERS,
  X402SignatureSchema,
  encodeX402,
  decodeX402,
  encodeMppChallengeHeader,
  decodeMppCredentialHeader,
  encodeMppReceipt,
  verifyAgentAccountPayload,
  settleAgentAccountPayload,
  chainFor,
  randomId,
  nowIso,
  type X402Required,
  type Rail,
} from "@apgw/core";

/**
 * The accept side in one configuration block. Attach `paid(config)` as a Fastify preHandler and the route
 * is now sold to any agent over x402 (via a facilitator) and/or MPP (settled here, no facilitator).
 *
 *   app.get("/v1/quote", { preHandler: paid({ ... }) }, handler)
 */
export interface PaidConfig {
  rails: Rail[];
  price: { amount: string; token: Address; chainId: number; symbol?: string }; // amount in base units
  payTo: Address;
  description?: string;
  /** x402: where to verify/settle. */
  facilitatorUrl?: string;
  /** MPP: the payee settles directly, so it needs an RPC and a relayer key (pays gas, never holds funds). */
  mpp?: { rpcUrl: string; relayerPrivateKey: Hex };
  maxTimeoutSeconds?: number;
  onSettled?: (info: { rail: Rail; txHash: Hex; payer: Address; amount: string; resource: string }) => void;
}

export function paid(cfg: PaidConfig) {
  const network = `eip155:${cfg.price.chainId}`;
  const timeout = cfg.maxTimeoutSeconds ?? 120;
  const challenges = new Map<string, number>(); // MPP challenge id -> expiry (replay guard)

  const pub = cfg.mpp ? createPublicClient({ chain: chainFor(cfg.price.chainId, cfg.mpp.rpcUrl), transport: http(cfg.mpp.rpcUrl) }) : null;
  const wallet = cfg.mpp
    ? createWalletClient({ chain: chainFor(cfg.price.chainId, cfg.mpp.rpcUrl), transport: http(cfg.mpp.rpcUrl), account: privateKeyToAccount(cfg.mpp.relayerPrivateKey) })
    : null;

  const resourceUrl = (req: FastifyRequest) => `${req.protocol}://${req.headers.host}${req.url}`;

  const x402Requirements = (req: FastifyRequest): X402Required => ({
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network,
        amount: cfg.price.amount,
        asset: cfg.price.token,
        payTo: cfg.payTo,
        maxTimeoutSeconds: timeout,
        resource: { url: resourceUrl(req), description: cfg.description },
      },
    ],
  });

  const challenge402 = (req: FastifyRequest, reply: FastifyReply, error?: string) => {
    if (cfg.rails.includes("x402")) reply.header(X402_HEADERS.required, encodeX402({ ...x402Requirements(req), error }));
    if (cfg.rails.includes("mpp")) {
      const id = randomId("ch");
      const expiresAt = new Date(Date.now() + timeout * 1000);
      challenges.set(id, expiresAt.getTime());
      reply.header(
        MPP_HEADERS.challenge,
        encodeMppChallengeHeader({
          id,
          realm: req.headers.host ?? "payee",
          expiresAt: expiresAt.toISOString(),
          description: cfg.description,
          methods: [{ method: "evm-agent-account", chain: network, token: cfg.price.token, amount: cfg.price.amount, payTo: cfg.payTo }],
        }),
      );
    }
    return reply.code(402).send({ error: error ?? "Payment Required", rails: cfg.rails, price: { amount: cfg.price.amount, token: cfg.price.token, chain: network } });
  };

  return async function preHandler(req: FastifyRequest, reply: FastifyReply) {
    // ── x402 path: client sent PAYMENT-SIGNATURE, we verify+settle through the facilitator ──
    const xs = req.headers[X402_HEADERS.signature];
    if (typeof xs === "string" && cfg.rails.includes("x402")) {
      if (!cfg.facilitatorUrl) return challenge402(req, reply, "x402 facilitator not configured");
      const payment = decodeX402(X402SignatureSchema, xs);
      if (!payment) return challenge402(req, reply, "malformed PAYMENT-SIGNATURE");
      const requirements = x402Requirements(req).accepts[0]!;
      const verify = await postJson(`${cfg.facilitatorUrl}/facilitator/verify`, { paymentPayload: payment, paymentRequirements: requirements });
      if (!verify.isValid) return challenge402(req, reply, `invalid payment: ${verify.invalidReason}`);
      const settle = await postJson(`${cfg.facilitatorUrl}/facilitator/settle`, { paymentPayload: payment, paymentRequirements: requirements });
      if (!settle.success) return challenge402(req, reply, `settlement failed: ${settle.errorReason}`);
      reply.header(X402_HEADERS.response, encodeX402({ success: true, transaction: settle.transaction, network, payer: settle.payer }));
      cfg.onSettled?.({ rail: "x402", txHash: settle.transaction as Hex, payer: settle.payer as Address, amount: cfg.price.amount, resource: req.url });
      return; // fall through to the route handler
    }

    // ── MPP path: client sent Authorization: Payment, we verify and settle ourselves ──
    const auth = req.headers[MPP_HEADERS.credential];
    const mppCred = typeof auth === "string" ? decodeMppCredentialHeader(auth) : null;
    if (mppCred && cfg.rails.includes("mpp")) {
      if (!pub || !wallet) return challenge402(req, reply, "MPP settlement not configured");
      const exp = challenges.get(mppCred.challengeId);
      if (!exp || exp < Date.now()) return challenge402(req, reply, "unknown or expired challenge");
      challenges.delete(mppCred.challengeId); // single use
      const v = await verifyAgentAccountPayload(pub, mppCred.payload, { chainId: cfg.price.chainId, token: cfg.price.token, payTo: cfg.payTo, minAmount: BigInt(cfg.price.amount) });
      if (!v.ok) return challenge402(req, reply, `invalid payment: ${v.reason}`);
      const s = await settleAgentAccountPayload(wallet, pub, mppCred.payload);
      if (!s.ok) return challenge402(req, reply, `settlement failed: ${s.reason}`);
      reply.header(MPP_HEADERS.receipt, encodeMppReceipt({ challengeId: mppCred.challengeId, chain: network, txHash: s.txHash, amount: cfg.price.amount, payer: mppCred.payload.account, settledAt: nowIso() }));
      cfg.onSettled?.({ rail: "mpp", txHash: s.txHash, payer: mppCred.payload.account as Address, amount: cfg.price.amount, resource: req.url });
      return;
    }

    // ── no payment: challenge on every configured rail at once ──
    return challenge402(req, reply);
  };
}

async function postJson(url: string, body: unknown): Promise<Record<string, string | boolean | undefined>> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return (await r.json()) as Record<string, string | boolean | undefined>;
}
