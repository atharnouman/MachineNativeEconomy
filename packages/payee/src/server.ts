import Fastify, { type FastifyInstance } from "fastify";
import { paid, type PaidConfig } from "./middleware.js";

/**
 * Example payee: a tiny market-data API. Two priced resources, one free index.
 *   GET /v1/quote?symbol=ETH   -> 0.01 USDC
 *   GET /v1/report?symbol=ETH  -> 0.04 USDC (used by the demo to trigger a sub-agent per-tx denial)
 */
export function buildPayee(opts: { host: string; port: number; pricing: Omit<PaidConfig, "price" | "description">; token: `0x${string}`; chainId: number }) {
  const app: FastifyInstance = Fastify({ logger: false });
  const settled: Array<{ rail: string; txHash: string; payer: string; amount: string; resource: string }> = [];
  const base = { ...opts.pricing, onSettled: (i: (typeof settled)[number]) => settled.push(i) };

  app.get("/", async () => ({ name: "apgw example payee", resources: ["/v1/quote?symbol=ETH (0.01 USDC)", "/v1/report?symbol=ETH (0.04 USDC)"], rails: opts.pricing.rails }));

  app.get(
    "/v1/quote",
    { preHandler: paid({ ...base, price: { amount: "10000", token: opts.token, chainId: opts.chainId }, description: "Spot quote" }) },
    async (req) => {
      const symbol = String((req.query as { symbol?: string }).symbol ?? "ETH").toUpperCase();
      return { symbol, price: fakePrice(symbol), currency: "USD", asOf: new Date().toISOString() };
    },
  );

  app.get(
    "/v1/report",
    { preHandler: paid({ ...base, price: { amount: "40000", token: opts.token, chainId: opts.chainId }, description: "Full research report" }) },
    async (req) => {
      const symbol = String((req.query as { symbol?: string }).symbol ?? "ETH").toUpperCase();
      return { symbol, summary: `${symbol} 30-day report`, pages: 12, asOf: new Date().toISOString() };
    },
  );

  return {
    app,
    settled,
    listen: () => app.listen({ host: opts.host, port: opts.port }),
    close: () => app.close(),
  };
}

function fakePrice(symbol: string): number {
  let h = 0;
  for (const ch of symbol) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return Math.round((1000 + (h % 4000)) * 100) / 100;
}
