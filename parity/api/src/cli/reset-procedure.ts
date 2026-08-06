// `make reset-procedure PROC=x`. Put one procedure back to "nothing analysed yet", and leave
// the other thirteen exactly as they were.
//
// `make demo-reset` is all-or-nothing by design — beat 1 opens on an estate where nothing has
// been analysed — but rehearsing the lane on one procedure should not cost the other thirteen
// their analysis. That analysis is roughly $16 of live model runs, and re-running it takes the
// better part of an hour.
//
// Scoped DELETEs rather than TRUNCATE, and the cascades do the rest: every artefact table keys
// on procedure_id with ON DELETE CASCADE, so removing an `agent_runs` row takes its steps and
// audit entries with it, and removing a `shadow_runs` row takes its cases, diffs and decisions.
//
// What it deliberately does NOT touch:
//   - the `procedures` row itself. Fourteen procedures is an estate fact, not analysis, and the
//     Estate screen must still list it.
//   - `procedure_columns`, `procedure_calls`, `coupling_edges`. These come from the parser, not
//     from any agent, and `ingest` rebuilds them globally. Clearing them here would leave the
//     coupling graph with a hole until the next full ingest.
//   - the estate itself. Nothing here opens a connection to MS SQL.

import { eq } from 'drizzle-orm';
import { openStore, waitForPostgres } from '../db/client.js';
import { applyMigrations } from '../db/migrate.js';
import { loadConfig } from '../env.js';
import {
  agentRuns,
  goldenTests,
  invariants,
  oracleRuns,
  procedures,
  pullRequests,
  serviceArtifacts,
  shadowRuns,
  specs,
} from '../db/schema.js';

const config = loadConfig();
const procedureName = process.argv[2];

if (procedureName === undefined || procedureName === '') {
  console.error('usage: reset-procedure.ts <procedure-name>');
  process.exit(1);
}

const store = openStore(config.pgUrl);
await waitForPostgres(store.pool);
await applyMigrations(store.db);

const [procedure] = await store.db.select().from(procedures).where(eq(procedures.name, procedureName));
if (procedure === undefined) {
  console.error(`no procedure named ${procedureName} — nothing to reset`);
  await store.pool.end();
  process.exit(1);
}

const id = procedure.id;
const before = {
  state: procedure.oracleState,
  campaign: procedure.campaignStatus,
  class: procedure.oracleClass,
};

const counted: Record<string, number> = {};
const count = async (label: string, run: () => Promise<{ rowCount?: number | null } | unknown[]>): Promise<void> => {
  const result = (await run()) as { rowCount?: number | null };
  counted[label] = result?.rowCount ?? 0;
};

// One transaction. A half-reset procedure — say, specs gone but golden tests still citing an
// agent run that no longer exists — is a worse state than either end of the operation.
await store.db.transaction(async (tx) => {
  await count('shadow_runs', () => tx.delete(shadowRuns).where(eq(shadowRuns.procedureId, id)));
  await count('oracle_runs', () => tx.delete(oracleRuns).where(eq(oracleRuns.procedureId, id)));
  await count('golden_tests', () => tx.delete(goldenTests).where(eq(goldenTests.procedureId, id)));
  await count('invariants', () => tx.delete(invariants).where(eq(invariants.procedureId, id)));
  await count('specs', () => tx.delete(specs).where(eq(specs.procedureId, id)));
  await count('service_artifacts', () => tx.delete(serviceArtifacts).where(eq(serviceArtifacts.procedureId, id)));
  await count('pull_requests', () => tx.delete(pullRequests).where(eq(pullRequests.procedureId, id)));
  // Last, because everything above carries a nullable agent_run_id that is set to null when a
  // run is deleted. Deleting the runs first would leave those rows briefly orphaned inside the
  // transaction for no benefit.
  await count('agent_runs', () => tx.delete(agentRuns).where(eq(agentRuns.procedureId, id)));

  await tx
    .update(procedures)
    .set({
      oracleClass: null,
      oracleState: 'none',
      campaignStatus: 'untouched',
      riskClass: null,
      seamRequirements: null,
      domain: null,
    })
    .where(eq(procedures.id, id));
});

console.log(`reset ${procedureName}`);
console.log(`  was ${before.class ?? 'untriaged'} · ${before.state} · ${before.campaign}`);
for (const [table, n] of Object.entries(counted).filter(([, n]) => n > 0)) {
  console.log(`  ${String(n).padStart(5)}  ${table}`);
}
console.log('  now untriaged · none · untouched');

// The other thirteen, so the caller can see at a glance that nothing else moved.
const others = await store.db.select().from(procedures);
const analysed = others.filter((p) => p.id !== id && p.oracleState !== 'none').length;
console.log(`  ${analysed} other procedures still analysed`);

// The generated service on disk is the host's business — parity-api has no mount into the demo
// app, deliberately. Said rather than silently left behind.
console.log(`\nthe generated service source is on the host: parity-platform-demo-app/pricing-service-generated/src/${procedureName}/`);

await store.pool.end();
