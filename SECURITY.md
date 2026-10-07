# Security

**Status: Phase 0, unaudited, local-chain only. Do not use with real funds.**

## Reporting
Open a private security advisory on the repository or email the maintainer listed in `package.json`. Please do not file public issues for vulnerabilities.

## Model
See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md). In one line: the model never signs; the gateway decides; the chain is the backstop.

## Keys
| Key | Where | Purpose |
|---|---|---|
| Gateway key | gateway signer (dev: env; prod: KMS/HSM) | signs receipts, operates accounts, relays |
| Session-key secret | gateway signer | derives one session key per credential (HMAC) |
| Credential root key | gateway | HMAC root of credential chains |
| Account owner key | the principal (dev: = gateway key) | grants sessions, pause, treasury |
| Payee relayer key | payee | gas for MPP settlement only |

Rotating the session-key secret invalidates every on-chain session (keys change); re-register credentials.

## Before mainnet (v0.2 blockers)
Third-party audit of `packages/contracts`; Slither/Aderyn clean in CI; confirmation-depth handling; signed policy versions; revocation list; rate limits on the API; RFC 9421 request signing.
