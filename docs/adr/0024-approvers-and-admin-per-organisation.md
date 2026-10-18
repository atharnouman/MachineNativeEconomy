# ADR-0024: Approvers and admin tokens per organisation

Date: 18 October 2026. Status: proposed.

## Context

A gateway that serves several principals (organisations) had one approver map and one admin token for all of them. The
review behind ADR-0022 said that a hosted multi-tenant gateway is not honest without per-principal approvers and admin
scope.

1. **Every approver could approve every principal's escalations.** `ApprovalService.resolve` looked the approver up in
   the gateway-wide `approvers` map, whatever principal the approval belonged to. And since ADR-0019, every principal's
   chain registered every approver.
2. **One admin token acted on every principal.** Its holder could issue credentials, change policies, resolve approvals,
   cancel subscriptions, append external receipts, export evidence, anchor and pull the kill switch for every tenant.
3. **The token comparison was not constant-time.** It was a plain string comparison.

## Decisions

1. **A principal may have its own approvers.**
   - `principals[id].approvers` replaces the gateway-wide `approvers` for that principal.
   - Without one, the principal keeps the gateway-wide map, so a single-tenant configuration behaves exactly as before.
   - `approversFor(cfg, principalId)` is the one lookup: `ApproverKeys` registers those approvers in the principal's
     chain (ADR-0019), `resolve` accepts a signature only from one of them, and the evidence export lists them.
   - The lookup uses own properties only, so an approver id such as `constructor` resolves to nothing.
   - An approver address that is not an address stops the gateway before anything is receipted. The error names the
     approver and the principal.
2. **A principal may have its own admin token.**
   - `principals[id].adminToken` acts on that principal only, on every admin route that names one: credentials,
     policies, approvals, subscriptions, external receipts, evidence, anchors, per-principal reclaim and the kill switch.
   - The gateway-wide `adminToken` keeps access to every principal, and alone may run the reclaim job for all principals
     at once.
   - A token that matches nothing gets 401. A principal's token used on another principal gets 403
     (`this admin token acts on acme only`).
   - For a resolution, the approval's principal is read from the store before anything changes. An approval can expire
     with a receipt when it is read, and that must not happen for a caller who turns out to have no access.
3. **Tokens are compared in constant time, and must be distinct.**
   - Each comparison uses `timingSafeEqual`.
   - At startup, before the store opens, the gateway refuses a principal's token that is shorter than 16 characters, or
     the same as the gateway-wide token or another principal's. The error names the principals, never the token.
4. **Signed approvals, policy evaluation and evidence are unchanged.** `requireSignedApprovals` stays gateway-wide.

Rejected:

- **Gateway-wide approvers as a fallback when a principal's own approver has no key.** A principal that lists its own
  approvers must be able to rely on nobody else resolving its approvals.
- **Hashed or per-route admin credentials, or signed admin requests.** They are possible later. A per-principal token
  that is compared safely and checked against the request's principal closes the cross-tenant gap now.
- **A per-principal `requireSignedApprovals`.** Nothing needs it yet.

## Consequences

- One gateway can serve several organisations without any of their approvers or admins acting on another's payments,
  approvals or evidence.
- Moving a principal from the gateway-wide approvers to its own is an ordinary key change in its chain (ADR-0019):
  approvers it no longer has are receipted as removed, and new ones as registered.
- The admin routes that accepted only the gateway-wide token now also accept the principal's token for that principal.
  A request that sends an `x-admin-token` header to the subscription routes is treated as an admin request: a wrong
  token is refused, where it used to fall through to the credential path.
- `/metrics` stays unauthenticated. Its counters are gateway-wide and carry no principal labels.
- Not in this change: a hosted gateway still runs as one instance on the json or sqlite store. The roadmap's Postgres
  driver, for multi-instance deployments, is separate work.
- Tests, in both store drivers:
  - Two principals register only their own approvers. An approver of one principal cannot resolve the other's approvals,
    even under the same approver name.
  - A principal that moves from the gateway-wide approvers to its own gets a key change and a removal in its chain, and
    its bundle verifies.
  - The `constructor` approver id is refused, and each bundle lists and verifies its own approvers.
  - A principal's token reaches its own approvals, evidence and per-principal reclaim, and gets 403 on everything of the
    other principal's. Another principal's pending approval stays pending.
  - No token or an unknown token gets 401, and the gateway-wide token reaches both principals.
  - Short, shared or operator-equal tokens and malformed approver addresses stop the gateway.
