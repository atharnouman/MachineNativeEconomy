import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { Hex } from "viem";
import {
  CaveatSchema,
  CredentialSchema,
  decodeCredential,
  credentialId,
  toPublic,
  nowIso,
  describeRevert,
  signMessage,
  DIRECTORY_PATH,
  DIRECTORY_CONTENT_TYPE,
  type Credential,
  type EvidenceBundle,
} from "@spendmarshal/core";
import type { GatewayConfig } from "./config.js";
import { openStore, type Store } from "./store.js";
import { LocalSigner, type Signer } from "./signer.js";
import { ChainClient } from "./chain.js";
import { ReceiptLog } from "./receipts.js";
import { CredentialService } from "./credentials.js";
import { PaymentService } from "./pay.js";
import { PolicyService } from "./policies.js";
import { ApprovalService } from "./approvals.js";
import { registerFacilitator } from "./facilitator.js";
import { Metrics } from "./metrics.js";
import { buildOpenApi, PayBodySchema } from "./openapi.js";
import { checkHolder } from "./httpauth.js";
import { IdempotencyGuard, idempotencyKeyOf } from "./idempotency.js";

export const GATEWAY_VERSION = "0.0.2";

export interface Gateway {
  app: FastifyInstance;
  cfg: GatewayConfig;
  store: Store;
  signer: Signer;
  chain: ChainClient;
  receipts: ReceiptLog;
  credentials: CredentialService;
  payments: PaymentService;
  policies: PolicyService;
  approvals: ApprovalService;
  metrics: Metrics;
  publicUrl: string;
  /** Resolves once seed receipts (policy version 1) are written. `listen()` awaits it. */
  ready: Promise<void>;
  exportEvidence(principalId: string): EvidenceBundle;
  anchor(principalId: string): Promise<{ head: Hex; count: number; txHash: Hex; blockNumber: string }>;
  listen(): Promise<string>;
  close(): Promise<void>;
}

type RawBodyRequest = FastifyRequest & { rawBody?: string };

export async function buildGateway(cfg: GatewayConfig): Promise<Gateway> {
  const app = Fastify({
    logger: cfg.logLevel
      ? {
          level: cfg.logLevel,
          redact: { paths: ["req.headers.authorization", 'req.headers["x-admin-token"]', "req.headers.signature", 'req.headers["signature-input"]'], censor: "[redacted]" },
        }
      : false,
  });
  // keep the raw JSON text so Content-Digest on holder-signed requests can be checked byte for byte
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as RawBodyRequest).rawBody = body as string;
    try {
      done(null, (body as string).length ? JSON.parse(body as string) : {});
    } catch (e) {
      done(Object.assign(e as Error, { statusCode: 400 }), undefined);
    }
  });

  const publicUrl = (cfg.publicUrl ?? `http://${cfg.host}:${cfg.port}`).replace(/\/$/, "");
  const store = await openStore({ driver: cfg.storeDriver, dataDir: cfg.dataDir });
  const signer = new LocalSigner(cfg.gatewayPrivateKey, cfg.sessionSecret);
  const chain = new ChainClient(cfg);
  const metrics = new Metrics({ defaultMetrics: cfg.defaultMetrics });
  const receipts = new ReceiptLog(store, signer, metrics);
  const policies = new PolicyService(store, receipts, { yaml: cfg.policyYaml, by: "config" });
  const approvals = new ApprovalService(cfg, store, receipts, metrics);
  const credentials = new CredentialService(cfg, store, signer, chain, receipts);
  const payments = new PaymentService(cfg, store, signer, chain, receipts, policies, approvals, { metrics, publicUrl });

  app.addHook("onResponse", (req, reply, done) => {
    metrics.httpRequests.inc({ route: req.routeOptions?.url ?? "unmatched", status: String(reply.statusCode) });
    done();
  });

  // ───────── auth helpers ─────────
  const requireAdmin = (req: FastifyRequest) => {
    if (req.headers["x-admin-token"] !== cfg.adminToken) throw Object.assign(new Error("admin token required"), { statusCode: 401 });
  };
  const requireCredential = async (req: FastifyRequest): Promise<Credential> => {
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
    const holder = await checkHolder(req, c, (req as RawBodyRequest).rawBody);
    if (!holder.ok) throw Object.assign(new Error(`holder signature required: ${holder.reason}`), { statusCode: 401 });
    return c;
  };

  app.setErrorHandler((err: unknown, _req, reply) => {
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    reply.code(status).send({ ok: false, status, error: e.message ?? String(err) });
  });

  // ───────── discovery, health, metrics ─────────
  app.get("/healthz", async () => ({
    ok: true,
    version: GATEWAY_VERSION,
    gateway: signer.address,
    agentKeyId: signer.agentKey.keyid,
    publicUrl,
    chainId: cfg.chainId,
    store: cfg.storeDriver ?? "json",
    policies: Object.fromEntries(
      store.principalsWithPolicies().map((p) => {
        const v = policies.activeVersion(p);
        return [p, { version: v.version, hash: v.hash, activatedAt: v.activatedAt }];
      }),
    ),
  }));

  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    return metrics.text();
  });

  app.get("/openapi.json", async () => buildOpenApi({ url: publicUrl, version: GATEWAY_VERSION }));

  /** Web Bot Auth key directory. The response itself is signed so a verifier can pin the origin's key. */
  app.get(DIRECTORY_PATH, async (req, reply) => {
    const body = JSON.stringify({ keys: [signer.agentKey.publicJwk] });
    const sig = signMessage(
      { method: "GET", url: `${req.protocol}://${req.headers.host}${req.url}`, headers: {} },
      { privateKey: signer.agentKey.privateKey, keyid: signer.agentKey.keyid, components: ["@authority"], tag: "http-message-signatures-directory", ttlSeconds: 3600 },
    );
    reply.header("content-type", DIRECTORY_CONTENT_TYPE).header("cache-control", "max-age=300").header("signature-input", sig["signature-input"]).header("signature", sig.signature);
    return body;
  });
  app.get("/.well-known/jwks.json", async () => ({ keys: [signer.agentKey.publicJwk] }));

  // ───────── credentials ─────────
  app.post("/v1/credentials", async (req) => {
    requireAdmin(req);
    const b = z.object({ principalId: z.string(), agentId: z.string(), caveats: z.array(CaveatSchema).default([]) }).parse(req.body);
    const nonDelegate = b.caveats.filter((c) => c.type !== "delegate") as Exclude<(typeof b.caveats)[number], { type: "delegate" }>[];
    const cred = await credentials.issue({ principalId: b.principalId, agentId: b.agentId, caveats: nonDelegate });
    const reg = await credentials.register(cred);
    return { credential: cred, registered: reg };
  });

  app.post("/v1/credentials/attenuate", async (req) => {
    const parent = await requireCredential(req);
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
    const c = await requireCredential(req);
    return { credential: toPublic(c), registered: store.getCredential(credentialId(c)) ?? null };
  });

  // ───────── payments ─────────
  app.post("/v1/intents/simulate", async (req) => {
    const c = await requireCredential(req);
    return payments.simulate(c, PayBodySchema.parse(req.body));
  });

  const idempotency = new IdempotencyGuard(store);

  app.post("/v1/intents", async (req, reply) => {
    const c = await requireCredential(req);
    const body = PayBodySchema.parse(req.body);
    const { result, replayed } = await idempotency.run(credentialId(c), idempotencyKeyOf(req), () => payments.pay(c, body));
    if (replayed) reply.header("idempotent-replayed", "true");
    return reply.code(result.ok ? 200 : result.status).send(replayed ? { ...result, replayed: true } : result);
  });

  app.post("/v1/intents/resume", async (req, reply) => {
    const c = await requireCredential(req);
    const b = z.object({ approvalId: z.string() }).parse(req.body);
    const r = await payments.resume(c, b.approvalId);
    return reply.code(r.ok ? 200 : r.status).send(r);
  });

  // ───────── subscriptions ─────────
  app.post("/v1/subscriptions", async (req, reply) => {
    const c = await requireCredential(req);
    const { SubscribeRequestSchema } = await import("@spendmarshal/core");
    const body = SubscribeRequestSchema.parse(req.body);
    const { result, replayed } = await idempotency.run(credentialId(c), idempotencyKeyOf(req), () => payments.subscribe(c, body));
    if (replayed) reply.header("idempotent-replayed", "true");
    return reply.code(result.ok ? 200 : result.status).send(replayed ? { ...result, replayed: true } : result);
  });

  /** Agents see their own subtree; the admin token sees a whole principal (`?principalId=`). */
  app.get("/v1/subscriptions", async (req) => {
    if (req.headers["x-admin-token"] === cfg.adminToken) {
      const q = z.object({ principalId: z.string() }).parse(req.query);
      return { subscriptions: payments.listSubscriptions({ admin: true, principalId: q.principalId }) };
    }
    const c = await requireCredential(req);
    return { subscriptions: payments.listSubscriptions(c) };
  });

  app.post("/v1/subscriptions/:id/cancel", async (req) => {
    const id = (req.params as { id: string }).id;
    if (req.headers["x-admin-token"] === cfg.adminToken) {
      const b = z.object({ principalId: z.string() }).parse(req.body ?? {});
      return { subscription: await payments.cancelSubscription({ admin: true, principalId: b.principalId }, id) };
    }
    const c = await requireCredential(req);
    return { subscription: await payments.cancelSubscription(c, id) };
  });

  /** Called by the payee with the charge token it received when the subscription opened. */
  app.post("/v1/subscriptions/:id/charges", async (req, reply) => {
    const { ChargeRequestSchema } = await import("@spendmarshal/core");
    const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const r = await payments.charge((req.params as { id: string }).id, token, ChargeRequestSchema.parse(req.body ?? {}));
    return reply.code(r.status).send(r);
  });

  // ───────── approvals ─────────
  app.get("/v1/approvals/:id", async (req) => {
    const c = await requireCredential(req);
    const a = await approvals.get((req.params as { id: string }).id);
    if (!a || a.principalId !== c.principalId) throw Object.assign(new Error("approval not found"), { statusCode: 404 });
    return { approval: approvals.publicView(a) };
  });

  app.get("/v1/approvals", async (req) => {
    requireAdmin(req);
    const q = z.object({ principalId: z.string(), status: z.enum(["pending", "approved", "rejected", "expired", "consumed"]).optional() }).parse(req.query);
    const list = await Promise.all(approvals.list(q.principalId, q.status).map((a) => approvals.get(a.id)));
    return { approvals: list.filter((a): a is NonNullable<typeof a> => !!a && (!q.status || a.status === q.status)).map((a) => approvals.publicView(a)) };
  });

  for (const verdict of ["approve", "reject"] as const) {
    app.post(`/v1/approvals/:id/${verdict}`, async (req) => {
      requireAdmin(req);
      const b = z.object({ approverId: z.string().min(1), signature: z.string().regex(/^0x[0-9a-f]+$/).optional(), note: z.string().optional() }).parse(req.body);
      const a = await approvals.resolve((req.params as { id: string }).id, verdict, { id: b.approverId, signature: b.signature as Hex | undefined }, b.note);
      return { approval: approvals.publicView(a) };
    });
  }

  // ───────── policies ─────────
  app.get("/v1/policies/:principalId", async (req) => {
    requireAdmin(req);
    const p = (req.params as { principalId: string }).principalId;
    const active = policies.activeVersion(p);
    return { active, versions: policies.versions(p).map(({ document: _d, ...meta }) => meta) };
  });

  app.put("/v1/policies/:principalId", async (req) => {
    requireAdmin(req);
    const p = (req.params as { principalId: string }).principalId;
    const b = z.object({ yaml: z.string().min(1), by: z.string().min(1) }).parse(req.body);
    const r = await policies.update(p, b.yaml, b.by);
    const { document: _d, ...meta } = r.version;
    return { version: meta, diff: r.diff, impact: r.impact };
  });

  // ───────── receipts & evidence ─────────
  app.get("/v1/receipts", async (req) => {
    const c = await requireCredential(req);
    return { receipts: store.receiptsFor(c.principalId) };
  });

  app.post("/v1/receipts/external", async (req) => {
    requireAdmin(req);
    const b = z.object({ principalId: z.string(), source: z.string(), data: z.record(z.unknown()), credentialId: z.string().optional(), intentId: z.string().optional() }).parse(req.body);
    const r = await receipts.append(b.principalId, "external", { source: b.source, ...b.data }, { credentialId: b.credentialId, intentId: b.intentId });
    return { receipt: r };
  });

  const exportEvidence = (principalId: string): EvidenceBundle => {
    const active = policies.activeVersion(principalId);
    return {
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
      policy: { hash: active.hash, document: active.document },
      policyVersions: policies.versions(principalId),
      approvers: cfg.approvers ?? {},
      credentials: store.credentialsFor(principalId).map(({ sessionKey: _s, parentSessionKey: _p, registeredAt: _r, txHash: _t, ...pub }) => pub),
      receipts: store.receiptsFor(principalId),
      anchors: store.anchorsList(principalId).map(({ principalId: _owner, ...a }) => a),
    };
  };

  app.get("/v1/evidence/:principalId", async (req) => {
    requireAdmin(req);
    return exportEvidence((req.params as { principalId: string }).principalId);
  });

  // The registry chains anchors per sending key, so the previous head comes from the registry (a rotated relayer key or
  // a fresh store would otherwise send a stale one), and anchors go one at a time so two never claim the same head.
  let anchoring: Promise<unknown> = Promise.resolve();
  const anchor = (principalId: string) => {
    const run = anchoring.then(async () => {
      const rs = store.receiptsFor(principalId);
      const head = rs[rs.length - 1]?.hash as Hex | undefined;
      if (!head) throw new Error("nothing to anchor");
      const prev = await chain.latestAnchorHead(cfg.contracts.receiptRegistry);
      const { txHash, blockNumber } = await chain.anchor(cfg.contracts.receiptRegistry, head, prev, BigInt(rs.length));
      const rec = { head, count: rs.length, txHash, blockNumber: blockNumber.toString(), registry: cfg.contracts.receiptRegistry };
      store.addAnchor({ principalId, ...rec });
      await receipts.append(principalId, "evidence.anchored", rec);
      return rec;
    });
    anchoring = run.catch(() => undefined);
    return run;
  };

  app.post("/v1/evidence/anchor", async (req) => {
    requireAdmin(req);
    const b = z.object({ principalId: z.string() }).parse(req.body);
    return anchor(b.principalId);
  });

  // ───────── maintenance ─────────
  app.post("/v1/maintenance/reclaim", async (req) => {
    requireAdmin(req);
    const b = z.object({ principalId: z.string().optional() }).parse(req.body ?? {});
    const results = await payments.reclaimExpiredPreApprovals(b.principalId);
    return { reclaimed: results.filter((r) => r.ok).length, results, pending: store.pendingPreApprovals(b.principalId).length };
  });

  // ───────── kill switch ─────────
  app.post("/v1/killswitch", async (req) => {
    requireAdmin(req);
    const b = z.object({ principalId: z.string(), on: z.boolean(), reason: z.string().optional() }).parse(req.body);
    const account = cfg.principals[b.principalId]?.account;
    if (!account) throw Object.assign(new Error("unknown principal"), { statusCode: 404 });
    store.setKillSwitch(b.principalId, b.on); // gateway refuses first (one request cycle)
    let txHash: Hex | null = null;
    let onchain: string;
    try {
      txHash = await chain.setPaused(account, b.on); // then the chain refuses (one block)
      onchain = b.on ? "paused" : "unpaused";
    } catch (err) {
      // pausing is allowed for any active session key; unpausing needs the owner (production mode)
      onchain = `owner-required: ${describeRevert(err)}`;
      if (b.on) throw Object.assign(new Error(`could not pause on-chain: ${describeRevert(err)}`), { statusCode: 502 });
    }
    const r = await receipts.append(b.principalId, "killswitch", { on: b.on, reason: b.reason ?? null, account, txHash, onchain });
    return { on: b.on, txHash, onchain, receipt: r };
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
    policies,
    approvals,
    metrics,
    publicUrl,
    ready: policies.ready,
    exportEvidence,
    anchor,
    listen: async () => {
      await policies.ready;
      return app.listen({ host: cfg.host, port: cfg.port });
    },
    close: async () => {
      await app.close();
      store.close();
    },
  };
}
