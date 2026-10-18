import { mkdtempSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { StoreDriver, StoreOptions } from "../src/store.js";

/**
 * A Postgres server for tests, e.g. a throwaway container:
 *   docker run -d --name spendmarshal-test-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55432:5432 postgres:17-alpine
 *   SPENDMARSHAL_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:55432/postgres
 * Every test gets a database of its own on it.
 */
const POSTGRES = process.env.SPENDMARSHAL_TEST_POSTGRES_URL;

/** The drivers every store test runs on: Postgres too when SPENDMARSHAL_TEST_POSTGRES_URL names a server (ADR-0025). */
export const drivers = (): StoreDriver[] => (POSTGRES ? ["json", "sqlite", "postgres"] : ["json", "sqlite"]);

/** Options for a fresh, empty store; opening them again reaches the same data. */
export async function freshStoreOptions(driver: StoreDriver, label: string): Promise<StoreOptions> {
  const dataDir = mkdtempSync(join(tmpdir(), `spendmarshal-${label}-${driver}-`));
  if (driver !== "postgres") return { driver, dataDir };
  if (!POSTGRES) throw new Error("SPENDMARSHAL_TEST_POSTGRES_URL is not set");
  const name = `sm_${label.replace(/[^a-z0-9]+/gi, "_").toLowerCase().slice(0, 40)}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: POSTGRES });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(POSTGRES);
  url.pathname = `/${name}`;
  return { driver, dataDir, databaseUrl: url.toString() };
}
