import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CaveatSchema, CredentialSchema, ApprovalSchema, ReceiptSchema, EvidenceBundleSchema, PolicySchema, X402SignatureSchema, X402AcceptSchema } from "@spendmarshal/core";

/** The request body for /v1/intents and /v1/intents/simulate (kept in sync with server.ts). */
export const PayBodySchema = z.object({
  url: z.string().url().describe("Resource URL to buy"),
  method: z.enum(["GET", "POST"]).optional(),
  body: z.unknown().optional(),
  maxAmount: z.string().regex(/^\d+(\.\d+)?$/).describe("Ceiling in human units, e.g. '0.05'. A ceiling, not a price."),
  purpose: z.string().min(1),
  rail: z.enum(["x402", "mpp", "auto"]).optional(),
  approvalId: z.string().optional().describe("Resume an escalated intent under a granted approval"),
  x402Mode: z.enum(["agent-account", "standard"]).optional(),
});

const schema = (s: z.ZodTypeAny, name: string) => zodToJsonSchema(s, { name, $refStrategy: "none" }).definitions?.[name] ?? zodToJsonSchema(s, { $refStrategy: "none" });

const bearer = [{ credential: [] }];
const admin = [{ adminToken: [] }];
const idempotencyHeader = { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", maxLength: 128 }, description: "Same credential + same key = same outcome for 24 h (settled, pending approval or denied are replayed with `replayed: true`; transient failures are retried)" };
const json = (ref: unknown, description = "") => ({ description, content: { "application/json": { schema: ref } } });
const obj = (description: string) => ({ type: "object", description, additionalProperties: true });

export function buildOpenApi(info: { url: string; version: string }) {
  return {
    openapi: "3.1.0",
    info: {
      title: "SpendMarshal — Agentic Payment Gateway",
      version: info.version,
      description: "Policy, settlement and evidence control plane between AI agents and any payment rail. Agents authenticate with a bearer credential (and, when holder-bound, an RFC 9421 signature); operators with an admin token.",
      license: { name: "Apache-2.0" },
    },
    servers: [{ url: info.url }],
    components: {
      securitySchemes: {
        credential: { type: "http", scheme: "bearer", description: "base64url credential (macaroon-style). If the credential carries a holder_key caveat, the request must also carry Signature-Input/Signature (RFC 9421, Ed25519, tag spendmarshal-holder) and Content-Digest for bodies." },
        adminToken: { type: "apiKey", in: "header", name: "x-admin-token" },
      },
      schemas: {
        PayRequest: schema(PayBodySchema, "PayRequest"),
        Caveat: schema(CaveatSchema, "Caveat"),
        Credential: schema(CredentialSchema, "Credential"),
        Approval: schema(ApprovalSchema, "Approval"),
        Receipt: schema(ReceiptSchema, "Receipt"),
        EvidenceBundle: schema(EvidenceBundleSchema, "EvidenceBundle"),
        Policy: schema(PolicySchema, "Policy"),
        X402PaymentPayload: schema(X402SignatureSchema, "X402PaymentPayload"),
        X402Requirements: schema(X402AcceptSchema, "X402Requirements"),
        PayResult: obj("ok, status, rail, payloadKind, intent, decision, onchain, settlement, pending, receipts[], body, error"),
      },
    },
    paths: {
      "/healthz": { get: { summary: "Liveness, gateway address, active policy versions", responses: { 200: json(obj("ok, gateway, chainId, policies")) } } },
      "/metrics": { get: { summary: "Prometheus metrics", responses: { 200: { description: "text/plain; version=0.0.4" } } } },
      "/openapi.json": { get: { summary: "This document", responses: { 200: json(obj("OpenAPI 3.1")) } } },
      "/.well-known/http-message-signatures-directory": { get: { summary: "Web Bot Auth key directory (signed response)", responses: { 200: json(obj("{ keys: JWK[] }"), "application/http-message-signatures-directory+json") } } },
      "/.well-known/jwks.json": { get: { summary: "Gateway signing keys as a JWK Set", responses: { 200: json(obj("{ keys: JWK[] }")) } } },
      "/v1/credentials": { post: { summary: "Issue and register a root credential for an agent", security: admin, requestBody: json({ type: "object", required: ["principalId", "agentId"], properties: { principalId: { type: "string" }, agentId: { type: "string" }, caveats: { type: "array", items: { $ref: "#/components/schemas/Caveat" } } } }), responses: { 200: json(obj("credential (bearer), registered (session)")) } } },
      "/v1/credentials/attenuate": { post: { summary: "Attenuate the caller's credential (optionally delegating) and register it", security: bearer, requestBody: json({ type: "object", required: ["caveats"], properties: { caveats: { type: "array", items: { $ref: "#/components/schemas/Caveat" } }, delegateTo: { type: "string" } } }), responses: { 200: json(obj("credential, registered")) } } },
      "/v1/credentials/register": { post: { summary: "Register an offline-attenuated credential (compiles an on-chain session)", requestBody: json({ type: "object", required: ["credential"], properties: { credential: { $ref: "#/components/schemas/Credential" } } }), responses: { 200: json(obj("registered")) } } },
      "/v1/credentials/me": { get: { summary: "Public view of the caller's credential and its on-chain session", security: bearer, responses: { 200: json(obj("credential, registered")) } } },
      "/v1/intents/simulate": { post: { summary: "Dry-run: fetch the 402 quote, decide, ask the account contract; nothing is paid", security: bearer, requestBody: json({ $ref: "#/components/schemas/PayRequest" }), responses: { 200: json({ $ref: "#/components/schemas/PayResult" }) } } },
      "/v1/intents": { post: { parameters: [idempotencyHeader], summary: "Pay for a resource under policy (x402 or MPP). 202 = approval required", security: bearer, requestBody: json({ $ref: "#/components/schemas/PayRequest" }), responses: { 200: json({ $ref: "#/components/schemas/PayResult" }, "settled"), 202: json({ $ref: "#/components/schemas/PayResult" }, "pending approval"), 402: json({ $ref: "#/components/schemas/PayResult" }, "quote exceeds ceiling"), 403: json({ $ref: "#/components/schemas/PayResult" }, "denied"), 409: json({ $ref: "#/components/schemas/PayResult" }, "quote differs from approval"), 502: json({ $ref: "#/components/schemas/PayResult" }, "payee / settlement failure") } } },
      "/v1/intents/resume": { post: { summary: "Continue an escalated payment under a granted approval", security: bearer, requestBody: json({ type: "object", required: ["approvalId"], properties: { approvalId: { type: "string" } } }), responses: { 200: json({ $ref: "#/components/schemas/PayResult" }), 403: json({ $ref: "#/components/schemas/PayResult" }) } } },
      "/v1/subscriptions": {
        post: { parameters: [idempotencyHeader], summary: "Open a subscription (MPP): the first charge pays now; the payee may charge later within the terms", security: bearer, requestBody: json({ type: "object", required: ["url", "purpose", "maxAmountPerCharge"], properties: { url: { type: "string" }, purpose: { type: "string" }, maxAmountPerCharge: { type: "string" }, maxCharges: { type: "integer" }, maxTotal: { type: "string" }, expiresAt: { type: "string", format: "date-time" } } }), responses: { 200: json(obj("ok, subscription, firstCharge")), 402: json(obj("offer above cap")), 409: json(obj("no subscription offer")) } },
        get: { summary: "List subscriptions: a credential sees those opened in its own lineage; the admin token sees a whole principal", security: [...bearer, ...admin], parameters: [{ name: "principalId", in: "query", schema: { type: "string" }, description: "admin token only" }], responses: { 200: json(obj("subscriptions[]")) } },
      },
      "/v1/subscriptions/{id}/cancel": { post: { summary: "Cancel a subscription (own lineage, or the admin token with principalId); further payee charges are refused with 410", security: [...bearer, ...admin], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: json({ type: "object", properties: { principalId: { type: "string", description: "admin token only" } } }), responses: { 200: json(obj("subscription")) } } },
      "/v1/subscriptions/{id}/charges": { post: { summary: "Payee charges a subscription (Bearer charge token). Policy runs on every charge; settled on-chain by the gateway", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: json({ type: "object", properties: { units: { type: "integer" }, amount: { type: "string" }, reference: { type: "string" } } }), responses: { 200: json(obj("ok, txHash, amount, charges, totalCharged, subscriptionStatus")), 401: json(obj("invalid charge token")), 403: json(obj("over cap or denied by policy")), 410: json(obj("cancelled / exhausted / expired")), 429: json(obj("too early; nextAllowedAt")) } } },
      "/v1/approvals": { get: { summary: "List approvals for a principal", security: admin, parameters: [{ name: "principalId", in: "query", required: true, schema: { type: "string" } }, { name: "status", in: "query", schema: { type: "string", enum: ["pending", "approved", "rejected", "expired", "consumed"] } }], responses: { 200: json({ type: "object", properties: { approvals: { type: "array", items: { $ref: "#/components/schemas/Approval" } } } }) } } },
      "/v1/approvals/{id}": { get: { summary: "Approval status (agent side)", security: bearer, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: json({ type: "object", properties: { approval: { $ref: "#/components/schemas/Approval" } } }) } } },
      "/v1/approvals/{id}/approve": { post: { summary: "Approve, optionally with an EIP-191 approver signature", security: admin, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: json({ type: "object", required: ["approverId"], properties: { approverId: { type: "string" }, signature: { type: "string" }, note: { type: "string" } } }), responses: { 200: json(obj("approval")) } } },
      "/v1/approvals/{id}/reject": { post: { summary: "Reject, optionally with an EIP-191 approver signature", security: admin, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: json({ type: "object", required: ["approverId"], properties: { approverId: { type: "string" }, signature: { type: "string" }, note: { type: "string" } } }), responses: { 200: json(obj("approval")) } } },
      "/v1/policies/{principalId}": {
        get: { summary: "Active policy version and version history", security: admin, parameters: [{ name: "principalId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: json(obj("active, versions[]")) } },
        put: { summary: "Activate a new policy version (validated, diffed, impact-analysed, receipted)", security: admin, parameters: [{ name: "principalId", in: "path", required: true, schema: { type: "string" } }], requestBody: json({ type: "object", required: ["yaml", "by"], properties: { yaml: { type: "string" }, by: { type: "string" } } }), responses: { 200: json(obj("version, diff, impact[]")), 409: json(obj("policy unchanged")) } },
      },
      "/v1/receipts": { get: { summary: "Signed receipts for the caller's principal", security: bearer, responses: { 200: json({ type: "object", properties: { receipts: { type: "array", items: { $ref: "#/components/schemas/Receipt" } } } }) } } },
      "/v1/receipts/external": { post: { summary: "Attach an operator-provided receipt with provenance", security: admin, requestBody: json({ type: "object", required: ["principalId", "source", "data"], properties: { principalId: { type: "string" }, source: { type: "string" }, data: { type: "object" }, credentialId: { type: "string" }, intentId: { type: "string" } } }), responses: { 200: json(obj("receipt")) } } },
      "/v1/evidence/{principalId}": { get: { summary: "Export the evidence bundle (offline-verifiable)", security: admin, parameters: [{ name: "principalId", in: "path", required: true, schema: { type: "string" } }], responses: { 200: json({ $ref: "#/components/schemas/EvidenceBundle" }) } } },
      "/v1/evidence/anchor": { post: { summary: "Anchor the receipt chain head on-chain", security: admin, requestBody: json({ type: "object", required: ["principalId"], properties: { principalId: { type: "string" } } }), responses: { 200: json(obj("head, count, txHash, blockNumber")) } } },
      "/v1/maintenance/reclaim": { post: { summary: "Reclaim on-chain charges of expired, unused standard-x402 pre-approvals (safe to run on a schedule)", security: admin, requestBody: json({ type: "object", properties: { principalId: { type: "string" } } }), responses: { 200: json(obj("reclaimed, results[], pending")) } } },
      "/v1/killswitch": { post: { summary: "Engage or clear the kill switch (gateway + on-chain pause; unpause needs the owner)", security: admin, requestBody: json({ type: "object", required: ["principalId", "on"], properties: { principalId: { type: "string" }, on: { type: "boolean" }, reason: { type: "string" } } }), responses: { 200: json(obj("on, txHash, onchain, receipt")) } } },
      "/facilitator/supported": { get: { summary: "x402 facilitator: supported kinds", responses: { 200: json(obj("kinds[]")) } } },
      "/facilitator/verify": { post: { summary: "x402 facilitator: verify a payment payload (standard EIP-3009 or agent-account)", requestBody: json({ type: "object", required: ["paymentPayload", "paymentRequirements"], properties: { paymentPayload: { $ref: "#/components/schemas/X402PaymentPayload" }, paymentRequirements: { $ref: "#/components/schemas/X402Requirements" } } }), responses: { 200: json(obj("isValid, invalidReason, payer")) } } },
      "/facilitator/settle": { post: { summary: "x402 facilitator: settle a verified payload on-chain", requestBody: json({ type: "object", required: ["paymentPayload", "paymentRequirements"], properties: { paymentPayload: { $ref: "#/components/schemas/X402PaymentPayload" }, paymentRequirements: { $ref: "#/components/schemas/X402Requirements" } } }), responses: { 200: json(obj("success, transaction, network, payer, errorReason")) } } },
    },
  };
}
