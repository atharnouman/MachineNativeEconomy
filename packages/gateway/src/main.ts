import { readFileSync } from "node:fs";
import { buildGateway } from "./server.js";
import { configFromEnv } from "./config.js";
import { receiptKeyOf } from "./signer.js";

// Standalone entry: all configuration from the environment (see .env.example at the repo root).
const env = { ...process.env };
if (env.SPENDMARSHAL_POLICY_PATH && !env.SPENDMARSHAL_POLICY_YAML) env.SPENDMARSHAL_POLICY_YAML = readFileSync(env.SPENDMARSHAL_POLICY_PATH, "utf8");
const gw = await buildGateway(configFromEnv(env));
const addr = await gw.listen();
console.log(`SpendMarshal gateway listening on ${addr} as ${gw.signer.address}, receipts signed by ${receiptKeyOf(gw.signer)} (store: ${gw.cfg.storeDriver ?? "json"})`);
