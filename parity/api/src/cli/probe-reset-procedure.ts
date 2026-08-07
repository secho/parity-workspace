// What `verify-m7` shells out to for the per-procedure reset.
//
// `make reset-procedure PROC=sp_GetCartSummary` really does delete its specification, its
// eleven golden cases, its shadow run and the service the agent wrote — about $1.39 and twenty
// minutes. So the gate runs the real function inside a transaction and rolls it back, the same
// way `probe-reset` does for `demo-reset`.
//
// The number that matters is not what disappears. It is what does NOT: every count for the
// OTHER procedure, across all ten artefact tables, has to be identical afterwards. That is the
// assertion that fails the moment someone reaches for TRUNCATE in here, and it is the whole
// reason this command exists.

import { and, eq, sql } from 'drizzle-orm';
import { openStore, waitForPostgres } from '../db/client.js';
import {
  agentRuns,
  agentSteps,
  auditEntries,
  diffs,
  goldenResults,
  goldenTests,
  invariantResults,
  invariants,
  oracleRuns,
  procedures,
  pullRequests,
  serviceArtifacts,
  shadowCases,
  shadowRuns,
  specs,
} from '../db/schema.js';
import { loadConfig } from '../env.js';
import { resetProcedure, type ResetOutcome } from '../estate/reset-procedure.js';

const TARGET = process.argv[2] ?? 'sp_GetCartSummary';
const KEEP = process.argv[3] ?? 'sp_CalculateOrderTotal';

const config = loadConfig();
const store = openStore(config.pgUrl);
await waitForPostgres(store.pool);

type Tx = Parameters<Parameters<typeof store.db.transaction>[0]>[0];

/**
 * Everything one procedure owns, counted through the joins that actually key on it.
 *
 * Ten tables, including the four that are only reachable through another row — `agent_steps`
 * and `audit_entries` through `agent_runs`, `shadow_cases` and `diffs` through `shadow_runs`,
 * the two result tables through `oracle_runs`. Those are the ones a careless DELETE would
 * orphan rather than remove, and counting them directly is the only way to see it.
 */
async function ownedBy(db: Tx, name: string): Promise<Record<string, number>> {
  const [procedure] = await db.select({ id: procedures.id }).from(procedures).where(eq(procedures.name, name));
  if (procedure === undefined) return {};
  const id = procedure.id;
  const one = async (label: string, run: Promise<{ n: number }[]>): Promise<[string, number]> => [label, (await run)[0].n];
  const n = sql<number>`count(*)::int`;

  return Object.fromEntries(
    await Promise.all([
      one('specs', db.select({ n }).from(specs).where(eq(specs.procedureId, id))),
      one('agent_runs', db.select({ n }).from(agentRuns).where(eq(agentRuns.procedureId, id))),
      one(
        'agent_steps',
        db.select({ n }).from(agentSteps).innerJoin(agentRuns, eq(agentRuns.id, agentSteps.agentRunId)).where(eq(agentRuns.procedureId, id)),
      ),
      one(
        'audit_entries',
        db
          .select({ n })
          .from(auditEntries)
          .innerJoin(agentRuns, eq(agentRuns.id, auditEntries.agentRunId))
          .where(eq(agentRuns.procedureId, id)),
      ),
      one('golden_tests', db.select({ n }).from(goldenTests).where(eq(goldenTests.procedureId, id))),
      one('invariants', db.select({ n }).from(invariants).where(eq(invariants.procedureId, id))),
      one('oracle_runs', db.select({ n }).from(oracleRuns).where(eq(oracleRuns.procedureId, id))),
      one(
        'golden_results',
        db
          .select({ n })
          .from(goldenResults)
          .innerJoin(oracleRuns, eq(oracleRuns.id, goldenResults.oracleRunId))
          .where(eq(oracleRuns.procedureId, id)),
      ),
      one(
        'invariant_results',
        db
          .select({ n })
          .from(invariantResults)
          .innerJoin(oracleRuns, eq(oracleRuns.id, invariantResults.oracleRunId))
          .where(eq(oracleRuns.procedureId, id)),
      ),
      one('shadow_runs', db.select({ n }).from(shadowRuns).where(eq(shadowRuns.procedureId, id))),
      one(
        'shadow_cases',
        db
          .select({ n })
          .from(shadowCases)
          .innerJoin(shadowRuns, eq(shadowRuns.id, shadowCases.shadowRunId))
          .where(eq(shadowRuns.procedureId, id)),
      ),
      one(
        'diffs',
        db.select({ n }).from(diffs).innerJoin(shadowRuns, eq(shadowRuns.id, diffs.shadowRunId)).where(eq(shadowRuns.procedureId, id)),
      ),
      one('service_artifacts', db.select({ n }).from(serviceArtifacts).where(eq(serviceArtifacts.procedureId, id))),
      one('pull_requests', db.select({ n }).from(pullRequests).where(eq(pullRequests.procedureId, id))),
    ]),
  );
}

let out: Record<string, unknown> = {};

try {
  await store.db.transaction(async (tx) => {
    const targetBefore = await ownedBy(tx, TARGET);
    const keepBefore = await ownedBy(tx, KEEP);
    const proceduresBefore = (await tx.select({ n: sql<number>`count(*)::int` }).from(procedures))[0].n;

    const started = Date.now();
    const first: ResetOutcome = await resetProcedure(tx, TARGET);
    const elapsedMs = Date.now() - started;

    const targetAfter = await ownedBy(tx, TARGET);
    const keepAfter = await ownedBy(tx, KEEP);
    const proceduresAfter = (await tx.select({ n: sql<number>`count(*)::int` }).from(procedures))[0].n;

    // Again. A reset that is not idempotent is a reset that cannot be run twice in a rehearsal,
    // and a second run must delete nothing rather than fail.
    const second = await resetProcedure(tx, TARGET);

    const [row] = await tx
      .select({
        oracleClass: procedures.oracleClass,
        oracleState: procedures.oracleState,
        campaignStatus: procedures.campaignStatus,
      })
      .from(procedures)
      .where(and(eq(procedures.name, TARGET)));

    const missing = await tx.select({ n: sql<number>`count(*)::int` }).from(procedures).where(eq(procedures.name, TARGET));

    out = {
      target: TARGET,
      keep: KEEP,
      elapsedMs,
      before: { target: targetBefore, keep: keepBefore, procedures: proceduresBefore },
      after: { target: targetAfter, keep: keepAfter, procedures: proceduresAfter },
      deleted: first.deleted,
      wasState: first.before,
      nowState: row ?? null,
      stillListed: missing[0].n === 1,
      idempotent: Object.values(second.deleted).every((n) => n === 0),
      // Every table the OTHER procedure owns, unchanged. Reported as the comparison rather than
      // as two objects the gate has to line up itself.
      otherProcedureUntouched: Object.entries(keepBefore).every(([table, n]) => keepAfter[table] === n),
      targetEmptied: Object.values(targetAfter).every((n) => n === 0),
      tablesChecked: Object.keys(keepBefore).sort(),
    };

    // Drizzle spells ROLLBACK by throwing. Everything above is measured; nothing is kept.
    tx.rollback();
  });
} catch {
  // The rollback itself.
}

// Read back outside the transaction: the analysis this probe just pretended to destroy has to
// still be there, or the probe is worse than the thing it is checking.
const restored = await store.db.transaction(async (tx) => ({
  target: await ownedBy(tx, TARGET),
  keep: await ownedBy(tx, KEEP),
}));

console.log(JSON.stringify({ ...out, restored }, null, 2));

await store.pool.end();
