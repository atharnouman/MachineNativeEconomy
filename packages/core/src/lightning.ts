import { createHash, createHmac, randomBytes } from "node:crypto";

/**
 * Lightning (L402) abstractions. The gateway pays invoices through a `LightningBackend`; a payee mints
 * invoices and verifies preimages through a `LightningNode`. Real implementations wrap LND / CLN / an LSP;
 * `MockLightning` in @spendmarshal/devnet implements both against an in-memory ledger for demos and tests.
 *
 * Proof of payment is the preimage: sha256(preimage) == invoice.paymentHash. The gateway checks that itself,
 * so it never has to trust the payee's word, exactly as it confirms EVM settlements on-chain.
 */

export interface DecodedInvoice {
  paymentHash: string; // hex, 32 bytes
  amountSats: bigint;
  description?: string;
  expiresAt?: string;
}

export interface LightningBackend {
  decodeInvoice(bolt11: string): DecodedInvoice;
  payInvoice(bolt11: string): Promise<{ preimage: string; paymentHash: string; amountSats: bigint }>;
}

export interface LightningNode {
  createInvoice(args: { amountSats: bigint; description?: string; ttlSeconds?: number }): Promise<{ bolt11: string; paymentHash: string }>;
  decodeInvoice(bolt11: string): DecodedInvoice;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(typeof data === "string" ? Buffer.from(data, "hex") : data).digest("hex");
}

export function preimageMatches(preimageHex: string, paymentHashHex: string): boolean {
  return /^[0-9a-f]{64}$/i.test(preimageHex) && sha256Hex(preimageHex) === paymentHashHex.toLowerCase();
}

/**
 * The L402 "macaroon" a payee mints: binds the payment hash and an expiry under the payee's secret. A full
 * macaroon library would allow caveats; this HMAC token is enough to make the authorization unforgeable and
 * payment-specific.
 */
export function mintL402Macaroon(secret: string, paymentHash: string, ttlSeconds = 600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = createHmac("sha256", secret).update(`${paymentHash}|${exp}`).digest("base64url");
  return Buffer.from(JSON.stringify({ v: 1, paymentHash, exp, sig }), "utf8").toString("base64url");
}

export function verifyL402Macaroon(secret: string, macaroon: string): { ok: true; paymentHash: string } | { ok: false; reason: string } {
  try {
    const m = JSON.parse(Buffer.from(macaroon, "base64url").toString("utf8")) as { v: number; paymentHash: string; exp: number; sig: string };
    if (m.v !== 1 || !m.paymentHash || !m.exp || !m.sig) return { ok: false, reason: "malformed macaroon" };
    if (m.exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: "macaroon expired" };
    const expected = createHmac("sha256", secret).update(`${m.paymentHash}|${m.exp}`).digest("base64url");
    if (expected !== m.sig) return { ok: false, reason: "macaroon signature invalid" };
    return { ok: true, paymentHash: m.paymentHash.toLowerCase() };
  } catch {
    return { ok: false, reason: "malformed macaroon" };
  }
}

export function randomPreimage(): { preimage: string; paymentHash: string } {
  const preimage = randomBytes(32).toString("hex");
  return { preimage, paymentHash: sha256Hex(preimage) };
}
