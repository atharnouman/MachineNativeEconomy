import { describeRevert } from "@spendmarshal/core";
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
} from "@spendmarshal/core";
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
 *
 * On-chain parentage mirrors the credential lineage. A root credential's session is a child of the gateway's
 * own root session when the gateway is a bounded operator (`ownerIsGateway: false`), or a root session when the
 * gateway owns the account (dev).
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

  private readonly inflight = new Map<string, Promise<RegisteredCredential>>();

  /** Compile caveats to an on-chain session (idempotent; concurrent calls for one credential share one transaction). */
  async register(c: Credential): Promise<RegisteredCredential> {
    this.verify(c);
    const id = credentialId(c);
    const existing = this.store.getCredential(id);
    if (existing) return existing;
    const running = this.inflight.get(id);
    if (running) return running;
    const p = this.registerInner(c, id).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  private async registerInner(c: Credential, id: string): Promise<RegisteredCredential> {

    const principal = this.cfg.principals[c.principalId]!;
    const account = principal.account;
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

    // The session key is derived from the credential id, so a grant is idempotent in intent: if the chain already
    // holds an active session for this key (the gateway died between the grant and the store write), adopt it.
    const grant = async (send: () => Promise<`0x${string}`>): Promise<`0x${string}` | null> => {
      try {
        return await send();
      } catch (err) {
        if (!/SessionExists/.test(describeRevert(err))) throw err;
        const existing = await this.chain.readSession(account, key);
        if (!existing.active) throw err;
        return null;
      }
    };
    let txHash: `0x${string}` | null;
    let parentSessionKey: string | null = null;
    if (parent) {
      const parentId = credentialId(parent);
      const parentReg = this.store.getCredential(parentId);
      if (!parentReg) throw new Error(`parent credential ${parentId} must be registered first`);
      const sub = isSubsetOf(lim, effectiveLimits(parent.caveats));
      if (!sub.ok) throw new Error(`child wider than parent in ${sub.violations.join(",")}`);
      parentSessionKey = parentReg.sessionKey;
      txHash = await grant(() => this.chain.grantChildSession(account, parentReg.sessionKey as Address, key, onchain));
    } else if (principal.ownerIsGateway === false) {
      // bounded operator: the gateway's own root session is the parent; the chain re-checks the bounds
      const gatewaySession = await this.chain.readSession(account, this.signer.address);
      if (!gatewaySession.active) throw new Error(`gateway ${this.signer.address} has no active root session on ${account}`);
      if (onchain.spendCap === MAX_UINT256) onchain.spendCap = gatewaySession.spendCap - gatewaySession.spent;
      if (onchain.perTxMax === MAX_UINT256) onchain.perTxMax = gatewaySession.perTxMax;
      if (onchain.validUntil === FAR_FUTURE) onchain.validUntil = gatewaySession.validUntil;
      if (onchain.anyTarget && !gatewaySession.anyTarget) throw new Error("credential must restrict payees to addresses when the gateway session has a target allowlist");
      parentSessionKey = this.signer.address;
      txHash = await grant(() => this.chain.grantChildSession(account, this.signer.address, key, onchain));
    } else {
      txHash = await grant(() => this.chain.grantSession(account, key, onchain));
    }
    const adopted = txHash === null;
    if (txHash === null) txHash = `0x${"0".repeat(64)}`; // no transaction of ours: the session was already on-chain

    const reg: RegisteredCredential = { ...toPublic(c), sessionKey: key, parentSessionKey, registeredAt: nowIso(), txHash };
    this.store.putCredential(reg);
    await this.receipts.append(
      c.principalId,
      "credential.registered",
      {
        credential: toPublic(c),
        sessionKey: key,
        parentSessionKey,
        onchain: { account, txHash, adopted, spendCap: onchain.spendCap, perTxMax: onchain.perTxMax, validUntil: onchain.validUntil, anyTarget: onchain.anyTarget, targets: onchain.targets },
      },
      { agentId: reg.agentId, credentialId: id },
    );
    return reg;
  }
}
