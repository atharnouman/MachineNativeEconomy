import type { Address } from "viem";
import {
  issueRoot,
  attenuate,
  verifyCredential,
  credentialId,
  toPublic,
  parentOf,
  effectiveLimits,
  isSubsetOf,
  randomId,
  nowIso,
  type Credential,
  type Caveat,
} from "@apgw/core";
import type { GatewayConfig } from "./config.js";
import type { Store, RegisteredCredential } from "./store.js";
import type { Signer } from "./signer.js";
import type { ChainClient, SessionCaveatsOnChain } from "./chain.js";
import type { ReceiptLog } from "./receipts.js";

const MAX_UINT256 = (1n << 256n) - 1n;
const FAR_FUTURE = 4_102_444_800n; // 2100-01-01

/**
 * Credential lifecycle: issue (admin) -> attenuate (anyone, offline) -> register (compiles caveats into an
 * on-chain session so the chain enforces the same limits the gateway does).
 */
export class CredentialService {
  constructor(
    private readonly cfg: GatewayConfig,
    private readonly store: Store,
    private readonly signer: Signer,
    private readonly chain: ChainClient,
    private readonly receipts: ReceiptLog,
  ) {}

  async issue(args: { principalId: string; agentId: string; caveats: Exclude<Caveat, { type: "delegate" }>[] }): Promise<Credential> {
    if (!this.cfg.principals[args.principalId]) throw new Error(`unknown principal ${args.principalId}`);
    const cred = issueRoot({
      rootKey: this.cfg.credentialRootKey,
      rootId: randomId("cred"),
      principalId: args.principalId,
      agentId: args.agentId,
      nonce: randomId("n"),
      caveats: args.caveats,
    });
    await this.receipts.append(args.principalId, "credential.issued", { credential: toPublic(cred) }, { agentId: args.agentId, credentialId: credentialId(cred) });
    return cred;
  }

  attenuate(parent: Credential, caveats: Caveat[], delegateTo?: { agentId: string }): Credential {
    this.verify(parent);
    return attenuate(parent, caveats, delegateTo ? { agentId: delegateTo.agentId, nonce: randomId("n") } : undefined);
  }

  verify(c: Credential): void {
    const r = verifyCredential(this.cfg.credentialRootKey, c);
    if (!r.ok) throw new Error(`invalid credential: ${r.reason}`);
    if (!this.cfg.principals[c.principalId]) throw new Error(`unknown principal ${c.principalId}`);
  }

  /** Compile caveats to an on-chain session (idempotent). Parent must already be registered. */
  async register(c: Credential): Promise<RegisteredCredential> {
    this.verify(c);
    const id = credentialId(c);
    const existing = this.store.getCredential(id);
    if (existing) return existing;

    const account = this.cfg.principals[c.principalId]!.account;
    const key = this.signer.sessionKeyAddress(id);
    const lim = effectiveLimits(c.caveats);
    const parent = parentOf(c);
    const onchain: SessionCaveatsOnChain = {
      spendCap: lim.spendCap ?? MAX_UINT256,
      perTxMax: lim.perTxMax ?? MAX_UINT256,
      validAfter: lim.notBefore ? BigInt(Math.floor(lim.notBefore.getTime() / 1000)) : 0n,
      validUntil: lim.expiresAt ? BigInt(Math.floor(lim.expiresAt.getTime() / 1000)) : FAR_FUTURE,
      anyTarget: lim.allowedPayees === null || [...lim.allowedPayees].every((p) => !p.startsWith("0x")),
      // payee *addresses* in the caveat become on-chain targets; hostnames are enforced off-chain only
      targets: lim.allowedPayees ? ([...lim.allowedPayees].filter((p) => /^0x[0-9a-f]{40}$/.test(p)) as Address[]) : [],
      tokens: [this.cfg.contracts.usdc],
    };

    let txHash: `0x${string}`;
    if (parent) {
      const parentId = credentialId(parent);
      const parentReg = this.store.getCredential(parentId);
      if (!parentReg) throw new Error(`parent credential ${parentId} must be registered first`);
      // belt and braces: the chain re-checks this, but fail fast with a clear message
      const sub = isSubsetOf(lim, effectiveLimits(parent.caveats));
      if (!sub.ok) throw new Error(`child wider than parent in ${sub.violations.join(",")}`);
      txHash = await this.chain.grantChildSession(account, parentReg.sessionKey as Address, key, onchain);
    } else {
      txHash = await this.chain.grantSession(account, key, onchain);
    }

    const reg: RegisteredCredential = { ...toPublic(c), sessionKey: key, registeredAt: nowIso(), txHash };
    this.store.putCredential(reg);
    await this.receipts.append(
      c.principalId,
      "credential.registered",
      {
        credential: toPublic(c),
        sessionKey: key,
        parentSessionKey: parent ? this.store.getCredential(credentialId(parent))?.sessionKey : null,
        onchain: { account, txHash, spendCap: onchain.spendCap, perTxMax: onchain.perTxMax, validUntil: onchain.validUntil, anyTarget: onchain.anyTarget, targets: onchain.targets },
      },
      { agentId: reg.agentId, credentialId: id },
    );
    return reg;
  }
}
