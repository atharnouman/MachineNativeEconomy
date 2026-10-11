import Fastify, { type FastifyInstance } from "fastify";
import type { LightningNode } from "@spendmarshal/core";
import { paid, type PaidConfig, type SettledInfo } from "./middleware.js";
import { SubscriptionBook } from "./subscriptions.js";

/**
 * Example payee: a tiny market-data API.
 *   GET /v1/quote?symbol=ETH      -> 0.01 USDC per call (x402 + MPP)
 *   GET /v1/report?symbol=ETH     -> 0.04 USDC per call (x402 + MPP)
 *   GET /v1/feed                  -> 0.01 USDC per cycle, subscribable (fixed, every `feedInterval`, max 3)
 *   GET /v1/stream                -> metered stream: 0.0001 USDC per token, up to 0.005 per cycle
 *   GET /v1/lightning-quote       -> 10 sats over L402 (when a Lightning node is configured)
 */
export function buildPayee(opts: {
  host: string;
  port: number;
  pricing: Omit<PaidConfig, "price" | "description" | "subscription" | "subscriptions" | "l402">;
  token: `0x${string}`;
  chainId: number;
  eip712?: { name: string; version: string };
  lightning?: { node: LightningNode; macaroonSecret: string };
  feedInterval?: string;
}) {
  const app: FastifyInstance = Fastify({ logger: false });
  const settled: SettledInfo[] = [];
  const subscriptions = new SubscriptionBook();
  const base = { ...opts.pricing, onSettled: (i: SettledInfo) => settled.push(i), subscriptions };
  const priceOf = (amount: string) => ({ amount, token: opts.token, chainId: opts.chainId, ...(opts.eip712 ? { eip712: opts.eip712 } : {}) });
  const interval = opts.feedInterval ?? "1s";

  app.get("/", async () => ({
    name: "SpendMarshal example payee",
    resources: ["/v1/quote?symbol=ETH (0.01 USDC)", "/v1/report?symbol=ETH (0.04 USDC)", "/v1/feed (subscription 0.01/cycle)", "/v1/stream (metered 0.0001/token)", ...(opts.lightning ? ["/v1/lightning-quote (10 sats, L402)"] : [])],
    rails: opts.pricing.rails,
  }));

  app.get("/v1/quote", { preHandler: paid({ ...base, price: priceOf("10000"), description: "Spot quote" }) }, async (req) => {
    const symbol = String((req.query as { symbol?: string }).symbol ?? "ETH").toUpperCase();
    return { symbol, price: fakePrice(symbol), currency: "USD", asOf: new Date().toISOString() };
  });

  app.get("/v1/report", { preHandler: paid({ ...base, price: priceOf("40000"), description: "Full research report" }) }, async (req) => {
    const symbol = String((req.query as { symbol?: string }).symbol ?? "ETH").toUpperCase();
    return { symbol, summary: `${symbol} 30-day report`, pages: 12, asOf: new Date().toISOString() };
  });

  app.get(
    "/v1/feed",
    { preHandler: paid({ ...base, rails: ["mpp"], price: priceOf("10000"), description: "Market feed subscription", subscription: { kind: "fixed", amountPerCharge: "10000", interval, maxCharges: 3, description: "0.01 USDC per cycle" } }) },
    async () => ({ feed: "market", items: [{ symbol: "ETH", price: fakePrice("ETH") }, { symbol: "BTC", price: fakePrice("BTC") }], asOf: new Date().toISOString() }),
  );

  app.get(
    "/v1/stream",
    { preHandler: paid({ ...base, rails: ["mpp"], price: priceOf("100"), description: "Metered token stream", subscription: { kind: "metered", amountPerCharge: "5000", interval, unit: "token", unitPrice: "100", description: "0.0001 USDC per token, max 0.005 per cycle" } }) },
    async () => ({ stream: "open", unit: "token", unitPrice: "100", asOf: new Date().toISOString() }),
  );

  if (opts.lightning) {
    app.get(
      "/v1/lightning-quote",
      { preHandler: paid({ ...base, rails: ["l402"], price: priceOf("0"), description: "Spot quote over Lightning", l402: { node: opts.lightning.node, macaroonSecret: opts.lightning.macaroonSecret, amountSats: 10n } }) },
      async () => ({ symbol: "BTC", price: fakePrice("BTC"), currency: "USD", rail: "l402", asOf: new Date().toISOString() }),
    );
  }

  return {
    app,
    settled,
    subscriptions,
    listen: () => app.listen({ host: opts.host, port: opts.port }),
    close: () => app.close(),
  };
}

function fakePrice(symbol: string): number {
  let h = 0;
  for (const ch of symbol) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return Math.round((1000 + (h % 4000)) * 100) / 100;
}
