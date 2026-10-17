#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { parsePolicyYaml, policyHash } from "@spendmarshal/core";
import { verifyEvidence, formatReport } from "./verify.js";

export { verifyEvidence, formatReport };

const USAGE = `spendmarshal <command>

  export-evidence --gateway URL --admin-token TOKEN --principal ID --out FILE
  verify FILE [--rpc URL]             offline verification of an evidence bundle (+ on-chain anchors with --rpc)
        [--gateway-key ADDRESS]...    gateway keys you trust: every key that signed the chain must be one, or linked to one by handovers
  policy lint FILE                    parse a policy file and print its hash
`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "export-evidence") {
    const { values } = parseArgs({ args: rest, options: { gateway: { type: "string" }, "admin-token": { type: "string" }, principal: { type: "string" }, out: { type: "string" } } });
    const { gateway, principal, out } = values;
    const token = values["admin-token"];
    if (!gateway || !token || !principal || !out) return usage();
    const r = await fetch(`${gateway.replace(/\/$/, "")}/v1/evidence/${encodeURIComponent(principal)}`, { headers: { "x-admin-token": token } });
    if (!r.ok) {
      console.error(`gateway returned ${r.status}`);
      return 1;
    }
    writeFileSync(out, JSON.stringify(await r.json(), null, 2));
    console.log(`wrote ${out}`);
    return 0;
  }
  if (cmd === "verify") {
    const { values, positionals } = parseArgs({ args: rest, options: { rpc: { type: "string" }, "gateway-key": { type: "string", multiple: true } }, allowPositionals: true });
    const file = positionals[0];
    if (!file) return usage();
    const report = await verifyEvidence(JSON.parse(readFileSync(file, "utf8")), { rpcUrl: values.rpc, trustedGatewayKeys: values["gateway-key"] });
    console.log(formatReport(report));
    return report.ok ? 0 : 2;
  }
  if (cmd === "policy" && rest[0] === "lint") {
    const file = rest[1];
    if (!file) return usage();
    const p = parsePolicyYaml(readFileSync(file, "utf8"));
    console.log(`ok: principal ${p.principalId}, ${Object.keys(p.budgets).length} budgets, ${Object.keys(p.agents).length} agents, ${p.rules.length} rules`);
    console.log(`hash: ${policyHash(p)}`);
    return 0;
  }
  return usage();
}

function usage(): number {
  console.log(USAGE);
  return 1;
}

const isMain = process.argv[1] && /[\\/](index\.(ts|js))$/.test(process.argv[1]) && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").slice(-2).join("/"));
if (isMain) main().then((code) => process.exit(code));
