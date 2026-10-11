import { readFileSync } from "node:fs";
import { buildGateway } from "./server.js";
import { configFromEnv } from "./config.js";

// Standalone entry: all configuration from the environment (see .env.example at the repo root).
const env = { ...process.env };
if (env.APGW_POLICY_PATH && !env.APGW_POLICY_YAML) env.APGW_POLICY_YAML = readFileSync(env.APGW_POLICY_PATH, "utf8");
const gw = await buildGateway(configFromEnv(env));
const addr = await gw.listen();
console.log(`apgw gateway listening on ${addr} as ${gw.signer.address} (store: ${gw.cfg.storeDriver ?? "json"})`);
