# ADR-0012: Prometheus metrics, structured logs and a generated OpenAPI document

**Status:** accepted (Phase 1, milestone 1.10)

## Context
An operator needs to see payment outcomes, denial reasons and approval backlog without reading receipts, and integrators need a machine-readable API description.

## Decision
* **Metrics** (prom-client, one registry per gateway instance so demos and tests can run several): `spendmarshal_payments_total{rail,outcome,payload_kind}`, `spendmarshal_payment_duration_seconds{rail,outcome}`, `spendmarshal_denials_total{reason}` (first reason code, trimmed to its family), `spendmarshal_approvals_total{event}`, `spendmarshal_pending_approvals`, `spendmarshal_receipts_total{kind}`, `spendmarshal_http_requests_total{route,status}`; Node default metrics behind a flag. Served at `/metrics` without authentication, as Prometheus scrapers expect; it carries no secrets and no per-intent data.
* **Logs**: Fastify's pino logger, off by default for demos, enabled with a level; `Authorization`, `x-admin-token`, `Signature` and `Signature-Input` are redacted.
* **OpenAPI 3.1**: built from the same zod schemas the routes validate (`zod-to-json-schema`), served at `/openapi.json` and exported to `docs/openapi.json` by `scripts/gen-openapi.mjs`. Security schemes document the bearer credential (plus the holder signature when bound) and the admin token.

Rejected for now: OpenTelemetry tracing (the SDK and auto-instrumentation add more weight than the rest of the gateway; revisit when there is a collector to send to); `@fastify/swagger` (the route schemas are zod, not JSON Schema, so the document is assembled directly).

## Consequences
* A dashboard can show settled vs denied vs pending payments per rail and the top denial reasons within minutes of deployment.
* The OpenAPI document is regenerated from code, so it cannot drift from the validators.
* Metrics are per process; a multi-instance deployment aggregates them in Prometheus as usual.
