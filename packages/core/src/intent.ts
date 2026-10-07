import { z } from "zod";
import { AmountSchema } from "./amount.js";
import { RailSchema } from "./credential.js";
import { hashJson } from "./canonical.js";

/** The one canonical object every rail adapter consumes. Rails never see anything else. */
export const PaymentIntentSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  principalId: z.string().min(1),
  agentId: z.string().min(1),
  credentialId: z.string().min(1),
  payee: z.object({
    url: z.string().url(),
    host: z.string().min(1),
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(), // known after the 402 quote
  }),
  resource: z.string().min(1), // path + query of the resource being bought
  maxAmount: AmountSchema, // the agent's ceiling
  quotedAmount: AmountSchema.optional(), // what the payee asked for (from the 402)
  purpose: z.string().min(1),
  rail: z.union([RailSchema, z.literal("auto")]),
  createdAt: z.string().datetime(),
});
export type PaymentIntent = z.infer<typeof PaymentIntentSchema>;

/** Binds the on-chain authorization to the off-chain intent (stored in PaymentAuthorization.intentHash). */
export function intentHash(intent: PaymentIntent): `0x${string}` {
  return hashJson(intent);
}
