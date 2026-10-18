import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { keccak256, toHex, type Hex } from "viem";
import { ANVIL_KEYS, deployCore, startAnvil } from "@spendmarshal/devnet";
import { ChainClient, hasNonceLock, openStore } from "@spendmarshal/gateway";

const POSTGRES = process.env.SPENDMARSHAL_TEST_POSTGRES_URL;
const KEY = ANVIL_KEYS[6]!; // a key no other test in this package sends with

async function freshDatabase(): Promise<string> {
  const name = `sm_nonces_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: POSTGRES });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(POSTGRES!);
  url.pathname = `/${name}`;
  return url.toString();
}

// Two gateway instances on one database share the gateway key: each send takes its nonce under the database's lock (ADR-0025).
describe.skipIf(!POSTGRES)("the gateway key's nonces across instances on one Postgres database", () => {
  it("never reuses a nonce when two instances send at the same time", async () => {
    const net = await startAnvil({ port: 18550 });
    const databaseUrl = await freshDatabase();
    const [a, b] = [await openStore({ driver: "postgres", dataDir: "", databaseUrl }), await openStore({ driver: "postgres", dataDir: "", databaseUrl })];
    try {
      const core = await deployCore(net, ANVIL_KEYS[0]!);
      if (!hasNonceLock(a) || !hasNonceLock(b)) throw new Error("the Postgres store has no nonce lock");
      const cfg = { rpcUrl: net.rpcUrl, chainId: net.chainId, gatewayPrivateKey: KEY };
      const one = new ChainClient(cfg, a);
      const two = new ChainClient(cfg, b);
      const zero = `0x${"0".repeat(64)}` as Hex;
      // eight first anchors of eight different receipt chains: independent on-chain, so only the nonces can collide
      const sent = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? one : two).anchor(core.receiptRegistry, keccak256(toHex(`chain-${i}`)), keccak256(toHex(`head-${i}`)), zero, 1n)));
      const nonces = await Promise.all(sent.map(async (s) => (await one.pub.getTransaction({ hash: s.txHash })).nonce));
      expect(new Set(nonces).size).toBe(8);
      const first = Math.min(...nonces);
      expect([...nonces].sort((x, y) => x - y)).toEqual(Array.from({ length: 8 }, (_, i) => first + i));
    } finally {
      await a.close();
      await b.close();
      net.stop();
    }
  });
});
