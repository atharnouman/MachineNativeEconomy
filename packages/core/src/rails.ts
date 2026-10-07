import { z } from "zod";
import { b64decode, b64encode } from "./canonical.js";

/**
 * Wire formats for the two HTTP-402 rails implemented in the thin slice.
 *
 * x402 V2 (Linux Foundation): headers PAYMENT-REQUIRED (server -> client, base64 JSON),
 *   PAYMENT-SIGNATURE (client -> server, base64 JSON), PAYMENT-RESPONSE (server -> client, base64 JSON).
 *   Settlement goes through a facilitator (/verify, /settle, /supported).
 *
 * MPP (Stripe/Tempo, IETF draft-ryan-httpauth-payment): `WWW-Authenticate: Payment <params>` challenge,
 *   `Authorization: Payment <credential>` response, `Payment-Receipt` header on success. The payee settles.
 *
 * Both carry the same on-chain object: a PaymentAuthorization signed by a session key of an AgentAccount
 * (scheme "exact", payload kind "agent-account"). The standard EIP-3009 payload kind is also accepted by the
 * facilitator for plain EOAs.
 */

export const X402_HEADERS = {
  required: "payment-required",
  signature: "payment-signature",
  response: "payment-response",
} as const;

export const MPP_HEADERS = {
  challenge: "www-authenticate",
  credential: "authorization",
  receipt: "payment-receipt",
} as const;

export const AuthorizationPayloadSchema = z.object({
  kind: z.literal("agent-account"),
  account: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  authorization: z.object({
    token: z.string(),
    to: z.string(),
    amount: z.string().regex(/^\d+$/),
    intentHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    validAfter: z.string().regex(/^\d+$/),
    validBefore: z.string().regex(/^\d+$/),
    nonce: z.string().regex(/^0x[0-9a-f]{64}$/),
  }),
  signature: z.string().regex(/^0x[0-9a-f]+$/),
});
export type AuthorizationPayload = z.infer<typeof AuthorizationPayloadSchema>;

export const Eip3009PayloadSchema = z.object({
  kind: z.literal("eip3009"),
  authorization: z.object({
    from: z.string(),
    to: z.string(),
    value: z.string().regex(/^\d+$/),
    validAfter: z.string().regex(/^\d+$/),
    validBefore: z.string().regex(/^\d+$/),
    nonce: z.string().regex(/^0x[0-9a-f]{64}$/),
  }),
  signature: z.string().regex(/^0x[0-9a-f]+$/),
});

export const PaymentPayloadSchema = z.discriminatedUnion("kind", [AuthorizationPayloadSchema, Eip3009PayloadSchema]);
export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>;

// ───────────────────────────── x402 ─────────────────────────────

export const X402AcceptSchema = z.object({
  scheme: z.literal("exact"),
  network: z.string().regex(/^eip155:\d+$/),
  amount: z.string().regex(/^\d+$/),
  asset: z.string(), // token address
  payTo: z.string(),
  maxTimeoutSeconds: z.number().int().positive(),
  resource: z.object({ url: z.string(), description: z.string().optional() }),
  extra: z.record(z.unknown()).optional(),
});
export const X402RequiredSchema = z.object({
  x402Version: z.literal(2),
  accepts: z.array(X402AcceptSchema).min(1),
  error: z.string().optional(),
});
export type X402Required = z.infer<typeof X402RequiredSchema>;

export const X402SignatureSchema = z.object({
  x402Version: z.literal(2),
  scheme: z.literal("exact"),
  network: z.string(),
  payload: PaymentPayloadSchema,
});
export type X402Signature = z.infer<typeof X402SignatureSchema>;

export const X402ResponseSchema = z.object({
  success: z.boolean(),
  transaction: z.string().optional(),
  network: z.string(),
  payer: z.string().optional(),
  errorReason: z.string().optional(),
});
export type X402Response = z.infer<typeof X402ResponseSchema>;

export const encodeX402 = b64encode;
export function decodeX402<T extends z.ZodTypeAny>(schema: T, header: string | undefined): z.infer<T> | null {
  if (!header) return null;
  try {
    return schema.parse(b64decode(header));
  } catch {
    return null;
  }
}

// ───────────────────────────── MPP ─────────────────────────────

export const MppMethodSchema = z.object({
  method: z.literal("evm-agent-account"),
  chain: z.string().regex(/^eip155:\d+$/),
  token: z.string(),
  amount: z.string().regex(/^\d+$/),
  payTo: z.string(),
});
export const MppChallengeSchema = z.object({
  id: z.string().min(1),
  realm: z.string(),
  expiresAt: z.string().datetime(),
  description: z.string().optional(),
  methods: z.array(MppMethodSchema).min(1),
});
export type MppChallenge = z.infer<typeof MppChallengeSchema>;

export const MppCredentialSchema = z.object({
  challengeId: z.string(),
  method: z.literal("evm-agent-account"),
  payload: AuthorizationPayloadSchema,
});
export type MppCredential = z.infer<typeof MppCredentialSchema>;

export const MppReceiptSchema = z.object({
  challengeId: z.string(),
  chain: z.string(),
  txHash: z.string(),
  amount: z.string(),
  payer: z.string(),
  settledAt: z.string().datetime(),
});
export type MppReceipt = z.infer<typeof MppReceiptSchema>;

/** `WWW-Authenticate: Payment realm="...", challenge="<base64>"` */
export function encodeMppChallengeHeader(c: MppChallenge): string {
  return `Payment realm="${c.realm}", challenge="${b64encode(c)}"`;
}
export function decodeMppChallengeHeader(h: string | undefined): MppChallenge | null {
  if (!h) return null;
  const m = /challenge="([^"]+)"/.exec(h);
  if (!m || !/^Payment\b/i.test(h)) return null;
  try {
    return MppChallengeSchema.parse(b64decode(m[1]!));
  } catch {
    return null;
  }
}
/** `Authorization: Payment <base64>` */
export function encodeMppCredentialHeader(c: MppCredential): string {
  return `Payment ${b64encode(c)}`;
}
export function decodeMppCredentialHeader(h: string | undefined): MppCredential | null {
  if (!h) return null;
  const m = /^Payment\s+([A-Za-z0-9+/=]+)$/.exec(h.trim());
  if (!m) return null;
  try {
    return MppCredentialSchema.parse(b64decode(m[1]!));
  } catch {
    return null;
  }
}
export const encodeMppReceipt = b64encode;
export function decodeMppReceipt(h: string | undefined): MppReceipt | null {
  if (!h) return null;
  try {
    return MppReceiptSchema.parse(b64decode(h));
  } catch {
    return null;
  }
}
