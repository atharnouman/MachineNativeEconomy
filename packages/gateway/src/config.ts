import type { Address, Hex } from "viem";

export interface ContractAddresses {
  usdc: Address;
  receiptRegistry: Address;
  enforcers: { spendLimit: Address; timeWindow: Address; allowedTargets: Address };
}

export interface PrincipalConfig {
  /** The AgentAccount holding this principal's funds. Owner must be the gateway key (dev) or grant it operator rights. */
  account: Address;
}

export interface GatewayConfig {
  host: string;
  port: number;
  rpcUrl: string;
  chainId: number;
  /** Signs receipts, submits on-chain sessions/anchors, relays settlements. Dev: also owns the AgentAccount. */
  gatewayPrivateKey: Hex;
  /** Secret from which per-credential session keys are derived (HMAC). Never leaves the gateway. */
  sessionSecret: string;
  /** Root key for credential HMAC chains. */
  credentialRootKey: string;
  adminToken: string;
  dataDir: string;
  policyYaml: string;
  contracts: ContractAddresses;
  principals: Record<string, PrincipalConfig>;
  asset: { symbol: string; decimals: number };
  facilitator: { enabled: boolean };
  /** Seconds a signed authorization stays valid. */
  authorizationTtlSeconds: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`missing env ${k}`);
    return v;
  };
  const contracts = JSON.parse(need("APGW_CONTRACTS")) as ContractAddresses;
  const principals = JSON.parse(need("APGW_PRINCIPALS")) as Record<string, PrincipalConfig>;
  return {
    host: env.APGW_HOST ?? "127.0.0.1",
    port: Number(env.APGW_PORT ?? 4402),
    rpcUrl: env.APGW_RPC_URL ?? "http://127.0.0.1:8545",
    chainId: Number(env.APGW_CHAIN_ID ?? 31337),
    gatewayPrivateKey: need("APGW_GATEWAY_PRIVATE_KEY") as Hex,
    sessionSecret: need("APGW_SESSION_SECRET"),
    credentialRootKey: need("APGW_CREDENTIAL_ROOT_KEY"),
    adminToken: need("APGW_ADMIN_TOKEN"),
    dataDir: env.APGW_DATA_DIR ?? "./data",
    policyYaml: need("APGW_POLICY_YAML"),
    contracts,
    principals,
    asset: { symbol: env.APGW_ASSET ?? "USDC", decimals: Number(env.APGW_DECIMALS ?? 6) },
    facilitator: { enabled: (env.APGW_FACILITATOR ?? "true") !== "false" },
    authorizationTtlSeconds: Number(env.APGW_AUTH_TTL ?? 120),
  };
}
