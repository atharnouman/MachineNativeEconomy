import { z } from "zod";
import { b64decode, b64encode } from "./canonical.js";
import { SubscriptionOfferSchema, SubscriptionTermsSchema } from "./subscription.js";

/**
 * Wire formats for the two HTTP-402 rails implemented so far.
 *
 * x402 V2 (Linux Foundation): headers PAYMENT-REQUIRED (server -> client, base64 JSON),
 *   PAYMENT-SIGNATURE (client -> server, base64 JSON), PAYMENT-RESPONSE (server -> client, base64 JSON).
 *   Settlement goes through a facilitator (/verify, /settle, /supported).
 *
 * MPP (Stripe/Tempo, IETF draft-ryan-httpauth-payment): `WWW-Authenticate: Payment <params>` challenge,
 *   `Authorization: Payment <credential>` response, `Payment-Receipt` header on success. The payee settles.
 *
 * Two payload shapes travel over x402's `exact` scheme:
 *   - the **standard** EIP-3009 payload every x402 facilitator understands: `{ signature, authorization:
 *     { from, to, value, validAfter, validBefore, nonce } }`. The payer is either a plain EOA (ECDSA) or an
 *     AgentAccount that pre-approved the digest and answers ERC-1271 (see `approveAuthorization`).
 *   - the **agent-account** payload (`kind: "agent-account"`): a session-key-signed `PaymentAuthorization`
 *     settled with one call to `AgentAccount.payWithAuthorization`. Cheaper (one transaction) but needs a
 *     facilitator that knows the account, such as the one bundled with the gateway.
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

const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const Uint = z.string().regex(/^\d+$/);
const B32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const HexBytes = z.string().regex(/^0x[0-9a-fA-F]*$/);

export const AuthorizationPayloadSchema = z.object({
  kind: z.literal("agent-account"),
  account: Address,
  authorization: z.object({
    token: Address,
    to: Address,
    amount: Uint,
    intentHash: B32,
    validAfter: Uint,
    validBefore: Uint,
    nonce: B32,
  }),
  signature: HexBytes,
});
export type AuthorizationPayload = z.infer<typeof AuthorizationPayloadSchema>;

/** The standard x402 `exact` EVM payload (EIP-3009). */
export const X402StandardPayloadSchema = z.object({
  signature: HexBytes,
  authorization: z.object({
    from: Address,
    to: Address,
    value: Uint,
    validAfter: Uint,
    validBefore: Uint,
    nonce: B32,
  }),
});
export type X402StandardPayload = z.infer<typeof X402StandardPayloadSchema>;

export const PaymentPayloadSchema = z.union([AuthorizationPayloadSchema, X402StandardPayloadSchema]);
export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>;

export function isAgentAccountPayload(p: PaymentPayload): p is AuthorizationPayload {
  return (p as AuthorizationPayload).kind === "agent-account";
}

// ───────────────────────────── x402 ─────────────────────────────

export const X402AcceptSchema = z.object({
  scheme: z.literal("exact"),
  network: z.string().regex(/^eip155:\d+$/),
  amount: Uint,
  asset: z.string(), // token address
  payTo: z.string(),
  maxTimeoutSeconds: z.number().int().positive(),
  resource: z.object({ url: z.string(), description: z.string().optional() }),
  /** Standard x402 carries the token's EIP-712 domain here: `{ name, version }`. */
  extra: z.record(z.unknown()).optional(),
});
export type X402Accept = z.infer<typeof X402AcceptSchema>;
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
  amount: Uint,
  payTo: z.string(),
  /** Present when the resource can be subscribed to (recurring or metered charges). */
  subscription: SubscriptionOfferSchema.optional(),
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
  /** Opens a subscription with the first charge: where and how the payee may charge next. */
  subscription: z
    .object({
      id: z.string(),
      chargeUrl: z.string().url(),
      token: z.string(),
      terms: SubscriptionTermsSchema,
    })
    .optional(),
});
export type MppCredential = z.infer<typeof MppCredentialSchema>;

export const MppReceiptSchema = z.object({
  challengeId: z.string(),
  chain: z.string(),
  txHash: z.string(),
  amount: z.string(),
  payer: z.string(),
  settledAt: z.string().datetime(),
  subscriptionId: z.string().optional(),
});
export type MppReceipt = z.infer<typeof MppReceiptSchema>;

// ───────────────────────────── L402 (Lightning) ─────────────────────────────

/** `WWW-Authenticate: L402 macaroon="<token>", invoice="<bolt11>"` (may be joined with other challenges). */
export function encodeL402ChallengeHeader(macaroon: string, invoice: string): string {
  return `L402 macaroon="${macaroon}", invoice="${invoice}"`;
}
export function decodeL402ChallengeHeader(h: string | undefined): { macaroon: string; invoice: string } | null {
  if (!h) return null;
  const m = /L402\s+macaroon="([^"]+)",\s*invoice="([^"]+)"/i.exec(h);
  return m ? { macaroon: m[1]!, invoice: m[2]! } : null;
}
/** `Authorization: L402 <macaroon>:<preimage hex>` */
export function encodeL402AuthorizationHeader(macaroon: string, preimage: string): string {
  return `L402 ${macaroon}:${preimage}`;
}
export function decodeL402AuthorizationHeader(h: string | undefined): { macaroon: string; preimage: string } | null {
  if (!h) return null;
  const m = /^L402\s+([A-Za-z0-9_\-=]+):([0-9a-fA-F]{64})$/.exec(h.trim());
  return m ? { macaroon: m[1]!, preimage: m[2]!.toLowerCase() } : null;
}

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
