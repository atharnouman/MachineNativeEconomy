# ADR-0011: RFC 9421 signatures, outbound as a Web Bot Auth agent and inbound as holder-bound credentials

**Status:** accepted (Phase 1, milestone 1.8)

## Context
Merchants cannot tell a governed agent from an anonymous bot, so most agent-initiated requests are declined or rate-limited. Visa's Trusted Agent Protocol and Cloudflare's Web Bot Auth both answer this with RFC 9421 HTTP Message Signatures over the request, Ed25519 keys, and a key directory at a well-known URL. On the agent side, a bearer credential that leaks (logs, a compromised framework, a shared prompt) can be used by anyone who holds it.

## Decision
One signature module in core (`httpsig.ts`): RFC 9421 signature base, `Signature-Input` / `Signature` headers, RFC 9530 `Content-Digest`, Ed25519 via Node's crypto, RFC 7638 thumbprints as key ids, a bounded nonce window for replay.

**Outbound.** Every request the gateway makes to a payee carries `Signature-Agent: "<gateway public URL>"` and a signature over `@authority`, `signature-agent`, `@method`, `@path` (and `content-digest` for bodies) with `tag="web-bot-auth"`. The key is derived deterministically from the gateway's session secret and published, in a response that is itself signed, at `/.well-known/http-message-signatures-directory` (and as a JWK Set at `/.well-known/jwks.json`). The payee middleware can require it (`agentAuth.require`), answers unsigned callers with 401 and `Accept-Signature`, resolves keys from the caller's directory with caching, and passes the agent identity to `onSettled`.

**Inbound.** A credential may carry a `holder_key` caveat (Ed25519 public JWK). Requests using it must be signed by that key with `tag="apgw-holder"` over `@method`, `@authority`, `@path` and `content-digest`. The binding is positional: a delegation may bind the sub-agent to its own key, and a binding can be replaced but never removed (verifier and property test). The SDK signs transparently when given the private key; `delegate({ bindTo: "new" })` generates and binds a fresh key.

Rejected: mTLS (poor fit for agent frameworks and proxies); JWT bearer with `cnf` (adds a token layer on top of the credential chain); signing only the bearer token (does not cover the request, so a replayed body still works).

## Consequences
* A payee can serve governed agents only, and knows which gateway stood behind each payment.
* A stolen holder-bound credential yields 401 at the gateway: nothing is signed, nothing is paid, and the attempt is visible in the gateway's metrics.
* Clock skew of up to 60 seconds and a 120-second holder signature lifetime are tolerated; the nonce window is per process and bounded, so replay protection is best-effort across restarts (receipts remain the audit record).
* The directory signature covers `@authority` only, as in the Web Bot Auth draft; pinning the key out of band is still the stronger option for high-value payees.
