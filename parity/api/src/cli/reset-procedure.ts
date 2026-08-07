// `make reset-procedure PROC=x`. Put one procedure back to "nothing analysed yet", and leave
// the other thirteen exactly as they were.
//
// The work is in `../estate/reset-procedure.ts`; this is the command around it. The split is so
// that `probe-reset-procedure` can run the identical code inside a transaction it rolls back —
// a gate that had to destroy $1.39 of analysis to check the reset works is a gate nobody runs
// twice, and a gate that reads the source instead of running it is not a gate.

import { eq } from 'drizzle-orm';
import { openStore, waitForPostgres } from '../db/client.js';
import { applyMigrations } from '../db/migrate.js';
import { loadConfig } from '../env.js';
import { procedures } from '../db/schema.js';
import { resetProcedure } from '../estate/reset-procedure.js';

const config = loadConfig();
const procedureName = process.argv[2];

if (procedureName === undefined || procedureName === '') {
  console.error('usage: reset-procedure.ts <procedure-name>');
  process.exit(1);
}

const store = openStore(config.pgUrl);
await waitForPostgres(store.pool);
await applyMigrations(store.db);

// One transaction. A half-reset procedure — say, specs gone but golden tests still citing an
// agent run that no longer exists — is a worse state than either end of the operation.
const outcome = await store.db.transaction((tx) => resetProcedure(tx, procedureName));

if (!outcome.found) {
  console.error(`no procedure named ${procedureName} — nothing to reset`);
  await store.pool.end();
  process.exit(1);
}

console.log(`reset ${procedureName}`);
console.log(`  was ${outcome.before.oracleClass ?? 'untriaged'} · ${outcome.before.oracleState} · ${outcome.before.campaignStatus}`);
for (const [table, n] of Object.entries(outcome.deleted).filter(([, n]) => n > 0)) {
  console.log(`  ${String(n).padStart(5)}  ${table}`);
}
console.log('  now untriaged · none · untouched');

// The other thirteen, so the caller can see at a glance that nothing else moved.
const others = await store.db.select().from(procedures);
const analysed = others.filter((p) => p.name !== procedureName && p.oracleState !== 'none').length;
console.log(`  ${analysed} other procedures still analysed`);

// The generated service on disk is the host's business — parity-api has no mount into the demo
// app, deliberately. Said rather than silently left behind.
console.log(`\nthe generated service source is on the host: parity-platform-demo-app/pricing-service-generated/src/${procedureName}/`);

await store.pool.end();
