import { createHmac } from "node:crypto";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { PaymentAuthorizationTypes, agentAccountDomain, type PaymentAuthorizationStruct } from "@apgw/core";

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
  /** Dev-only escape hatch used by the demo's "key exfiltration" attack. Not exposed over HTTP. */
  _unsafeSessionPrivateKey(credentialId: string): Hex;
}

export class LocalSigner implements Signer {
  readonly gateway: PrivateKeyAccount;
  readonly address: Address;
  private readonly cache = new Map<string, PrivateKeyAccount>();

  constructor(gatewayPrivateKey: Hex, private readonly sessionSecret: string) {
    this.gateway = privateKeyToAccount(gatewayPrivateKey);
    this.address = this.gateway.address;
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

  _unsafeSessionPrivateKey(credentialId: string): Hex {
    const mac = createHmac("sha256", this.sessionSecret).update(`session:${credentialId}`).digest();
    return keccak256(toHex(mac));
  }
}
