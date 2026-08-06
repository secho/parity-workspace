import { clearWorkspaces } from '../agent/workspace.js';
import { openStore, waitForPostgres } from '../db/client.js';
import { applyMigrations } from '../db/migrate.js';
import { loadConfig } from '../env.js';
import { ingest, resetState } from '../ingest/run.js';

/**
 * `make demo-reset`. Back to the state beat 1 of the demo opens on: fourteen procedures
 * listed with real invocation counts, nothing analysed, coverage zero.
 *
 * SPEC §8 says to build this at M2 rather than M7 because it gets used more often than
 * any other command — every milestone's acceptance runs from a fresh reset.
 */
const config = loadConfig();
const store = openStore(config.pgUrl);
const started = Date.now();

await waitForPostgres(store.pool);
await applyMigrations(store.db);

await resetState(store.db);
await clearWorkspaces(config.agentWorkspace);
console.log('parity state cleared — estate, specs, agent runs and run workspaces');

const summary = await ingest(store.db, config);
console.log(`re-ingested ${summary.procedures} procedures, ${summary.couplingEdges} coupling edges`);
console.log(`demo-reset complete in ${((Date.now() - started) / 1000).toFixed(1)} s`);

await store.close();
