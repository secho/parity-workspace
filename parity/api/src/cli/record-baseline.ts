// `make record-baseline`. Re-record what the current procedure does, as the expectation.
//
// Separate from `generate-oracles` because it spends no model call: the cases and the
// invariants were chosen once and are not being re-chosen. This re-runs the procedure over
// those same cases and writes down what it did — including, from M6, the clock it read
// (`golden_tests.baseline_context`), which is what the replacement service is pinned to.
//
// Safe to re-run. The procedure is unchanged, so the expectations it records are the ones
// already stored; what moves is only the context that was never written before.

import { openStore, waitForPostgres } from '../db/client.js';
import { applyMigrations } from '../db/migrate.js';
import { loadConfig } from '../env.js';
import { recordBaseline } from '../oracle/suite.js';

const config = loadConfig();
const procedureName = process.argv[2] ?? 'sp_CalculateOrderTotal';

const store = openStore(config.pgUrl);
await waitForPostgres(store.pool);
await applyMigrations(store.db);

const started = Date.now();
const cases = await recordBaseline(store.db, config, procedureName);
console.log(`recorded ${cases} baselines for ${procedureName} in ${((Date.now() - started) / 1000).toFixed(1)}s`);

await store.pool.end();
