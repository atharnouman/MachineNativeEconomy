import { createHmac, type KeyObject } from "node:crypto";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { PaymentAuthorizationTypes, TokenAuthorizationTypes, agentAccountDomain, ed25519FromSecret, type PaymentAuthorizationStruct, type TokenAuthorizationStruct, type Ed25519Jwk } from "@spendmarshal/core";

/** The gateway's HTTP message signing identity (Web Bot Auth / RFC 9421). */
export interface AgentSigningKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicJwk: Ed25519Jwk;
  keyid: string;
}

/**
 * Signing is isolated here so the backend can be swapped (KMS, HSM, MPC) without touching policy or rails.
 * Session keys are derived deterministically from the gateway secret and the credential id, so nothing has to
 * be stored and a credential always maps to the same on-chain session key.
 */
export interface Signer {
  /** The gateway identity: signs receipts, owns/operates accounts in dev, relays settlements. */
  readonly address: Address;
  signReceiptHash(hash: Hex): Promise<Hex>;
  sessionKeyAddress(credentialId: string): Address;
  signAuthorization(credentialId: string, account: Address, chainId: number, auth: PaymentAuthorizationStruct): Promise<Hex>;
  /** Standard-x402 interop: authorize the account to pre-approve an EIP-3009 transfer (ERC-1271 path). */
  signTokenAuthorization(credentialId: string, account: Address, chainId: number, auth: TokenAuthorizationStruct): Promise<Hex>;
  /** Ed25519 key used to sign outbound HTTP requests (RFC 9421 / Web Bot Auth) and the key directory. */
  readonly agentKey: AgentSigningKey;
  /**
   * Gateway key history (ADR-0020): sign a receipt chain's handover to `address` with the earlier gateway key `from`.
   * Null when this signer no longer holds that key; the rotation is then receipted without a handover.
   */
  signKeyHandover?(from: Address, message: string): Promise<Hex | null>;
  /** Dev-only escape hatch used by the demo's "key exfiltration" attack. Not exposed over HTTP. */
  _unsafeSessionPrivateKey(credentialId: string): Hex;
}

export class LocalSigner implements Signer {
  readonly gateway: PrivateKeyAccount;
  readonly address: Address;
  readonly agentKey: AgentSigningKey;
  private readonly cache = new Map<string, PrivateKeyAccount>();
  /** earlier gateway keys, by lowercase address: they sign handovers and nothing else */
  private readonly previous = new Map<string, PrivateKeyAccount>();

  constructor(gatewayPrivateKey: Hex, private readonly sessionSecret: string, previousGatewayKeys: readonly Hex[] = []) {
    this.gateway = privateKeyToAccount(gatewayPrivateKey);
    this.address = this.gateway.address;
    const k = ed25519FromSecret(sessionSecret, "httpsig-ed25519");
    this.agentKey = { privateKey: k.privateKey, publicKey: k.publicKey, publicJwk: k.publicJwk, keyid: k.keyid };
    for (const key of previousGatewayKeys) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("previous gateway key is not a 32-byte hex private key"); // never echo the key
      const a = privateKeyToAccount(key);
      if (a.address !== this.address) this.previous.set(a.address.toLowerCase(), a);
    }
  }

  async signKeyHandover(from: Address, message: string): Promise<Hex | null> {
    const a = this.previous.get(from.toLowerCase());
    return a ? a.signMessage({ message }) : null;
  }

  private sessionAccount(credentialId: string): PrivateKeyAccount {
    let a = this.cache.get(credentialId);
    if (!a) {
      const mac = createHmac("sha256", this.sessionSecret).update(`session:${credentialId}`).digest();
      const pk = keccak256(toHex(mac)); // uniform 32 bytes; collisions negligible
      a = privateKeyToAccount(pk);
      this.cache.set(credentialId, a);
    }
    return a;
  }

  signReceiptHash(hash: Hex): Promise<Hex> {
    return this.gateway.signMessage({ message: { raw: hash } });
  }

  sessionKeyAddress(credentialId: string): Address {
    return this.sessionAccount(credentialId).address;
  }

  signAuthorization(credentialId: string, account: Address, chainId: number, auth: PaymentAuthorizationStruct): Promise<Hex> {
    return this.sessionAccount(credentialId).signTypedData({
      domain: agentAccountDomain(account, chainId),
      types: PaymentAuthorizationTypes,
      primaryType: "PaymentAuthorization",
      message: auth,
    });
  }

  signTokenAuthorization(credentialId: string, account: Address, chainId: number, auth: TokenAuthorizationStruct): Promise<Hex> {
    return this.sessionAccount(credentialId).signTypedData({
      domain: agentAccountDomain(account, chainId),
      types: TokenAuthorizationTypes,
      primaryType: "TokenAuthorization",
      message: auth,
    });
  }

  _unsafeSessionPrivateKey(credentialId: string): Hex {
    const mac = createHmac("sha256", this.sessionSecret).update(`session:${credentialId}`).digest();
    return keccak256(toHex(mac));
  }
}
