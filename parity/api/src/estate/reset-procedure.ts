import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
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

/**
 * Put ONE procedure back to "nothing analysed yet", and leave the others exactly as they were.
 *
 * `make demo-reset` is all-or-nothing by design — beat 1 opens on an estate where nothing has
 * been analysed — but rehearsing the lane on one procedure should not cost the other thirteen
 * their analysis. That analysis is roughly $16 of live model runs and the better part of an hour.
 *
 * Scoped DELETEs rather than TRUNCATE, and the cascades do the rest: every artefact table keys
 * on `procedure_id` with ON DELETE CASCADE, so removing an `agent_runs` row takes its steps and
 * audit entries with it, and removing a `shadow_runs` row takes its cases, diffs and decisions.
 * `verify-m7` checks the other procedure's row counts are **identical** afterwards, which is the
 * assertion that fails the moment someone reaches for TRUNCATE here.
 *
 * What it deliberately does NOT touch:
 *   - the `procedures` row itself. Fourteen procedures is an estate fact, not analysis, and the
 *     Estate screen must still list it.
 *   - `procedure_columns`, `procedure_calls`, `coupling_edges`. These come from the parser, not
 *     from any agent, and `ingest` rebuilds them globally. Clearing them here would leave the
 *     coupling graph with a hole until the next full ingest.
 *   - the estate itself. Nothing here opens a connection to MS SQL.
 *
 * A function rather than a script body so that `probe-reset-procedure` can run the real thing
 * inside a transaction it rolls back. A gate that had to destroy a procedure's analysis to check
 * that the reset works is a gate nobody runs twice.
 */

/** Whatever `db.transaction()` hands its callback — the same surface `Db` offers for this. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface ResetOutcome {
  found: boolean;
  before: { oracleClass: string | null; oracleState: string; campaignStatus: string };
  deleted: Record<string, number>;
}

export async function resetProcedure(db: Db | Tx, procedureName: string): Promise<ResetOutcome> {
  const [procedure] = await db.select().from(procedures).where(eq(procedures.name, procedureName));
  if (procedure === undefined) {
    return { found: false, before: { oracleClass: null, oracleState: '', campaignStatus: '' }, deleted: {} };
  }

  const id = procedure.id;
  const deleted: Record<string, number> = {};
  const count = async (label: string, run: () => Promise<unknown>): Promise<void> => {
    const result = (await run()) as { rowCount?: number | null };
    deleted[label] = result?.rowCount ?? 0;
  };

  await count('shadow_runs', () => db.delete(shadowRuns).where(eq(shadowRuns.procedureId, id)));
  await count('oracle_runs', () => db.delete(oracleRuns).where(eq(oracleRuns.procedureId, id)));
  await count('golden_tests', () => db.delete(goldenTests).where(eq(goldenTests.procedureId, id)));
  await count('invariants', () => db.delete(invariants).where(eq(invariants.procedureId, id)));
  await count('specs', () => db.delete(specs).where(eq(specs.procedureId, id)));
  await count('service_artifacts', () => db.delete(serviceArtifacts).where(eq(serviceArtifacts.procedureId, id)));
  await count('pull_requests', () => db.delete(pullRequests).where(eq(pullRequests.procedureId, id)));
  // Last, because everything above carries a nullable `agent_run_id` that is set to null when a
  // run is deleted. Deleting the runs first would leave those rows briefly orphaned inside the
  // transaction for no benefit.
  await count('agent_runs', () => db.delete(agentRuns).where(eq(agentRuns.procedureId, id)));

  await db
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

  return {
    found: true,
    before: {
      oracleClass: procedure.oracleClass,
      oracleState: procedure.oracleState,
      campaignStatus: procedure.campaignStatus,
    },
    deleted,
  };
}
