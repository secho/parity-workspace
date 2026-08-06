/**
 * `make map-estate` — triage and extract-spec across all fourteen procedures.
 *
 * Separate from `make verify-m3` on purpose: this is 28 live model runs and should happen
 * once, while the gate asserts the persisted result and stays free to re-run. Beat 2 of the
 * demo runs this as the `Zmapovat estate` campaign.
 */
import { asc } from 'drizzle-orm';
import { openStore, waitForPostgres } from '../db/client.js';
import { applyMigrations } from '../db/migrate.js';
import { seedPolicy } from '../agent/policy.js';
import { executeRun, specRun, triageRun } from '../agent/runner.js';
import { procedures } from '../db/schema.js';
import { agentReadiness, loadConfig } from '../env.js';

const config = loadConfig();

const readiness = agentReadiness();
if (!readiness.ready) {
  console.error(`cannot map the estate: ${readiness.reason}`);
  console.error('Set a Console API key in .env as ANTHROPIC_API_KEY=sk-ant-… and re-run.');
  process.exit(1);
}

const store = openStore(config.pgUrl);
await waitForPostgres(store.pool);
await applyMigrations(store.db);
await seedPolicy(store.db);

const rows = await store.db.select({ name: procedures.name }).from(procedures).orderBy(asc(procedures.name));
const only = process.argv.slice(2);
const targets = only.length > 0 ? rows.filter((r) => only.includes(r.name)) : rows;

console.log(`mapping ${targets.length} procedures — triage then extract-spec\n`);
const started = Date.now();
let cost = 0;
let failures = 0;

for (const [index, row] of targets.entries()) {
  for (const [label, request] of [
    ['triage', triageRun(row.name)],
    ['spec', specRun(row.name)],
  ] as const) {
    process.stdout.write(`  [${index + 1}/${targets.length}] ${row.name} · ${label} … `);
    try {
      const handle = await executeRun(store.db, config, request);
      cost += handle.result.costUsd ?? 0;
      const blocked = handle.blocked.length > 0 ? ` blocked:${handle.blocked.length}` : '';
      console.log(
        `${handle.result.isError ? 'FAILED' : 'ok'} (${handle.result.numTurns} turns, ${handle.result.model ?? '?'}${blocked})`,
      );
      if (handle.result.isError) failures++;
    } catch (err) {
      failures++;
      console.log(`ERROR ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

console.log(
  `\nmapped ${targets.length} procedures in ${((Date.now() - started) / 1000).toFixed(0)} s, ` +
    `$${cost.toFixed(2)}, ${failures} failure${failures === 1 ? '' : 's'}`,
);

await store.close();
if (failures > 0) process.exit(1);
