import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client";

/** Prometheus metrics, one registry per gateway instance (so tests and demos can run several). */
export class Metrics {
  readonly registry = new Registry();
  readonly payments: Counter<"rail" | "outcome" | "payload_kind">;
  readonly denials: Counter<"reason">;
  readonly approvals: Counter<"event">;
  readonly receipts: Counter<"kind">;
  readonly paymentSeconds: Histogram<"rail" | "outcome">;
  readonly pendingApprovals: Gauge<string>;
  readonly httpRequests: Counter<"route" | "status">;

  constructor(opts: { defaultMetrics?: boolean } = {}) {
    if (opts.defaultMetrics) collectDefaultMetrics({ register: this.registry, prefix: "apgw_" });
    this.payments = new Counter({ name: "apgw_payments_total", help: "Payment attempts by rail, outcome and x402 payload kind", labelNames: ["rail", "outcome", "payload_kind"], registers: [this.registry] });
    this.denials = new Counter({ name: "apgw_denials_total", help: "Denied payments by first reason code", labelNames: ["reason"], registers: [this.registry] });
    this.approvals = new Counter({ name: "apgw_approvals_total", help: "Approval events (requested, granted, rejected, expired, consumed)", labelNames: ["event"], registers: [this.registry] });
    this.receipts = new Counter({ name: "apgw_receipts_total", help: "Receipts appended by kind", labelNames: ["kind"], registers: [this.registry] });
    this.paymentSeconds = new Histogram({ name: "apgw_payment_duration_seconds", help: "End-to-end pay() duration", labelNames: ["rail", "outcome"], buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30], registers: [this.registry] });
    this.pendingApprovals = new Gauge({ name: "apgw_pending_approvals", help: "Approvals currently pending", registers: [this.registry] });
    this.httpRequests = new Counter({ name: "apgw_http_requests_total", help: "Gateway API requests by route and status", labelNames: ["route", "status"], registers: [this.registry] });
  }

  payment(rail: string, outcome: string, payloadKind: string, seconds: number) {
    this.payments.inc({ rail, outcome, payload_kind: payloadKind });
    this.paymentSeconds.observe({ rail, outcome }, seconds);
  }

  text(): Promise<string> {
    return this.registry.metrics();
  }
}
