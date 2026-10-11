import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueRoot, credentialId } from "@spendmarshal/core";
import { openStore } from "../src/store.js";
import { LocalSigner } from "../src/signer.js";
import { ReceiptLog } from "../src/receipts.js";
import { CredentialService } from "../src/credentials.js";
import type { ChainClient } from "../src/chain.js";
import type { GatewayConfig } from "../src/config.js";

const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ACCOUNT = "0x00000000000000000000000000000000000000aa";
const USDC = "0x00000000000000000000000000000000000000bb";
const ZERO_TX = `0x${"0".repeat(64)}`;

const cfg = { credentialRootKey: "k", principals: { org: { account: ACCOUNT, ownerIsGateway: true } }, contracts: { usdc: USDC } } as unknown as GatewayConfig;
const session = (key: string, active = true) => ({ key, parent: `0x${"0".repeat(40)}`, spendCap: 10n, spent: 0n, perTxMax: 1n, validAfter: 0n, validUntil: 2n ** 40n, anyTarget: true, active });

async function service(chain: Partial<ChainClient>) {
  const store = await openStore({ driver: "json", dataDir: mkdtempSync(join(tmpdir(), "spendmarshal-reg-")) });
  const signer = new LocalSigner(PK, "secret");
  return { store, svc: new CredentialService(cfg, store, signer, chain as ChainClient, new ReceiptLog(store, signer)) };
}

const cred = (nonce: string) => issueRoot({ rootKey: "k", rootId: `cred_${nonce}`, principalId: "org", agentId: "a", nonce });

describe("CredentialService.register", () => {
  it("adopts a session the chain already holds for this key (restart between grant and store write)", async () => {
    let grants = 0;
    const { store, svc } = await service({
      async grantSession() {
        grants++;
        throw new Error("SessionExists(0x1234)");
      },
      async readSession(_account, key) {
        return session(key);
      },
    });
    const c = cred("1");
    const reg = await svc.register(c);
    expect(grants).toBe(1);
    expect(reg.txHash).toBe(ZERO_TX);
    expect(store.getCredential(credentialId(c))?.sessionKey).toBe(reg.sessionKey);
    expect((await svc.register(c)).txHash).toBe(ZERO_TX); // idempotent from the store, no second grant
    expect(grants).toBe(1);
  });

  it("does not adopt when the existing session is inactive", async () => {
    const { svc } = await service({
      async grantSession() {
        throw new Error("SessionExists(0x1234)");
      },
      async readSession(_account, key) {
        return session(key, false);
      },
    });
    await expect(svc.register(cred("2"))).rejects.toThrow(/SessionExists/);
  });

  it("shares one transaction between concurrent registrations of the same credential", async () => {
    let grants = 0;
    const { svc } = await service({
      async grantSession() {
        grants++;
        await new Promise((r) => setTimeout(r, 30));
        return `0x${"1".repeat(64)}` as const;
      },
      async readSession(_account, key) {
        return session(key);
      },
    });
    const c = cred("3");
    const [a, b] = await Promise.all([svc.register(c), svc.register(c)]);
    expect(grants).toBe(1);
    expect(a.sessionKey).toBe(b.sessionKey);
    expect(a.txHash).toBe(`0x${"1".repeat(64)}`);
  });
});
