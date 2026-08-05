import { openStore, waitForPostgres } from '../db/client.js';
import { applyMigrations } from '../db/migrate.js';
import { loadConfig } from '../env.js';
import { ingest } from '../ingest/run.js';

const config = loadConfig();
const store = openStore(config.pgUrl);

await waitForPostgres(store.pool);
await applyMigrations(store.db);

const summary = await ingest(store.db, config);

console.log(`ingested ${summary.procedures} procedures in ${summary.durationMs} ms`);
console.log(`  ${summary.columns} column accesses`);
console.log(`  ${summary.callEdges} call edges`);
console.log(`  ${summary.couplingEdges} coupling edges`);
console.log(`  ${summary.invocations90d.toLocaleString('en-US')} invocations over 90 days`);
if (summary.dynamicSql.length > 0) console.log(`  dynamic SQL: ${summary.dynamicSql.join(', ')}`);

await store.close();
