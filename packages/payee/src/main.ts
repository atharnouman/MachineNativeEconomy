import { buildPayee } from "./server.js";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
const payee = buildPayee({
  host: process.env.PAYEE_HOST ?? "127.0.0.1",
  port: Number(process.env.PAYEE_PORT ?? 4403),
  token: need("PAYEE_TOKEN") as `0x${string}`,
  chainId: Number(process.env.PAYEE_CHAIN_ID ?? 31337),
  pricing: {
    rails: ["x402", "mpp"],
    payTo: need("PAYEE_PAY_TO") as `0x${string}`,
    facilitatorUrl: process.env.PAYEE_FACILITATOR_URL ?? "http://127.0.0.1:4402",
    mpp: { rpcUrl: process.env.PAYEE_RPC_URL ?? "http://127.0.0.1:8545", relayerPrivateKey: need("PAYEE_RELAYER_PRIVATE_KEY") as `0x${string}` },
  },
});
payee.listen().then((a) => console.log(`SpendMarshal example payee listening on ${a}`));
