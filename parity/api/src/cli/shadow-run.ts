// One shadow run, from the command line. `make shadow-run`.
//
// Separate from the gate for the same reason `map-estate` and `generate-oracles` are: it does
// real work against a real database and, once classification is wired in, spends real model
// calls. The gate asserts the persisted result and stays cheap enough to re-run.

import { openStore, waitForPostgres } from '../db/client.js';
import { applyMigrations } from '../db/migrate.js';
import { seedPolicy } from '../agent/policy.js';
import { agentReadiness, loadConfig } from '../env.js';
import { runShadow } from '../shadow/run.js';
import { classifyRun } from '../shadow/classify.js';

const config = loadConfig();

// Checked up front rather than after a twenty-second replay. The same reasoning as
// generate-oracles: discovering a missing workspace id at the point where the model is
// finally needed wastes everything done before it.
const readiness = agentReadiness();
if (!readiness.ready) {
  console.error(`agent is not configured: ${readiness.reason}`);
  process.exit(1);
}
const procedureName = process.argv[2] ?? 'sp_CalculateOrderTotal';
const limit = process.argv[3] === undefined || process.argv[3] === '' ? undefined : Number(process.argv[3]);

// Which replacement. `reference` is M5's hand-written service — the positive control, the only
// implementation that diverges, and therefore the standing proof this harness can still find a
// real behavioural difference. `generated` is what the agent wrote. Defaulting to `reference`
// keeps every existing invocation of this command meaning exactly what it meant at M5.
const implementation = process.argv[4] === 'generated' ? 'generated' : 'reference';

const store = openStore(config.pgUrl);
await waitForPostgres(store.pool);
await applyMigrations(store.db);
await seedPolicy(store.db);

const result = await runShadow(store.db, config, {
  procedureName,
  limit,
  implementation,
  onProgress: (message) => console.log(`  ${message}`),
});

console.log(
  `\nreplay: ${result.casesReplayed} cases, ${result.strataCovered}/${result.strataObserved} strata, ` +
    `${(result.replayMs / 1000).toFixed(1)}s (${(result.replayMs / result.casesReplayed).toFixed(1)} ms/case)`,
);
console.log(`shadow database: ${result.shadowDatabase}`);
console.log(`implementation: ${result.implementation}`);
console.log(
  `differences: ${result.rawDiffs} raw, ${result.resolvedByCanonicaliser} resolved by canonicalisation, ` +
    `${result.surviving} survived`,
);

for (const finding of result.findings) {
  console.log(`  ${finding.signature} — ${finding.cases} cases, ${finding.rowsAffected} rows`);
}

const classified = await classifyRun(store.db, config, result, (message) => console.log(`  ${message}`));
console.log(
  `\nclassified ${classified.findings.length} findings in ${classified.runs} model runs: ` +
    `${classified.noise} noise, ${classified.behaviourChange} behaviour_change`,
);
for (const verdict of classified.verdicts) {
  console.log(`  ${verdict.verdict === 'noise' ? `noise (${verdict.reason})` : 'BEHAVIOUR CHANGE'}  ${verdict.signature}`);
  if (verdict.explanationCs) console.log(`      ${verdict.explanationCs}`);
}

console.log(`\ntotal ${(result.durationMs / 1000).toFixed(1)}s`);
await store.pool.end();
