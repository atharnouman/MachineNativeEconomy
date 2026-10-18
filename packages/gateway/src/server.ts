import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import { isAddress, type Hex } from "viem";
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
  gatewayKeyHistory,
  receiptSigner,
  approverKeyHistory,
  type Credential,
  type EvidenceBundle,
  type Receipt,
} from "@spendmarshal/core";
import { approversFor, type GatewayConfig } from "./config.js";
import { openStore, withLease, hasNonceLock, type Store } from "./store.js";
import { LocalSigner, receiptKeyOf, type Signer } from "./signer.js";
import { ChainClient } from "./chain.js";
import { ReceiptLog } from "./receipts.js";
import { CredentialService } from "./credentials.js";
import { PaymentService } from "./pay.js";
import { PolicyService } from "./policies.js";
import { ApprovalService } from "./approvals.js";
import { ApproverKeys } from "./approvers.js";
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
  /**
   * Resolves once seed receipts are written: policy version 1 and, for every configured principal, the handover of
   * its chain to this gateway's key and the approver keys in force. `listen()` awaits it.
   */
  ready: Promise<void>;
  exportEvidence(principalId: string): Promise<EvidenceBundle>;
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
  for (const a of cfg.previousGatewayAddresses ?? []) if (!isAddress(a, { strict: false })) throw new Error(`previous gateway address ${a} is not an address`);
  // every admin token must name one scope: no principal's token may equal the operator's or another principal's (ADR-0024)
  const tokenOwners = new Map<string, string>([[cfg.adminToken, "the gateway admin token"]]);
  for (const [p, pc] of Object.entries(cfg.principals)) {
    if (pc.adminToken === undefined) continue;
    if (pc.adminToken.length < 16) throw new Error(`the admin token of ${p} is shorter than 16 characters`);
    const owner = tokenOwners.get(pc.adminToken);
    if (owner) throw new Error(`the admin token of ${p} is the same as ${owner}`); // never echo the token
    tokenOwners.set(pc.adminToken, `the admin token of ${p}`);
  }
  const store = await openStore({ driver: cfg.storeDriver, dataDir: cfg.dataDir, databaseUrl: cfg.databaseUrl });
  // a configuration refused from here on must not leave the store open (a Postgres pool keeps the process alive)
  const refused = async (err: unknown): Promise<never> => {
    await store.close();
    throw err;
  };
  const signer = new LocalSigner(cfg.gatewayPrivateKey, cfg.sessionSecret, cfg.previousGatewayKeys, cfg.evidencePrivateKey);
  // gateway instances sharing a database take turns on the gateway key's nonces (ADR-0025)
  const chain = new ChainClient(cfg, hasNonceLock(store) ? store : undefined);
  const metrics = new Metrics({ defaultMetrics: cfg.defaultMetrics });
  const receipts = new ReceiptLog(store, signer, metrics, { previousGatewayAddresses: cfg.previousGatewayAddresses, log: app.log });
  let approverKeys: ApproverKeys;
  let policies: PolicyService;
  try {
    approverKeys = new ApproverKeys(cfg, store, receipts); // checks the approver addresses before anything is receipted
    policies = new PolicyService(store, receipts, { yaml: cfg.policyYaml, by: "config" });
  } catch (err) {
    return refused(err);
  }
  const approvals = new ApprovalService(cfg, store, receipts, metrics, approverKeys);
  const credentials = new CredentialService(cfg, store, signer, chain, receipts);
  const payments = new PaymentService(cfg, store, signer, chain, receipts, policies, approvals, { metrics, publicUrl });
  // Before the gateway serves, every configured principal's chain is handed over to this gateway's key (ADR-0020), then
  // records the approver keys in force (ADR-0019). Any other chain is handed over by its next receipt.
  const ready = policies.ready.then(() => Promise.all(Object.keys(cfg.principals).map((p) => receipts.handOver(p).then(() => approverKeys.sync(p))))).then(() => undefined);

  app.addHook("onResponse", (req, reply, done) => {
    metrics.httpRequests.inc({ route: req.routeOptions?.url ?? "unmatched", status: String(reply.statusCode) });
    done();
  });

  // ───────── auth helpers ─────────
  // Admin tokens are scoped (ADR-0024): the gateway-wide token acts on every principal, a principal's own token on that
  // principal only. Comparisons take the same time whatever the token holds.
  const sameToken = (given: string, expected: string) => {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  type AdminScope = { all: true } | { all: false; principalId: string };
  /** The scope of the request's admin token; 401 without a valid one. */
  const requireAdmin = (req: FastifyRequest): AdminScope => {
    const token = req.headers["x-admin-token"];
    if (typeof token === "string" && token) {
      if (sameToken(token, cfg.adminToken)) return { all: true };
      for (const [principalId, pc] of Object.entries(cfg.principals)) if (pc.adminToken && sameToken(token, pc.adminToken)) return { all: false, principalId };
    }
    throw Object.assign(new Error("admin token required"), { statusCode: 401 });
  };
  /** 403 unless the scope covers `principalId`; a gateway-wide action (`principalId` undefined) needs the gateway-wide token. */
  const allow = (scope: AdminScope, principalId: string | undefined) => {
    if (scope.all || scope.principalId === principalId) return;
    throw Object.assign(new Error(`this admin token acts on ${scope.principalId} only`), { statusCode: 403 });
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
    evidenceKey: receiptKeyOf(signer), // signs receipts; the same as `gateway` unless a separate evidence key is set (ADR-0023)
    agentKeyId: signer.agentKey.keyid,
    publicUrl,
    chainId: cfg.chainId,
    store: cfg.storeDriver ?? "json",
    policies: Object.fromEntries(
      await Promise.all(
        (await store.principalsWithPolicies()).map(async (p) => {
          const v = await policies.activeVersion(p);
          return [p, { version: v.version, hash: v.hash, activatedAt: v.activatedAt }] as const;
        }),
      ),
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
    const scope = requireAdmin(req);
    const b = z.object({ principalId: z.string(), agentId: z.string(), caveats: z.array(CaveatSchema).default([]) }).parse(req.body);
    allow(scope, b.principalId);
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
    return { credential: toPublic(c), registered: (await store.getCredential(credentialId(c))) ?? null };
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

  /** Agents see their own subtree; an admin token sees a whole principal it covers (`?principalId=`). */
  app.get("/v1/subscriptions", async (req) => {
    if (req.headers["x-admin-token"] !== undefined) {
      const scope = requireAdmin(req);
      const q = z.object({ principalId: z.string() }).parse(req.query);
      allow(scope, q.principalId);
      return { subscriptions: await payments.listSubscriptions({ admin: true, principalId: q.principalId }) };
    }
    const c = await requireCredential(req);
    return { subscriptions: await payments.listSubscriptions(c) };
  });

  app.post("/v1/subscriptions/:id/cancel", async (req) => {
    const id = (req.params as { id: string }).id;
    if (req.headers["x-admin-token"] !== undefined) {
      const scope = requireAdmin(req);
      const b = z.object({ principalId: z.string() }).parse(req.body ?? {});
      allow(scope, b.principalId);
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
    const scope = requireAdmin(req);
    const q = z.object({ principalId: z.string(), status: z.enum(["pending", "approved", "rejected", "expired", "consumed"]).optional() }).parse(req.query);
    allow(scope, q.principalId);
    const list = await Promise.all((await approvals.list(q.principalId, q.status)).map((a) => approvals.get(a.id)));
    return { approvals: list.filter((a): a is NonNullable<typeof a> => !!a && (!q.status || a.status === q.status)).map((a) => approvals.publicView(a)) };
  });

  for (const verdict of ["approve", "reject"] as const) {
    app.post(`/v1/approvals/:id/${verdict}`, async (req) => {
      const scope = requireAdmin(req);
      const b = z.object({ approverId: z.string().min(1), signature: z.string().regex(/^0x[0-9a-f]+$/).optional(), note: z.string().optional() }).parse(req.body);
      const id = (req.params as { id: string }).id;
      const pending = await store.getApproval(id); // read without side effects: the scope is checked before anything changes
      if (!pending) throw Object.assign(new Error("approval not found"), { statusCode: 404 });
      allow(scope, pending.principalId);
      const a = await approvals.resolve(id, verdict, { id: b.approverId, signature: b.signature as Hex | undefined }, b.note);
      return { approval: approvals.publicView(a) };
    });
  }

  // ───────── policies ─────────
  app.get("/v1/policies/:principalId", async (req) => {
    const p = (req.params as { principalId: string }).principalId;
    allow(requireAdmin(req), p);
    const active = await policies.activeVersion(p);
    return { active, versions: (await policies.versions(p)).map(({ document: _d, ...meta }) => meta) };
  });

  app.put("/v1/policies/:principalId", async (req) => {
    const p = (req.params as { principalId: string }).principalId;
    allow(requireAdmin(req), p);
    const b = z.object({ yaml: z.string().min(1), by: z.string().min(1) }).parse(req.body);
    const r = await policies.update(p, b.yaml, b.by);
    const { document: _d, ...meta } = r.version;
    return { version: meta, diff: r.diff, impact: r.impact };
  });

  // ───────── receipts & evidence ─────────
  app.get("/v1/receipts", async (req) => {
    const c = await requireCredential(req);
    return { receipts: await store.receiptsFor(c.principalId) };
  });

  app.post("/v1/receipts/external", async (req) => {
    const scope = requireAdmin(req);
    const b = z.object({ principalId: z.string(), source: z.string(), data: z.record(z.unknown()), credentialId: z.string().optional(), intentId: z.string().optional() }).parse(req.body);
    allow(scope, b.principalId);
    const r = await receipts.append(b.principalId, "external", { source: b.source, ...b.data }, { credentialId: b.credentialId, intentId: b.intentId });
    return { receipt: r };
  });

  // The bundle names the gateway key the chain ends with, read from its head: this gateway's key, unless the chain has not
  // been written since the key changed. Its rotations are exported as `gatewayKeyHistory` (ADR-0020).
  const keyAtHead = (rs: Receipt[]): string => {
    const head = rs[rs.length - 1];
    if (!head) return receiptKeyOf(signer);
    try {
      return receiptSigner(head);
    } catch {
      return receiptKeyOf(signer); // a malformed head signature: the verifier reports that receipt
    }
  };

  const exportEvidence = async (principalId: string): Promise<EvidenceBundle> => {
    const active = await policies.activeVersion(principalId);
    const rs = await store.receiptsFor(principalId);
    return {
      v: 1,
      principalId,
      exportedAt: nowIso(),
      gateway: { address: keyAtHead(rs), chain: `eip155:${cfg.chainId}` },
      gatewayKeyHistory: gatewayKeyHistory(rs),
      contracts: {
        agentAccount: cfg.principals[principalId]?.account ?? "",
        usdc: cfg.contracts.usdc,
        receiptRegistry: cfg.contracts.receiptRegistry,
        ...Object.fromEntries(Object.entries(cfg.contracts.enforcers).map(([k, v]) => [`enforcer.${k}`, v])),
      },
      policy: { hash: active.hash, document: active.document },
      policyVersions: await policies.versions(principalId),
      approvers: approversFor(cfg, principalId), // this principal's approvers as configured at export (ADR-0024)
      approverHistory: approverKeyHistory(rs),
      credentials: (await store.credentialsFor(principalId)).map(({ sessionKey: _s, parentSessionKey: _p, registeredAt: _r, txHash: _t, ...pub }) => pub),
      receipts: rs,
      anchors: (await store.anchorsList(principalId)).map(({ principalId: _owner, ...a }) => a),
    };
  };

  app.get("/v1/evidence/:principalId", async (req) => {
    const p = (req.params as { principalId: string }).principalId;
    allow(requireAdmin(req), p);
    return exportEvidence(p);
  });

  // The registry chains anchors per sending key and receipt chain, and names a principal's chain by the hash of its first
  // receipt (ADR-0021), so principals never constrain each other's anchors. The previous head comes from the registry (a
  // rotated relayer key or a fresh store would otherwise send a stale one), and anchors go one at a time so two never
  // claim the same head. The chain is handed over to this gateway's receipt key first, so this gateway signed the head
  // it anchors (ADR-0020). The gateway key sends the anchor; the `evidence.anchored` receipt records that sender, and it
  // is written before the anchor is listed, so an export never lists an anchor its chain does not record (ADR-0023).
  // Gateway instances sharing a store take turns per chain through a lease (ADR-0025).
  let anchoring: Promise<unknown> = Promise.resolve();
  const anchor = (principalId: string) => {
    const run = anchoring.then(() => withLease(store, `anchor:${principalId}`, { ttlMs: 10 * 60_000, waitMs: 60_000, busy: `another anchor of ${principalId} is in progress` }, async () => {
      await receipts.handOver(principalId);
      const rs = await store.receiptsFor(principalId);
      const head = rs[rs.length - 1]?.hash as Hex | undefined;
      if (!head) throw new Error("nothing to anchor");
      const receiptChain = rs[0]!.hash as Hex;
      const prev = await chain.latestAnchorHead(cfg.contracts.receiptRegistry, receiptChain);
      const { txHash, blockNumber } = await chain.anchor(cfg.contracts.receiptRegistry, receiptChain, head, prev, BigInt(rs.length));
      const rec = { head, count: rs.length, txHash, blockNumber: blockNumber.toString(), registry: cfg.contracts.receiptRegistry, party: chain.wallet.account.address };
      await receipts.append(principalId, "evidence.anchored", rec);
      await store.addAnchor({ principalId, ...rec });
      return rec;
    }));
    anchoring = run.catch(() => undefined);
    return run;
  };

  app.post("/v1/evidence/anchor", async (req) => {
    const scope = requireAdmin(req);
    const b = z.object({ principalId: z.string() }).parse(req.body);
    allow(scope, b.principalId);
    return anchor(b.principalId);
  });

  // ───────── maintenance ─────────
  app.post("/v1/maintenance/reclaim", async (req) => {
    const scope = requireAdmin(req);
    const b = z.object({ principalId: z.string().optional() }).parse(req.body ?? {});
    allow(scope, b.principalId); // every principal at once needs the gateway-wide token
    const results = await payments.reclaimExpiredPreApprovals(b.principalId);
    return { reclaimed: results.filter((r) => r.ok).length, results, pending: (await store.pendingPreApprovals(b.principalId)).length };
  });

  // ───────── kill switch ─────────
  app.post("/v1/killswitch", async (req) => {
    const scope = requireAdmin(req);
    const b = z.object({ principalId: z.string(), on: z.boolean(), reason: z.string().optional() }).parse(req.body);
    allow(scope, b.principalId);
    const account = cfg.principals[b.principalId]?.account;
    if (!account) throw Object.assign(new Error("unknown principal"), { statusCode: 404 });
    await store.setKillSwitch(b.principalId, b.on); // gateway refuses first (one request cycle)
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
    ready,
    exportEvidence,
    anchor,
    listen: async () => {
      await ready;
      return app.listen({ host: cfg.host, port: cfg.port });
    },
    close: async () => {
      await app.close();
      await store.close();
    },
  };
}
