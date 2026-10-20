#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { parsePolicyYaml, policyHash } from "@spendmarshal/core";
import { verifyEvidence, formatReport } from "./verify.js";
import { audit, formatAuditHtml, formatAuditText, mergeBudgets, parseBudgets, parseWindow, type PriceTable } from "./audit.js";
import { buildStatement, formatStatementHtml, formatStatementText, parsePeriod } from "./statement.js";
import { createHash } from "node:crypto";
import { basename } from "node:path";

export { verifyEvidence, formatReport };
export { audit, formatAuditText, formatAuditHtml, parseBudgets, parseExport } from "./audit.js";
export type { AuditReport, AuditOptions, Finding, Budgets, PriceTable, SpendRow } from "./audit.js";
export { buildStatement, formatStatementText, formatStatementHtml, parsePeriod, parseAmount, human } from "./statement.js";
export type { Statement, StatementOptions, Reconciliation, Period } from "./statement.js";

const USAGE = `spendmarshal <command>

  export-evidence --gateway URL --admin-token TOKEN --principal ID --out FILE
  verify FILE [--rpc URL]             offline verification of an evidence bundle (+ on-chain anchors with --rpc)
        [--gateway-key ADDRESS]...    gateway keys you trust: every key that signed the chain must be one, or linked to one by handovers
  policy lint FILE                    parse a policy file and print its hash
  audit-logs EXPORT                   read-only diagnostic over a LiteLLM spend-log export (offline, metadata only):
        [--format text|html|json]     repeated requests, retry storms, possible loops, failed and empty calls,
        [--out FILE]                  expensive models on small outputs, unattributed spend, caps against real use;
        [--window 10m] [--storm-calls 5] [--storm-window 1m]        see docs/AUDIT_LOGS.md
        [--loop-calls 10] [--loop-gap 90s] [--expensive 5]
        [--prices FILE] [--budgets FILE]...
  statement BUNDLE                   a client's statement from its evidence bundle: settlements by agent, payee and
        [--period 2026-10]            rail, approvals, denials, policy versions, mandates, events; verified first
        [--provider-total 0.18]       (--unverified to produce one anyway, marked); reconciled to the provider's
        [--payee ADDRESS]             figure when given, for one payee when named; see docs/STATEMENT.md
        [--boundary-days 2] [--format text|html|json] [--out FILE] [--gateway-key ADDRESS]...
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
  if (cmd === "audit-logs") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        format: { type: "string", default: "text" },
        out: { type: "string" },
        window: { type: "string", default: "10m" },
        "storm-calls": { type: "string", default: "5" },
        "storm-window": { type: "string", default: "1m" },
        "loop-calls": { type: "string", default: "10" },
        "loop-gap": { type: "string", default: "90s" },
        expensive: { type: "string", default: "5" },
        prices: { type: "string" },
        budgets: { type: "string", multiple: true },
      },
      allowPositionals: true,
    });
    const file = positionals[0];
    const format = values.format ?? "text";
    if (!file || (format !== "text" && format !== "html" && format !== "json")) return usage();
    let text: string;
    try {
      const stormCalls = Number(values["storm-calls"] ?? "5");
      const loopCalls = Number(values["loop-calls"] ?? "10");
      const expensive = Number(values.expensive ?? "5");
      if (!Number.isInteger(stormCalls) || stormCalls < 2) throw new Error("--storm-calls must be a whole number of at least 2");
      if (!Number.isInteger(loopCalls) || loopCalls < 3) throw new Error("--loop-calls must be a whole number of at least 3");
      if (!Number.isFinite(expensive) || expensive < 0) throw new Error("--expensive must be a number of dollars per million tokens");
      const report = audit(readFileSync(file, "utf8"), {
        windowMs: parseWindow(values.window ?? "10m"),
        stormCalls,
        stormWindowMs: parseWindow(values["storm-window"] ?? "1m"),
        loopCalls,
        loopGapMs: parseWindow(values["loop-gap"] ?? "90s"),
        expensivePerMillion: expensive,
        prices: values.prices ? (JSON.parse(readFileSync(values.prices, "utf8")) as PriceTable) : undefined,
        budgets: values.budgets?.length ? mergeBudgets(values.budgets.map((f) => parseBudgets(readFileSync(f, "utf8")))) : undefined,
      });
      text = format === "json" ? JSON.stringify(report, null, 2) : format === "html" ? formatAuditHtml(report) : formatAuditText(report);
    } catch (e) {
      console.error(`audit-logs: ${(e as Error).message}`);
      return 2;
    }
    if (values.out) {
      writeFileSync(values.out, text);
      console.log(`wrote ${values.out}`);
    } else console.log(text);
    return 0;
  }
  if (cmd === "statement") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        period: { type: "string" },
        "provider-total": { type: "string" },
        payee: { type: "string" },
        "boundary-days": { type: "string", default: "2" },
        format: { type: "string", default: "text" },
        out: { type: "string" },
        unverified: { type: "boolean", default: false },
        "gateway-key": { type: "string", multiple: true },
      },
      allowPositionals: true,
    });
    const file = positionals[0];
    const format = values.format ?? "text";
    if (!file || (format !== "text" && format !== "html" && format !== "json")) return usage();
    let text: string;
    try {
      const bytes = readFileSync(file);
      const report = await verifyEvidence(JSON.parse(bytes.toString("utf8")), { trustedGatewayKeys: values["gateway-key"] });
      if (!report.bundle) {
        console.log(formatReport(report));
        console.error("statement: the file is not an evidence bundle");
        return 2;
      }
      if (!report.ok && !values.unverified) {
        console.log(formatReport(report));
        console.error("statement: the bundle does not verify; pass --unverified to produce a statement marked as such");
        return 2;
      }
      const boundaryDays = Number(values["boundary-days"] ?? "2");
      if (!Number.isInteger(boundaryDays) || boundaryDays < 0) throw new Error("--boundary-days must be a whole number of days");
      const statement = buildStatement(report.bundle, {
        period: values.period ? parsePeriod(values.period) : undefined,
        providerTotal: values["provider-total"],
        payee: values.payee,
        boundaryDays,
        sourceName: basename(file),
        sourceSha256: createHash("sha256").update(bytes).digest("hex"),
        verification: report,
      });
      text = format === "json" ? JSON.stringify(statement, null, 2) : format === "html" ? formatStatementHtml(statement) : formatStatementText(statement);
    } catch (e) {
      console.error(`statement: ${(e as Error).message}`);
      return 2;
    }
    if (values.out) {
      writeFileSync(values.out, text);
      console.log(`wrote ${values.out}`);
    } else console.log(text);
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
