import type { FastifyReply, FastifyRequest } from "fastify";
import { createPublicClient, createWalletClient, http, nonceManager, type Address, type Hex } from "viem";
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
  encodeL402ChallengeHeader,
  decodeL402AuthorizationHeader,
  mintL402Macaroon,
  verifyL402Macaroon,
  preimageMatches,
  verifyAgentAccountPayload,
  settleAgentAccountPayload,
  chainFor,
  randomId,
  nowIso,
  verifyMessage,
  publicKeyFromJwk,
  checkOutboundUrl,
  NonceWindow,
  DIRECTORY_PATH,
  WEB_BOT_AUTH_TAG,
  type X402Required,
  type Rail,
  type Ed25519Jwk,
  type SubscriptionOffer,
  type LightningNode,
} from "@spendmarshal/core";
import type { SubscriptionBook } from "./subscriptions.js";

/**
 * The accept side in one configuration block. Attach `paid(config)` as a Fastify preHandler and the route
 * is now sold to any agent over x402 (via a facilitator), MPP (settled here, no facilitator) and/or L402
 * (Lightning; the preimage is the proof).
 *
 *   app.get("/v1/quote", { preHandler: paid({ ... }) }, handler)
 *
 * With `agentAuth`, the payee also verifies the caller as a Web Bot Auth agent. With `subscription`, the
 * resource can be subscribed to: the first MPP payment opens it and the payee bills later through the book.
 */
export interface PaidConfig {
  rails: Rail[];
  price: {
    amount: string; // base units (reference asset)
    token: Address;
    chainId: number;
    symbol?: string;
    /** The token's EIP-712 domain, advertised in x402 `extra` so standard clients can sign EIP-3009 payloads. */
    eip712?: { name: string; version: string };
  };
  payTo: Address;
  description?: string;
  /** x402: where to verify/settle. */
  facilitatorUrl?: string;
  /** MPP: the payee settles directly, so it needs an RPC and a relayer key (pays gas, never holds funds). */
  mpp?: { rpcUrl: string; relayerPrivateKey: Hex };
  /** L402: a Lightning node to mint invoices, a secret for macaroons, and the price in sats. */
  l402?: { node: LightningNode; macaroonSecret: string; amountSats: bigint };
  maxTimeoutSeconds?: number;
  /** Web Bot Auth verification of the calling agent. */
  agentAuth?: {
    /** Refuse (401 + Accept-Signature) requests without a valid agent signature. */
    require: boolean;
    /**
     * Only these Signature-Agent origins are accepted. Strongly recommended: without it, any public https origin
     * that serves a directory is trusted (private, loopback and link-local origins are refused regardless unless
     * `allowPrivateAgents` is set, so a caller cannot turn the payee into a proxy into its own network).
     */
    allowedAgents?: string[];
    allowPrivateAgents?: boolean;
    /** Seconds to cache a fetched directory. Default 300. */
    cacheSeconds?: number;
  };
  /** Advertise a subscription on this resource (MPP). Requires `subscriptions`. */
  subscription?: SubscriptionOffer;
  subscriptions?: SubscriptionBook;
  onSettled?: (info: SettledInfo) => void;
}

export interface SettledInfo {
  rail: Rail;
  txHash: Hex;
  payer: Address | "lightning";
  /** Amount in `unit`: token base units for x402/MPP, satoshis for L402. */
  amount: string;
  unit: "base" | "sat";
  resource: string;
  agent?: AgentIdentity;
  subscriptionId?: string;
}

export interface AgentIdentity {
  signatureAgent: string;
  keyid: string;
}

type AgentRequest = FastifyRequest & { agent?: AgentIdentity };

export function paid(cfg: PaidConfig) {
  const network = `eip155:${cfg.price.chainId}`;
  const timeout = cfg.maxTimeoutSeconds ?? 120;
  const challenges = new Map<string, number>(); // MPP challenge id -> expiry (replay guard; pruned)
  const directories = new Map<string, { keys: Ed25519Jwk[]; fetchedAt: number }>();
  const nonces = new NonceWindow();
  const usedPreimages = new NonceWindow();
  const pruneChallenges = () => {
    if (challenges.size < 1000) return;
    const now = Date.now();
    for (const [id, exp] of challenges) if (exp < now) challenges.delete(id);
  };

  const pub = cfg.mpp ? createPublicClient({ chain: chainFor(cfg.price.chainId, cfg.mpp.rpcUrl), transport: http(cfg.mpp.rpcUrl), pollingInterval: 500 }) : null;
  const wallet = cfg.mpp
    ? createWalletClient({ chain: chainFor(cfg.price.chainId, cfg.mpp.rpcUrl), transport: http(cfg.mpp.rpcUrl), pollingInterval: 500, account: privateKeyToAccount(cfg.mpp.relayerPrivateKey, { nonceManager }) })
    : null;

  const resourceUrl = (req: FastifyRequest) => `${req.protocol}://${req.headers.host}${req.url}`;

  const x402Requirements = (req: FastifyRequest): X402Required => ({
    x402Version: 2,
    resource: { url: resourceUrl(req), description: cfg.description },
    accepts: [
      {
        scheme: "exact",
        network,
        amount: cfg.price.amount,
        asset: cfg.price.token,
        payTo: cfg.payTo,
        maxTimeoutSeconds: timeout,
        ...(cfg.price.eip712 ? { extra: { name: cfg.price.eip712.name, version: cfg.price.eip712.version } } : {}),
      },
    ],
  });

  const challenge402 = async (req: FastifyRequest, reply: FastifyReply, error?: string) => {
    if (cfg.rails.includes("x402")) reply.header(X402_HEADERS.required, encodeX402({ ...x402Requirements(req), error }));
    const wwwAuth: string[] = [];
    if (cfg.rails.includes("mpp")) {
      pruneChallenges();
      const id = randomId("ch");
      const expiresAt = new Date(Date.now() + timeout * 1000);
      challenges.set(id, expiresAt.getTime());
      wwwAuth.push(
        encodeMppChallengeHeader({
          id,
          realm: req.headers.host ?? "payee",
          expiresAt: expiresAt.toISOString(),
          description: cfg.description,
          methods: [{ method: "evm-agent-account", chain: network, token: cfg.price.token, amount: cfg.price.amount, payTo: cfg.payTo, ...(cfg.subscription ? { subscription: cfg.subscription } : {}) }],
        }),
      );
    }
    if (cfg.rails.includes("l402") && cfg.l402) {
      const inv = await cfg.l402.node.createInvoice({ amountSats: cfg.l402.amountSats, description: cfg.description, ttlSeconds: timeout });
      wwwAuth.push(encodeL402ChallengeHeader(mintL402Macaroon(cfg.l402.macaroonSecret, inv.paymentHash, timeout), inv.bolt11));
    }
    if (wwwAuth.length) reply.header(MPP_HEADERS.challenge, wwwAuth.length === 1 ? wwwAuth[0]! : wwwAuth);
    return reply.code(402).send({ error: error ?? "Payment Required", rails: cfg.rails, price: { amount: cfg.price.amount, token: cfg.price.token, chain: network, ...(cfg.l402 ? { sats: cfg.l402.amountSats.toString() } : {}) } });
  };

  /** Resolve an agent's key from its Signature-Agent directory (cached). Never fetches a private/loopback origin unless allowed. */
  const resolveAgentKey = async (keyid: string, signatureAgent?: string) => {
    if (!signatureAgent) return undefined;
    if (cfg.agentAuth?.allowedAgents && !cfg.agentAuth.allowedAgents.includes(signatureAgent)) return undefined;
    const safe = checkOutboundUrl(signatureAgent, { allowPrivate: cfg.agentAuth?.allowPrivateAgents || (cfg.agentAuth?.allowedAgents?.includes(signatureAgent) ?? false) });
    if (!safe.ok || safe.url.pathname !== "/" || safe.url.search) return undefined; // an origin, nothing more
    const ttl = (cfg.agentAuth?.cacheSeconds ?? 300) * 1000;
    let dir = directories.get(signatureAgent);
    if (!dir || Date.now() - dir.fetchedAt > ttl) {
      try {
        const r = await fetch(`${signatureAgent.replace(/\/$/, "")}${DIRECTORY_PATH}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
        if (!r.ok) return undefined;
        const body = (await r.json()) as { keys?: Ed25519Jwk[] };
        dir = { keys: body.keys ?? [], fetchedAt: Date.now() };
        directories.set(signatureAgent, dir);
      } catch {
        return undefined;
      }
    }
    const jwk = dir.keys.find((k) => k.kid === keyid);
    return jwk ? publicKeyFromJwk(jwk) : undefined;
  };

  const verifyAgent = async (req: FastifyRequest): Promise<{ ok: true; agent: AgentIdentity } | { ok: false; reason: string }> => {
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v])) as Record<string, string | undefined>;
    const res = await verifyMessage(
      { method: req.method, url: resourceUrl(req), headers },
      {
        resolveKey: resolveAgentKey,
        requireTag: WEB_BOT_AUTH_TAG,
        requireComponents: ["@authority", "signature-agent"],
        nonceSeen: (n, k) => nonces.seenBefore(n, k),
      },
    );
    if (!res.ok) return res;
    return { ok: true, agent: { signatureAgent: String(headers["signature-agent"] ?? "").replace(/^"|"$/g, ""), keyid: res.keyid } };
  };

  return async function preHandler(req: FastifyRequest, reply: FastifyReply) {
    // ── agent identity (Web Bot Auth) ──
    if (cfg.agentAuth) {
      const v = await verifyAgent(req);
      if (v.ok) (req as AgentRequest).agent = v.agent;
      else if (cfg.agentAuth.require) {
        reply.header("accept-signature", 'sig1=("@authority" "signature-agent");tag="web-bot-auth"');
        return reply.code(401).send({ error: `agent signature required: ${v.reason}` });
      }
    }
    const agent = (req as AgentRequest).agent;

    // ── x402 path: client sent PAYMENT-SIGNATURE, we verify+settle through the facilitator ──
    const xs = req.headers[X402_HEADERS.signature];
    if (typeof xs === "string" && cfg.rails.includes("x402")) {
      if (!cfg.facilitatorUrl) return challenge402(req, reply, "x402 facilitator not configured");
      const payment = decodeX402(X402SignatureSchema, xs);
      if (!payment) return challenge402(req, reply, "malformed PAYMENT-SIGNATURE");
      const requirements = x402Requirements(req).accepts[0]!;
      // x402 convention: the facilitator URL is the base, endpoints are /verify, /settle, /supported
      const facilitator = cfg.facilitatorUrl.replace(/\/$/, "");
      const verify = await postJson(`${facilitator}/verify`, { x402Version: 2, paymentPayload: payment, paymentRequirements: requirements });
      if (!verify.isValid) return challenge402(req, reply, `invalid payment: ${verify.invalidReason ?? verify.error ?? "facilitator refused"}`);
      const settle = await postJson(`${facilitator}/settle`, { x402Version: 2, paymentPayload: payment, paymentRequirements: requirements });
      if (!settle.success) return challenge402(req, reply, `settlement failed: ${settle.errorReason ?? settle.error ?? "facilitator refused"}`);
      reply.header(X402_HEADERS.response, encodeX402({ success: true, transaction: settle.transaction, network, payer: settle.payer }));
      cfg.onSettled?.({ rail: "x402", txHash: settle.transaction as Hex, payer: settle.payer as Address, amount: cfg.price.amount, unit: "base", resource: req.url, agent });
      return; // fall through to the route handler
    }

    const authHeader = req.headers[MPP_HEADERS.credential];

    // ── L402 path: Authorization: L402 <macaroon>:<preimage> ──
    const l402 = typeof authHeader === "string" ? decodeL402AuthorizationHeader(authHeader) : null;
    if (l402 && cfg.rails.includes("l402") && cfg.l402) {
      const mac = verifyL402Macaroon(cfg.l402.macaroonSecret, l402.macaroon);
      if (!mac.ok) return challenge402(req, reply, `invalid L402 token: ${mac.reason}`);
      if (!preimageMatches(l402.preimage, mac.paymentHash)) return challenge402(req, reply, "preimage does not match the invoice");
      if (usedPreimages.seenBefore(l402.preimage, "l402")) return challenge402(req, reply, "preimage already used");
      cfg.onSettled?.({ rail: "l402", txHash: `0x${mac.paymentHash}` as Hex, payer: "lightning", amount: cfg.l402.amountSats.toString(), unit: "sat", resource: req.url, agent });
      return;
    }

    // ── MPP path: client sent Authorization: Payment, we verify and settle ourselves ──
    const mppCred = typeof authHeader === "string" ? decodeMppCredentialHeader(authHeader) : null;
    if (mppCred && cfg.rails.includes("mpp")) {
      if (!pub || !wallet) return challenge402(req, reply, "MPP settlement not configured");
      const exp = challenges.get(mppCred.challengeId);
      if (!exp || exp < Date.now()) return challenge402(req, reply, "unknown or expired challenge");
      challenges.delete(mppCred.challengeId); // single use
      if (mppCred.subscription && !(cfg.subscription && cfg.subscriptions)) return challenge402(req, reply, "this resource does not accept subscriptions");
      const v = await verifyAgentAccountPayload(pub, mppCred.payload, { chainId: cfg.price.chainId, token: cfg.price.token, payTo: cfg.payTo, minAmount: BigInt(cfg.price.amount) });
      if (!v.ok) return challenge402(req, reply, `invalid payment: ${v.reason}`);
      const s = await settleAgentAccountPayload(wallet, pub, mppCred.payload);
      if (!s.ok) return challenge402(req, reply, `settlement failed: ${s.reason}`);
      let payeeSubscriptionId: string | undefined;
      if (mppCred.subscription && cfg.subscriptions) {
        const entry = cfg.subscriptions.register({ agentSubscriptionId: mppCred.subscription.id, resource: req.url, chargeUrl: mppCred.subscription.chargeUrl, token: mppCred.subscription.token, terms: mppCred.subscription.terms, agent });
        payeeSubscriptionId = entry.id;
      }
      reply.header(MPP_HEADERS.receipt, encodeMppReceipt({ challengeId: mppCred.challengeId, chain: network, txHash: s.txHash, amount: cfg.price.amount, payer: mppCred.payload.account, settledAt: nowIso(), ...(payeeSubscriptionId ? { subscriptionId: payeeSubscriptionId } : {}) }));
      cfg.onSettled?.({ rail: "mpp", txHash: s.txHash, payer: mppCred.payload.account as Address, amount: cfg.price.amount, unit: "base", resource: req.url, agent, subscriptionId: payeeSubscriptionId });
      return;
    }

    // ── no payment: challenge on every configured rail at once ──
    return challenge402(req, reply);
  };
}

/** A facilitator call. Any HTTP error or non-JSON body becomes `{ error }` so the caller answers 402 with the reason, never 500. */
async function postJson(url: string, body: unknown): Promise<Record<string, string | boolean | undefined>> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const text = await r.text();
    try {
      const json = JSON.parse(text) as Record<string, string | boolean | undefined>;
      return r.ok ? json : { error: `facilitator ${r.status}: ${json.error ?? json.invalidReason ?? json.errorReason ?? text.slice(0, 200)}` };
    } catch {
      return { error: `facilitator ${r.status}: ${text.slice(0, 200)}` };
    }
  } catch (err) {
    return { error: `facilitator unreachable: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  }
}
