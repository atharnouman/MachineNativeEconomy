import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoreDriver, StoreOptions } from "../src/store.js";

/** The drivers every store test runs on. */
export const drivers = (): StoreDriver[] => ["json", "sqlite"];

/** Options for a fresh, empty store; opening them again reaches the same data. */
export async function freshStoreOptions(driver: StoreDriver, label: string): Promise<StoreOptions> {
  return { driver, dataDir: mkdtempSync(join(tmpdir(), `spendmarshal-${label}-${driver}-`)) };
}
