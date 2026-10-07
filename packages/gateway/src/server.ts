import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { Hex } from "viem";
import {
  CaveatSchema,
  CredentialSchema,
  decodeCredential,
  credentialId,
  toPublic,
  policyHash,
  nowIso,
  type Credential,
  type EvidenceBundle,
} from "@apgw/core";
import type { GatewayConfig } from "./config.js";
import { Store } from "./store.js";
import { LocalSigner, type Signer } from "./signer.js";
import { ChainClient } from "./chain.js";
import { ReceiptLog } from "./receipts.js";
import { CredentialService } from "./credentials.js";
import { PaymentService } from "./pay.js";
import { registerFacilitator } from "./facilitator.js";

export interface Gateway {
  app: FastifyInstance;
  cfg: GatewayConfig;
  store: Store;
  signer: Signer;
  chain: ChainClient;
  receipts: ReceiptLog;
  credentials: CredentialService;
  payments: PaymentService;
  exportEvidence(principalId: string): EvidenceBundle;
  anchor(principalId: string): Promise<{ head: Hex; count: number; txHash: Hex; blockNumber: string }>;
  listen(): Promise<string>;
  close(): Promise<void>;
}

const PayBody = z.object({
  url: z.string().url(),
  method: z.enum(["GET", "POST"]).optional(),
  body: z.unknown().optional(),
  maxAmount: z.string().regex(/^\d+(\.\d+)?$/),
  purpose: z.string().min(1),
  rail: z.enum(["x402", "mpp", "auto"]).optional(),
});

export function buildGateway(cfg: GatewayConfig): Gateway {
  const app = Fastify({ logger: false });
  const store = new Store(cfg.dataDir);
  const signer = new LocalSigner(cfg.gatewayPrivateKey, cfg.sessionSecret);
  const chain = new ChainClient(cfg);
  const receipts = new ReceiptLog(store, signer);
  const credentials = new CredentialService(cfg, store, signer, chain, receipts);
  const payments = new PaymentService(cfg, store, signer, chain, receipts);

  // ───────── auth helpers ─────────
  const requireAdmin = (req: FastifyRequest) => {
    if (req.headers["x-admin-token"] !== cfg.adminToken) throw Object.assign(new Error("admin token required"), { statusCode: 401 });
  };
  const requireCredential = (req: FastifyRequest): Credential => {
    const h = req.headers.authorization;
    const m = /^Bearer\s+(.+)$/i.exec(h ?? "");
    if (!m) throw Object.assign(new Error("credential bearer required"), { statusCode: 401 });
    let c: Credential;
    try {
      c = decodeCredential(m[1]!);
    } catch {
      throw Object.assign(new Error("malformed credential"), { statusCode: 401 });
    }
    try {
      credentials.verify(c);
    } catch (e) {
      throw Object.assign(new Error((e as Error).message), { statusCode: 401 });
    }
    return c;
  };

  app.setErrorHandler((err: unknown, _req, reply) => {
    const e = err as { statusCode?: number; message?: string };
    reply.code(e.statusCode ?? 500).send({ error: e.message ?? String(err) });
  });

  // ───────── health ─────────
  app.get("/healthz", async () => ({ ok: true, gateway: signer.address, chainId: cfg.chainId, policyHash: policyHash(payments.policy) }));

  // ───────── credentials ─────────
  app.post("/v1/credentials", async (req) => {
    requireAdmin(req);
    const b = z.object({ principalId: z.string(), agentId: z.string(), caveats: z.array(CaveatSchema).default([]) }).parse(req.body);
    const nonDelegate = b.caveats.filter((c) => c.type !== "delegate") as Exclude<typeof b.caveats[number], { type: "delegate" }>[];
    const cred = await credentials.issue({ principalId: b.principalId, agentId: b.agentId, caveats: nonDelegate });
    const reg = await credentials.register(cred);
    return { credential: cred, registered: reg };
  });

  app.post("/v1/credentials/attenuate", async (req) => {
    const parent = requireCredential(req);
    const b = z.object({ caveats: z.array(CaveatSchema), delegateTo: z.string().optional() }).parse(req.body);
    const child = credentials.attenuate(parent, b.caveats, b.delegateTo ? { agentId: b.delegateTo } : undefined);
    const reg = await credentials.register(child);
    return { credential: child, registered: reg };
  });

  app.post("/v1/credentials/register", async (req) => {
    const b = z.object({ credential: CredentialSchema }).parse(req.body);
    const reg = await credentials.register(b.credential);
    return { registered: reg };
  });

  app.get("/v1/credentials/me", async (req) => {
    const c = requireCredential(req);
    return { credential: toPublic(c), registered: store.getCredential(credentialId(c)) ?? null };
  });

  // ───────── payments ─────────
  app.post("/v1/intents/simulate", async (req) => {
    const c = requireCredential(req);
    return payments.simulate(c, PayBody.parse(req.body));
  });

  app.post("/v1/intents", async (req, reply) => {
    const c = requireCredential(req);
    const r = await payments.pay(c, PayBody.parse(req.body));
    return reply.code(r.ok ? 200 : r.status).send(r);
  });

  // ───────── receipts & evidence ─────────
  app.get("/v1/receipts", async (req) => {
    const c = requireCredential(req);
    return { receipts: store.receiptsFor(c.principalId) };
  });

  app.post("/v1/receipts/external", async (req) => {
    requireAdmin(req);
    const b = z.object({ principalId: z.string(), source: z.string(), data: z.record(z.unknown()), credentialId: z.string().optional(), intentId: z.string().optional() }).parse(req.body);
    const r = await receipts.append(b.principalId, "external", { source: b.source, ...b.data }, { credentialId: b.credentialId, intentId: b.intentId });
    return { receipt: r };
  });

  const exportEvidence = (principalId: string): EvidenceBundle => ({
    v: 1,
    principalId,
    exportedAt: nowIso(),
    gateway: { address: signer.address, chain: `eip155:${cfg.chainId}` },
    contracts: {
      agentAccount: cfg.principals[principalId]?.account ?? "",
      usdc: cfg.contracts.usdc,
      receiptRegistry: cfg.contracts.receiptRegistry,
      ...Object.fromEntries(Object.entries(cfg.contracts.enforcers).map(([k, v]) => [`enforcer.${k}`, v])),
    },
    policy: { hash: policyHash(payments.policy), document: payments.policy },
    credentials: store.credentialsFor(principalId).map(({ sessionKey: _s, registeredAt: _r, txHash: _t, ...pub }) => pub),
    receipts: store.receiptsFor(principalId),
    anchors: [...store.anchors],
  });

  app.get("/v1/evidence/:principalId", async (req) => {
    requireAdmin(req);
    return exportEvidence((req.params as { principalId: string }).principalId);
  });

  const anchor = async (principalId: string) => {
    const rs = store.receiptsFor(principalId);
    const head = rs[rs.length - 1]?.hash as Hex | undefined;
    if (!head) throw new Error("nothing to anchor");
    const prev = (store.anchors[store.anchors.length - 1]?.head ?? `0x${"0".repeat(64)}`) as Hex;
    const { txHash, blockNumber } = await chain.anchor(cfg.contracts.receiptRegistry, head, prev, BigInt(rs.length));
    const rec = { head, count: rs.length, txHash, blockNumber: blockNumber.toString(), registry: cfg.contracts.receiptRegistry };
    store.addAnchor(rec);
    await receipts.append(principalId, "evidence.anchored", rec);
    return rec;
  };

  app.post("/v1/evidence/anchor", async (req) => {
    requireAdmin(req);
    const b = z.object({ principalId: z.string() }).parse(req.body);
    return anchor(b.principalId);
  });

  // ───────── kill switch ─────────
  app.post("/v1/killswitch", async (req) => {
    requireAdmin(req);
    const b = z.object({ principalId: z.string(), on: z.boolean(), reason: z.string().optional() }).parse(req.body);
    const account = cfg.principals[b.principalId]?.account;
    if (!account) throw Object.assign(new Error("unknown principal"), { statusCode: 404 });
    store.setKillSwitch(b.principalId, b.on); // gateway refuses first (one request cycle)
    const txHash = await chain.setPaused(account, b.on); // then the chain refuses (one block)
    const r = await receipts.append(b.principalId, "killswitch", { on: b.on, reason: b.reason ?? null, account, txHash });
    return { on: b.on, txHash, receipt: r };
  });

  // ───────── facilitator ─────────
  if (cfg.facilitator.enabled) registerFacilitator(app, cfg, chain);

  return {
    app,
    cfg,
    store,
    signer,
    chain,
    receipts,
    credentials,
    payments,
    exportEvidence,
    anchor,
    listen: async () => app.listen({ host: cfg.host, port: cfg.port }),
    close: () => app.close(),
  };
}
