// What `verify-m7` shells out to for the reset section: `make demo-reset`'s truncation, run
// for real inside a transaction that is then rolled back.
//
// The gate must not actually reset the estate — a gate that costs $16 of analysis to run is a
// gate nobody runs. But reading `RESET_TABLES` and asserting it looks right is not a check, it
// is a second copy of the same opinion. TRUNCATE is transactional in Postgres, so the honest
// version is available: truncate exactly what the reset truncates, count every table in the
// schema, and roll back.
//
// What comes out is the fact the whole section turns on — **which tables still have rows after
// a reset**. Two are supposed to: `policy_rules`, which is configuration reasserted on boot,
// and drizzle's own migration ledger. Anything else in that list is state the demo cannot get
// rid of, which is how `campaign_runs` and a NULL-`procedure_id` pull request would have opened
// beat 1 on yesterday's screen.

import { sql } from 'drizzle-orm';
import { openStore, waitForPostgres } from '../db/client.js';
import { loadConfig } from '../env.js';
import { RESET_STATEMENT, RESET_TABLES } from '../ingest/run.js';

const config = loadConfig();
const store = openStore(config.pgUrl);
await waitForPostgres(store.pool);

const tableNames = async (): Promise<string[]> => {
  const result = await store.db.execute<{ table_name: string }>(
    sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
  );
  return result.rows.map((row) => row.table_name);
};

const countsFor = async (tables: string[]): Promise<Record<string, number>> => {
  if (tables.length === 0) return {};
  const query = tables.map((t) => `select '${t}' as t, count(*)::int as n from ${t}`).join(' union all ');
  const result = await store.db.execute<{ t: string; n: number }>(sql.raw(query));
  return Object.fromEntries(result.rows.map((row) => [row.t, Number(row.n)]));
};

const tables = await tableNames();
const before = await countsFor(tables);

let after: Record<string, number> = {};
let elapsedMs = 0;
try {
  await store.db.transaction(async (tx) => {
    const started = Date.now();
    await tx.execute(sql.raw(RESET_STATEMENT));
    elapsedMs = Date.now() - started;

    const query = tables.map((t) => `select '${t}' as t, count(*)::int as n from ${t}`).join(' union all ');
    const result = await tx.execute<{ t: string; n: number }>(sql.raw(query));
    after = Object.fromEntries(result.rows.map((row) => [row.t, Number(row.n)]));

    // Drizzle signals a rollback by throwing. Nothing below this line runs, and nothing above
    // it is committed — which is the entire point of doing it this way.
    tx.rollback();
  });
} catch {
  // The rollback. Deliberately swallowed: `tx.rollback()` is how drizzle spells ROLLBACK, and
  // a real failure would show up as an empty `after`, which the gate checks.
}

const restored = await countsFor(tables);

console.log(
  JSON.stringify(
    {
      resetTables: [...RESET_TABLES],
      allTables: tables,
      elapsedMs,
      before,
      after,
      // Everything still holding rows once the reset has run. Configuration only, or the reset
      // has a hole in it.
      survives: Object.entries(after)
        .filter(([, n]) => n > 0)
        .map(([t]) => t)
        .sort(),
      emptied: Object.entries(before)
        .filter(([t, n]) => n > 0 && (after[t] ?? 0) === 0)
        .map(([t]) => t)
        .sort(),
      rolledBack: JSON.stringify(before) === JSON.stringify(restored),
    },
    null,
    2,
  ),
);

await store.pool.end();
