#!/usr/bin/env node
// Drops every test database (named sm_<label>_<hex>) left on the test Postgres server by earlier test runs.
//
//   SPENDMARSHAL_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:55432/postgres node scripts/drop-test-databases.mjs [--dry-run]
//
// Test files drop their own databases when they finish (test/drivers.ts); this sweep is for runs that were interrupted,
// or that predate the drop. Nothing but sm_* databases is touched.
import pg from "pg";

const url = process.env.SPENDMARSHAL_TEST_POSTGRES_URL;
if (!url) {
  console.error("SPENDMARSHAL_TEST_POSTGRES_URL is not set");
  process.exit(2);
}
const dryRun = process.argv.includes("--dry-run");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const { rows } = await client.query("SELECT datname FROM pg_database WHERE datname ~ '^sm_[a-z0-9_]+$' ORDER BY datname");
  for (const { datname } of rows) {
    if (dryRun) console.log(datname);
    else await client.query(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`);
  }
  console.log(`${dryRun ? "would drop" : "dropped"} ${rows.length} test database${rows.length === 1 ? "" : "s"}`);
} finally {
  await client.end();
}
