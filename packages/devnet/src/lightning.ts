import type { LightningBackend, LightningNode, DecodedInvoice } from "@apgw/core";
import { randomPreimage } from "@apgw/core";

/**
 * An in-memory Lightning "network" for demos and tests: invoices are created by the payee side and paid by the
 * gateway side against the same instance. Invoices are encoded as `lnbcmock1<base64url json>` so they decode
 * without a BOLT11 library. Nothing here touches a real node.
 */
export class MockLightning implements LightningBackend, LightningNode {
  private readonly invoices = new Map<string, { preimage: string; amountSats: bigint; description?: string; expiresAt: string; paid: boolean }>();
  /** Sats the gateway side has "spent" (mock wallet accounting). */
  paidSats = 0n;

  async createInvoice(args: { amountSats: bigint; description?: string; ttlSeconds?: number }): Promise<{ bolt11: string; paymentHash: string }> {
    const { preimage, paymentHash } = randomPreimage();
    const expiresAt = new Date(Date.now() + (args.ttlSeconds ?? 600) * 1000).toISOString();
    this.invoices.set(paymentHash, { preimage, amountSats: args.amountSats, description: args.description, expiresAt, paid: false });
    const body = Buffer.from(JSON.stringify({ paymentHash, amountSats: args.amountSats.toString(), description: args.description, expiresAt }), "utf8").toString("base64url");
    return { bolt11: `lnbcmock1${body}`, paymentHash };
  }

  decodeInvoice(bolt11: string): DecodedInvoice {
    if (!bolt11.startsWith("lnbcmock1")) throw new Error("not a mock invoice");
    const j = JSON.parse(Buffer.from(bolt11.slice("lnbcmock1".length), "base64url").toString("utf8")) as { paymentHash: string; amountSats: string; description?: string; expiresAt: string };
    return { paymentHash: j.paymentHash, amountSats: BigInt(j.amountSats), description: j.description, expiresAt: j.expiresAt };
  }

  async payInvoice(bolt11: string): Promise<{ preimage: string; paymentHash: string; amountSats: bigint }> {
    const d = this.decodeInvoice(bolt11);
    const inv = this.invoices.get(d.paymentHash);
    if (!inv) throw new Error("unknown invoice (different mock network?)");
    if (new Date(inv.expiresAt).getTime() < Date.now()) throw new Error("invoice expired");
    if (inv.paid) throw new Error("invoice already paid");
    inv.paid = true;
    this.paidSats += inv.amountSats;
    return { preimage: inv.preimage, paymentHash: d.paymentHash, amountSats: inv.amountSats };
  }

  isPaid(paymentHash: string): boolean {
    return this.invoices.get(paymentHash)?.paid ?? false;
  }
}
