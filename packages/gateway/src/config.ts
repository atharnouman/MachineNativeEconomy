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
}

export interface GatewayConfig {
  host: string;
  port: number;
  rpcUrl: string;
  chainId: number;
  /** Signs receipts, submits sessions/anchors, relays settlements. Dev: also owns the AgentAccount. */
  gatewayPrivateKey: Hex;
  /** Secret from which per-credential session keys are derived (HMAC). Never leaves the gateway. */
  sessionSecret: string;
  /** Root key for credential HMAC chains. */
  credentialRootKey: string;
  adminToken: string;
  dataDir: string;
  /** `json` (zero-dependency file, default for demos) or `sqlite` (WAL file, recommended for self-hosting). */
  storeDriver?: "json" | "sqlite";
  policyYaml: string;
  contracts: ContractAddresses;
  principals: Record<string, PrincipalConfig>;
  asset: { symbol: string; decimals: number };
  facilitator: { enabled: boolean };
  /** Seconds a signed authorization stays valid. */
  authorizationTtlSeconds: number;
  /** Approver id -> address whose EIP-191 signature resolves escalations. */
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
    sessionSecret: need("SPENDMARSHAL_SESSION_SECRET"),
    credentialRootKey: need("SPENDMARSHAL_CREDENTIAL_ROOT_KEY"),
    adminToken: need("SPENDMARSHAL_ADMIN_TOKEN"),
    dataDir: env.SPENDMARSHAL_DATA_DIR ?? "./data",
    storeDriver: env.SPENDMARSHAL_STORE === "sqlite" ? "sqlite" : "json",
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
    outbound: { allowLoopback: env.SPENDMARSHAL_OUTBOUND_ALLOW_LOOPBACK === "true", allowPrivate: env.SPENDMARSHAL_OUTBOUND_ALLOW_PRIVATE === "true", allowedHosts: env.SPENDMARSHAL_OUTBOUND_ALLOWED_HOSTS ? env.SPENDMARSHAL_OUTBOUND_ALLOWED_HOSTS.split(",").map((s) => s.trim()).filter(Boolean) : undefined },
  };
}
