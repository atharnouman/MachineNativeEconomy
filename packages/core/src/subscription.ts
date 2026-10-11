import { z } from "zod";
import { DurationSchema } from "./time.js";

/**
 * A subscription is a standing authorization the gateway holds on behalf of an agent: the payee may charge it
 * on a cadence, within caps, and every charge is policy-evaluated and settled on-chain by the gateway.
 *
 *   fixed   — the same amount each cycle (a feed, a seat, a quota)
 *   metered — up to `amountPerCharge` each cycle, computed from usage (`units × unitPrice`): a stream
 *
 * The payee calls `chargeUrl` with the charge token; the gateway answers with the settlement or a refusal
 * (too early, exhausted, cancelled, denied by policy). The agent can cancel at any time.
 */

export const SubscriptionTermsSchema = z.object({
  kind: z.enum(["fixed", "metered"]),
  /** base units; fixed: the exact amount per charge; metered: the maximum per charge */
  amountPerCharge: z.string().regex(/^\d+$/),
  /** minimum time between charges */
  interval: DurationSchema,
  maxCharges: z.number().int().positive().optional(),
  /** base units, lifetime of the subscription */
  maxTotal: z.string().regex(/^\d+$/).optional(),
  expiresAt: z.string().datetime(),
  /** metered only */
  unit: z.string().optional(),
  unitPrice: z.string().regex(/^\d+$/).optional(),
});
export type SubscriptionTerms = z.infer<typeof SubscriptionTermsSchema>;

/** What a payee advertises in its MPP challenge for a subscribable resource. */
export const SubscriptionOfferSchema = z.object({
  kind: z.enum(["fixed", "metered"]),
  amountPerCharge: z.string().regex(/^\d+$/),
  interval: DurationSchema,
  maxCharges: z.number().int().positive().optional(),
  unit: z.string().optional(),
  unitPrice: z.string().regex(/^\d+$/).optional(),
  description: z.string().optional(),
});
export type SubscriptionOffer = z.infer<typeof SubscriptionOfferSchema>;

export const SubscriptionStatusSchema = z.enum(["active", "cancelled", "exhausted", "expired"]);

export const SubscriptionSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  principalId: z.string().min(1),
  agentId: z.string().min(1),
  credentialId: z.string().min(1),
  payee: z.object({ url: z.string().url(), host: z.string(), address: z.string() }),
  resource: z.string(),
  purpose: z.string(),
  token: z.string(),
  chain: z.string(),
  terms: SubscriptionTermsSchema,
  /** sha256 of the charge token handed to the payee (the token itself is never stored) */
  chargeTokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  chargeUrl: z.string().url(),
  status: SubscriptionStatusSchema,
  createdAt: z.string().datetime(),
  lastChargedAt: z.string().datetime().optional(),
  charges: z.number().int().nonnegative(),
  totalCharged: z.string().regex(/^\d+$/),
  cancelledAt: z.string().datetime().optional(),
  /** the payee-side id acknowledged in the first Payment-Receipt */
  payeeSubscriptionId: z.string().optional(),
  /** refused charge calls since the last receipted refusal (receipts are throttled to one per interval) */
  refusals: z.number().int().nonnegative().optional(),
  lastRefusedAt: z.string().datetime().optional(),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

/** The agent's request to subscribe: caps it is willing to accept (the payee's offer must fit inside). */
export const SubscribeRequestSchema = z.object({
  url: z.string().url(),
  purpose: z.string().min(1),
  maxAmountPerCharge: z.string().regex(/^\d+(\.\d+)?$/), // human units
  maxCharges: z.number().int().positive().optional(),
  maxTotal: z.string().regex(/^\d+(\.\d+)?$/).optional(), // human units
  expiresAt: z.string().datetime().optional(), // default: 30 days
});
export type SubscribeRequest = z.infer<typeof SubscribeRequestSchema>;

/** The payee's charge call. */
export const ChargeRequestSchema = z.object({
  /** metered: usage units this cycle (amount = units × unitPrice) */
  units: z.number().int().nonnegative().optional(),
  /** or an explicit amount in base units (metered only; must be ≤ amountPerCharge) */
  amount: z.string().regex(/^\d+$/).optional(),
  reference: z.string().max(200).optional(),
});
export type ChargeRequest = z.infer<typeof ChargeRequestSchema>;

/** Public view for receipts and the agent: no token hash. */
export function subscriptionPublic(s: Subscription) {
  const { chargeTokenHash: _h, ...rest } = s;
  return rest;
}
