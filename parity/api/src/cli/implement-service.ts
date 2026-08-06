// `make implement-service`. One live Opus run that writes the replacement.
//
// Separate from the gate, like `map-estate`, `generate-oracles` and `shadow-run` before it.
// This spends real money and several minutes; `verify-m6` asserts what it persisted and stays
// cheap enough to re-run.
//
// The output is committed to the repository afterwards. Hard rule 5 says the demo is
// deterministic, and a service regenerated live on stage would be a different service every
// rehearsal — so this runs once, its result is reviewed, and the room sees the same code the
// gate measured.

import { openStore, waitForPostgres } from '../db/client.js';
import { applyMigrations } from '../db/migrate.js';
import { seedPolicy } from '../agent/policy.js';
import { agentReadiness, loadConfig } from '../env.js';
import { generateService } from '../service/generate.js';

const config = loadConfig();

const readiness = agentReadiness();
if (!readiness.ready) {
  console.error(`agent is not configured: ${readiness.reason}`);
  process.exit(1);
}

const procedureName = process.argv[2] ?? 'sp_CalculateOrderTotal';
// Feedback from a previous attempt, as text. `make implement-service FEEDBACK="..."` — but in
// practice this comes from `service-attempt.ts`, which runs the suite and assembles it.
const feedback = process.env.PARITY_SERVICE_FEEDBACK ?? null;

const store = openStore(config.pgUrl);
await waitForPostgres(store.pool);
await applyMigrations(store.db);
await seedPolicy(store.db);

console.log(`implement-service on ${procedureName}${feedback === null ? '' : ' (with feedback from the previous attempt)'}`);

const result = await generateService(store.db, config, { procedureName, feedback });
if (result === null) {
  console.error(`no procedure named ${procedureName}`);
  await store.pool.end();
  process.exit(1);
}

console.log(`\nrun ${result.runId} — ${result.status}, attempt ${result.attempt}`);
if (result.costUsd !== null) console.log(`cost: $${result.costUsd.toFixed(2)}`);

for (const block of result.blocked) console.log(`  BLOCKED  ${block.toolName} — ${block.reason}`);

if (result.artifacts === null) {
  console.error('\nthe run wrote no files');
  await store.pool.end();
  process.exit(1);
}

for (const file of result.artifacts.files) {
  console.log(`  ${file.path}  ${file.contents.length} bytes  sha256 ${file.sha256.slice(0, 12)}`);
}
console.log(`artefact ${result.artifacts.runHash.slice(0, 12)}`);

if (!result.complete) {
  // Not adopted, and said out loud. A half-written attempt deployed over a whole one would
  // leave the container serving a chimera of two runs with nothing in the record to say so.
  console.error('\nincomplete — not every file was written. Nothing will be adopted.');
  await store.pool.end();
  process.exit(1);
}

console.log('\nnext: `make adopt-service` to materialise it, then `make shadow-run IMPL=generated`');
await store.pool.end();
