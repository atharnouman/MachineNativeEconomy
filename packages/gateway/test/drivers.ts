import { mkdtempSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, onTestFinished } from "vitest";
import type { StoreDriver, StoreOptions } from "../src/store.js";

/**
 * A Postgres server for tests, e.g. a throwaway container:
 *   docker run -d --name spendmarshal-test-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:55432:5432 postgres:17-alpine
 *   SPENDMARSHAL_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:55432/postgres
 * Every test gets a database of its own on it, dropped when that test finishes (`DROP DATABASE ... WITH (FORCE)`, so a
 * store left open does not keep it alive); a database created outside a test is dropped when the file finishes.
 * Leftovers from interrupted runs: `pnpm --filter @spendmarshal/gateway test:pg-clean`.
 */
const POSTGRES = process.env.SPENDMARSHAL_TEST_POSTGRES_URL;

/** The drivers every store test runs on: Postgres too when SPENDMARSHAL_TEST_POSTGRES_URL names a server (ADR-0025). */
export const drivers = (): StoreDriver[] => (POSTGRES ? ["json", "sqlite", "postgres"] : ["json", "sqlite"]);

/** databases created outside a running test (a describe body or a beforeAll), dropped when the file finishes */
const createdOutsideTests: string[] = [];

/** Options for a fresh, empty store; opening them again reaches the same data. */
export async function freshStoreOptions(driver: StoreDriver, label: string): Promise<StoreOptions> {
  const dataDir = mkdtempSync(join(tmpdir(), `spendmarshal-${label}-${driver}-`));
  if (driver !== "postgres") return { driver, dataDir };
  const name = `sm_${label.replace(/[^a-z0-9]+/gi, "_").toLowerCase().slice(0, 40)}_${randomBytes(4).toString("hex")}`;
  await withAdmin((admin) => admin.query(`CREATE DATABASE ${name}`));
  try {
    onTestFinished(() => dropTestDatabases([name])); // throws when there is no running test
  } catch {
    createdOutsideTests.push(name);
  }
  const url = new URL(POSTGRES!);
  url.pathname = `/${name}`;
  return { driver, dataDir, databaseUrl: url.toString() };
}

/** Drops test databases. A failure is reported, never thrown: a leftover database must not fail a test. */
export async function dropTestDatabases(names: readonly string[]): Promise<void> {
  if (!POSTGRES || names.length === 0) return;
  try {
    await withAdmin(async (admin) => {
      for (const name of names) {
        try {
          await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        } catch (e) {
          console.warn(`could not drop test database ${name}: ${(e as Error).message}`);
        }
      }
    });
  } catch (e) {
    console.warn(`could not reach the test Postgres server to drop ${names.length} database(s): ${(e as Error).message}`);
  }
}

async function withAdmin<T>(run: (admin: pg.Client) => Promise<T>): Promise<T> {
  if (!POSTGRES) throw new Error("SPENDMARSHAL_TEST_POSTGRES_URL is not set");
  const admin = new pg.Client({ connectionString: POSTGRES });
  await admin.connect();
  try {
    return await run(admin);
  } finally {
    await admin.end();
  }
}

// registered while the test file is collected, so it runs once after everything in the file
afterAll(() => dropTestDatabases(createdOutsideTests.splice(0)), 60_000);
