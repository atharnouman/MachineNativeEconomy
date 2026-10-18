import type { Address, Hex } from "viem";
import type { LightningBackend } from "@spendmarshal/core";

export interface ContractAddresses {
  usdc: Address;
  receiptRegistry: Address;
  enforcers: { spendLimit: Address; timeWindow: Address; allowedTargets: Address };
}

export interface PrincipalConfig {
  /** The AgentAccount holding this principal's funds (standalone contract or an EIP-7702-delegated EOA). */
  account: Address;
  /**
   * true (dev default): the gateway key owns the account and grants root sessions directly.
   * false (production): the owner has granted the gateway key a root session; every credential the gateway
   * registers becomes a child of that session and is bounded by it. Unpausing then needs the owner key.
   */
  ownerIsGateway?: boolean;
  /**
   * This principal's approvers: approver id -> address whose EIP-191 signature resolves its escalations (ADR-0024). When
   * set, it replaces the gateway-wide `approvers` for this principal; nobody else's approvers can resolve its approvals.
   */
  approvers?: Record<string, Address>;
  /**
   * An admin token for this principal only: its credentials, policy, approvals, subscriptions, receipts, evidence,
   * anchors and kill switch (ADR-0024). The gateway-wide `adminToken` keeps access to every principal.
   */
  adminToken?: string;
}

/** The approvers whose signatures resolve a principal's escalations: its own map, else the gateway-wide one (ADR-0024). */
export function approversFor(cfg: Pick<GatewayConfig, "approvers" | "principals">, principalId: string): Record<string, Address> {
  const own = Object.hasOwn(cfg.principals, principalId) ? cfg.principals[principalId]?.approvers : undefined;
  return own ?? cfg.approvers ?? {};
}

/** The key of `approverId` among a principal's approvers, if it is one (never an inherited object property). */
export function approverKeyFor(cfg: Pick<GatewayConfig, "approvers" | "principals">, principalId: string, approverId: string): Address | undefined {
  const approvers = approversFor(cfg, principalId);
  return Object.hasOwn(approvers, approverId) ? approvers[approverId] : undefined;
}

export interface GatewayConfig {
  host: string;
  port: number;
  rpcUrl: string;
  chainId: number;
  /**
   * The gateway's on-chain key: holds the root session, submits sessions and anchors, relays settlements. Dev: also owns
   * the AgentAccount. It also signs receipts unless `evidencePrivateKey` is set.
   */
  gatewayPrivateKey: Hex;
  /**
   * Signs receipts: the evidence key auditors pin (ADR-0023). It never sends a transaction, so it needs no funds, and it
   * stays put while `gatewayPrivateKey` changes. Default: `gatewayPrivateKey`. Setting it on an existing store is a key
   * rotation that the gateway key, still held, hands over.
   */
  evidencePrivateKey?: Hex;
  /**
   * Earlier receipt-signing keys, kept only while rotating: each one signs the handover of the receipt chains it signed
   * to the current one (ADR-0020). Configured principals are handed over at startup, any other chain on its next
   * receipt. Remove them once the chains that matter have been handed over.
   */
  previousGatewayKeys?: Hex[];
  /**
   * Earlier receipt-signing addresses whose keys are gone (lost, destroyed, a fresh key per run): chains they signed are
   * continued with a rotation that has no handover, which a verifier accepts only when it trusts both keys. A chain
   * signed by any key that is neither held nor listed here is refused (ADR-0022).
   */
  previousGatewayAddresses?: Address[];
  /** Secret from which per-credential session keys are derived (HMAC). Never leaves the gateway. */
  sessionSecret: string;
  /** Root key for credential HMAC chains. */
  credentialRootKey: string;
  /** The operator's admin token: every principal, and the gateway-wide maintenance routes. A principal may also have its own (ADR-0024). */
  adminToken: string;
  dataDir: string;
  /** `json` (zero-dependency file, default for demos) or `sqlite` (WAL file, recommended for self-hosting). */
  storeDriver?: "json" | "sqlite" | "postgres";
  /** Postgres only: the database every instance of this deployment shares (ADR-0025). */
  databaseUrl?: string;
  policyYaml: string;
  contracts: ContractAddresses;
  principals: Record<string, PrincipalConfig>;
  asset: { symbol: string; decimals: number };
  facilitator: { enabled: boolean };
  /** Seconds a signed authorization stays valid. */
  authorizationTtlSeconds: number;
  /** Gateway-wide approvers (approver id -> address whose EIP-191 signature resolves escalations), for every principal without its own (ADR-0024). */
  approvers?: Record<string, Address>;
  /** When true, approvals must carry a valid approver signature; the admin token alone is not enough. */
  requireSignedApprovals?: boolean;
  /** Seconds a pending approval stays open. Default 3600. */
  approvalTtlSeconds?: number;
  /**
   * How x402 payments are presented to facilitators. `agent-account` (default): one transaction, needs a
   * facilitator that knows AgentAccount (the bundled one). `standard`: the account pre-approves an EIP-3009
   * transfer on-chain (one extra transaction, gas paid by the gateway) and the payload is the standard x402
   * `exact` shape, so any facilitator (Coinbase CDP, Stellar/OZ, …) can settle it via ERC-1271.
   */
  x402Mode?: "agent-account" | "standard";
  /** Public origin of this gateway, advertised as Signature-Agent and serving the key directory. Default http://host:port. */
  publicUrl?: string;
  /** Sign outbound requests to payees as a Web Bot Auth agent (RFC 9421, Ed25519). Default true. */
  signOutbound?: boolean;
  /** Fastify/pino log level (e.g. "info"); undefined = logging off (demos). Secrets are redacted. */
  logLevel?: string;
  /** Collect Node default metrics (CPU, memory, event loop) in addition to gateway metrics. Default false. */
  defaultMetrics?: boolean;
  /** Lightning backend for the L402 rail (pays invoices). Policy is the only limit on this rail; keep the wallet small. */
  lightning?: LightningBackend;
  /**
   * Where the gateway may send requests on an agent's behalf. By default loopback, private and link-local
   * destinations are refused (the gateway must not be an open proxy into its own network); set `allowLoopback`
   * for a payee on this machine (demos), `allowPrivate`
   * for demos and in-cluster payees, and `allowedHosts` to pin the payees a deployment may ever contact.
   */
  outbound?: { allowLoopback?: boolean; allowPrivate?: boolean; allowedHosts?: string[] };
  /** Abort any request to a payee after this long (probe and paid retry). Default 15000. */
  payeeTimeoutMs?: number;
  /** Reference-currency conversion for non-USDC rails: how many sats one unit of the reference asset buys. */
  fx?: { satsPerUsdc: number };
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`missing env ${k}`);
    return v;
  };
  const contracts = JSON.parse(need("SPENDMARSHAL_CONTRACTS")) as ContractAddresses;
  const principals = JSON.parse(need("SPENDMARSHAL_PRINCIPALS")) as Record<string, PrincipalConfig>;
  return {
    host: env.SPENDMARSHAL_HOST ?? "127.0.0.1",
    port: Number(env.SPENDMARSHAL_PORT ?? 4402),
    rpcUrl: env.SPENDMARSHAL_RPC_URL ?? "http://127.0.0.1:8545",
    chainId: Number(env.SPENDMARSHAL_CHAIN_ID ?? 31337),
    gatewayPrivateKey: need("SPENDMARSHAL_GATEWAY_PRIVATE_KEY") as Hex,
    evidencePrivateKey: env.SPENDMARSHAL_EVIDENCE_PRIVATE_KEY ? (env.SPENDMARSHAL_EVIDENCE_PRIVATE_KEY as Hex) : undefined,
    previousGatewayKeys: env.SPENDMARSHAL_PREVIOUS_GATEWAY_PRIVATE_KEYS ? (env.SPENDMARSHAL_PREVIOUS_GATEWAY_PRIVATE_KEYS.split(",").map((s) => s.trim()).filter(Boolean) as Hex[]) : undefined,
    previousGatewayAddresses: env.SPENDMARSHAL_PREVIOUS_GATEWAY_ADDRESSES ? (env.SPENDMARSHAL_PREVIOUS_GATEWAY_ADDRESSES.split(",").map((s) => s.trim()).filter(Boolean) as Address[]) : undefined,
    sessionSecret: need("SPENDMARSHAL_SESSION_SECRET"),
    credentialRootKey: need("SPENDMARSHAL_CREDENTIAL_ROOT_KEY"),
    adminToken: need("SPENDMARSHAL_ADMIN_TOKEN"),
    dataDir: env.SPENDMARSHAL_DATA_DIR ?? "./data",
    storeDriver: env.SPENDMARSHAL_STORE === "sqlite" || env.SPENDMARSHAL_STORE === "postgres" ? env.SPENDMARSHAL_STORE : "json",
    databaseUrl: env.SPENDMARSHAL_DATABASE_URL,
    policyYaml: need("SPENDMARSHAL_POLICY_YAML"),
    contracts,
    principals,
    asset: { symbol: env.SPENDMARSHAL_ASSET ?? "USDC", decimals: Number(env.SPENDMARSHAL_DECIMALS ?? 6) },
    facilitator: { enabled: (env.SPENDMARSHAL_FACILITATOR ?? "true") !== "false" },
    authorizationTtlSeconds: Number(env.SPENDMARSHAL_AUTH_TTL ?? 120),
    approvers: env.SPENDMARSHAL_APPROVERS ? (JSON.parse(env.SPENDMARSHAL_APPROVERS) as Record<string, Address>) : undefined,
    requireSignedApprovals: env.SPENDMARSHAL_REQUIRE_SIGNED_APPROVALS === "true",
    approvalTtlSeconds: env.SPENDMARSHAL_APPROVAL_TTL ? Number(env.SPENDMARSHAL_APPROVAL_TTL) : undefined,
    x402Mode: env.SPENDMARSHAL_X402_MODE === "standard" ? "standard" : "agent-account",
    publicUrl: env.SPENDMARSHAL_PUBLIC_URL,
    signOutbound: env.SPENDMARSHAL_SIGN_OUTBOUND !== "false",
    logLevel: env.SPENDMARSHAL_LOG_LEVEL,
    defaultMetrics: env.SPENDMARSHAL_DEFAULT_METRICS === "true",
    fx: env.SPENDMARSHAL_SATS_PER_USDC ? { satsPerUsdc: Number(env.SPENDMARSHAL_SATS_PER_USDC) } : undefined,
    payeeTimeoutMs: env.SPENDMARSHAL_PAYEE_TIMEOUT_MS ? Number(env.SPENDMARSHAL_PAYEE_TIMEOUT_MS) : undefined,
    outbound: { allowLoopback: env.SPENDMARSHAL_OUTBOUND_ALLOW_LOOPBACK === "true", allowPrivate: env.SPENDMARSHAL_OUTBOUND_ALLOW_PRIVATE === "true", allowedHosts: env.SPENDMARSHAL_OUTBOUND_ALLOWED_HOSTS ? env.SPENDMARSHAL_OUTBOUND_ALLOWED_HOSTS.split(",").map((s) => s.trim()).filter(Boolean) : undefined },
  };
}
