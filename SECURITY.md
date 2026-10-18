# Security

**Status: Phase 0, unaudited, local-chain only. Do not use with real funds.**

## Reporting
Open a private security advisory on the repository or email the maintainer listed in `package.json`. Please do not file public issues for vulnerabilities.

## Model
See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md). In one line: the model never signs; the gateway decides; the chain is the backstop.

## Keys
| Key | Where | Purpose |
|---|---|---|
| Gateway key | gateway signer (dev: env; prod: KMS/HSM) | operates accounts, holds the root session, relays, sends anchors; signs receipts unless an evidence key is set |
| Evidence key (optional, ADR-0023) | gateway signer (prod: KMS/HSM) | signs receipts only; never transacts, so it needs no funds and stays put while the gateway key changes |
| Session-key secret | gateway signer | derives one session key per credential (HMAC) |
| Credential root key | gateway | HMAC root of credential chains |
| Admin tokens | gateway config: one gateway-wide, optionally one per principal | the gateway-wide token administers every principal; a principal's own token only that principal (ADR-0024). At least 16 characters, all distinct, compared in constant time |
| Account owner key | the principal (dev: = gateway key) | grants sessions, pause, treasury |
| Payee relayer key | payee | gas for MPP settlement only |
| Gateway Ed25519 signing key | derived from the session-key secret | signs outbound requests to payees (Web Bot Auth) and the key directory; published as a public JWK |
| Holder keys | the agent process that owns a holder-bound credential | proves possession on every gateway request; never sent to the gateway |

Rotating the session-key secret invalidates every on-chain session (keys change); re-register credentials.

Rotating the gateway key: start the gateway with the new key and the old one in `SPENDMARSHAL_PREVIOUS_GATEWAY_PRIVATE_KEYS`. Before it serves, every configured principal's receipt chain records the change, with the old key's handover signature; any other chain records it with its next receipt. Then remove the old key from the configuration and destroy it. Without the old key, declare its address in `SPENDMARSHAL_PREVIOUS_GATEWAY_ADDRESSES`: the change is then recorded without a handover, and auditors must pin both keys. The gateway refuses to continue any chain signed by a key it neither holds nor was told about (ADR-0020, ADR-0022). The new key also needs its own root session from each account owner (in dev mode, ownership). With a separate evidence key (`SPENDMARSHAL_EVIDENCE_PRIVATE_KEY`), rotating the gateway key leaves every receipt chain alone, and this paragraph applies to rotating the evidence key instead.

## Operating modes
* **Dev (`ownerIsGateway: true`)**: the gateway key owns the account. Convenient, and the gateway can lose everything in the account.
* **Bounded operator (`ownerIsGateway: false`)**: the owner grants the gateway a root session with a cap, per-transaction limit, payee allowlist and expiry. Every credential the gateway registers is a child of that session. A compromised gateway is limited to that session's remaining cap and cannot unpause the account. Use this for anything beyond a demo.

## EIP-7702 accounts
Delegating an EOA to `AgentAccount` restricts calls *to* the address, not transactions *from* the EOA key: that key remains the owner with full control. Keep it cold (hardware wallet or custody); agents and the gateway only ever hold session credentials.

## Endpoints without authentication
`/healthz`, `/metrics`, `/openapi.json` and the two `/.well-known/*` key endpoints are unauthenticated by design. Metrics are aggregates only; put the gateway behind a network boundary that limits who can scrape them.

## Before mainnet (v0.2 blockers)
Third-party audit of `packages/contracts`; Slither/Aderyn clean in CI; confirmation-depth handling; signed policy versions; revocation list; rate limits on the API; RFC 9421 request signing.
