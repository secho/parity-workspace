// The claim the replay source exists for: **beat 1's empty estate and a replayed beat 2 are
// compatible.**
//
// This probe does the destructive thing for real, because there is no honest way to fake it. It
// runs exactly what `make demo-reset` runs — `resetState` then `ingest` — and then replays a
// triage and a spec into the emptied database and reads back what arrived. If the recordings had
// stayed in the live database, step two would refuse; that refusal is the whole reason the source
// is a second database.
//
// **`verify-m7` runs `make restore-golden` immediately afterwards, in a `finally`.** This probe
// leaves the estate reset, and says so in its output rather than tidying up behind itself: a probe
// that restored its own damage would be asserting the restore works using the restore.
//
// What it measures, and why each one is the interesting number:
//
//   - the spec that arrived is **byte-identical** to the recorded one. Length alone would pass on
//     a truncated copy, and the transcript really does carry a truncated copy — `runner.ts` cuts
//     every tool input at 2 000 characters, so a replay that rebuilt the spec from its own steps
//     would produce exactly 2 000 characters of a 15 368-character document;
//   - `oracle_class` and `campaign_status` came back, which is what moves the blocker table on
//     screen and is not in the transcript either;
//   - nothing was spent.

import { eq, sql } from 'drizzle-orm';
import { openStore, waitForPostgres } from '../db/client.js';
import { agentRuns, procedures, specs } from '../db/schema.js';
import { loadConfig } from '../env.js';
import { executeRun, specRun, triageRun } from '../agent/runner.js';
import { ingest, resetState } from '../ingest/run.js';
import { procedureIdByName, replaySource } from '../replay/source.js';

const TARGET = process.argv[2] ?? 'sp_CalculateOrderTotal';
const config = { ...loadConfig(), mode: 'replay' };

const store = openStore(config.pgUrl);
await waitForPostgres(store.pool);

const spend = async (): Promise<number> => {
  const [row] = await store.db.select({ total: sql<string>`coalesce(sum(${agentRuns.costUsd}), 0)` }).from(agentRuns);
  return Number(row.total);
};

// What the recording holds, read before anything is destroyed.
const source = await replaySource(config);
const sourceProcedureId = await procedureIdByName(source, TARGET);
const [recordedSpec] = await source
  .select()
  .from(specs)
  .where(eq(specs.procedureId, sourceProcedureId ?? -1));
const [recordedProcedure] = await source
  .select()
  .from(procedures)
  .where(eq(procedures.id, sourceProcedureId ?? -1));

// --- the reset, for real ---------------------------------------------------------------------
// Exactly `src/cli/reset.ts`'s two statements. Not a stand-in for demo-reset — it IS demo-reset.
await resetState(store.db);
const estate = await ingest(store.db, config);

// Measured AFTER the reset, which took the whole cost history with it. The question this answers
// is "did the replay spend anything", and the only baseline that answers it is the one on the
// other side of the reset — comparing against $23.95 of history the truncate just deleted would
// be comparing two different databases.
const spendAtBlank = await spend();

const emptied = {
  procedures: estate.procedures,
  agentRuns: (await store.db.select({ n: sql<number>`count(*)::int` }).from(agentRuns))[0].n,
  specs: (await store.db.select({ n: sql<number>`count(*)::int` }).from(specs))[0].n,
};

// --- and the replay into it ------------------------------------------------------------------
const started = Date.now();
const triage = await executeRun(store.db, config, triageRun(TARGET));
const spec = await executeRun(store.db, config, specRun(TARGET));
const elapsedMs = Date.now() - started;

const liveProcedureId = await procedureIdByName(store.db, TARGET);
const [liveSpec] = await store.db.select().from(specs).where(eq(specs.procedureId, liveProcedureId ?? -1));
const [liveProcedure] = await store.db.select().from(procedures).where(eq(procedures.id, liveProcedureId ?? -1));

console.log(
  JSON.stringify(
    {
      procedure: TARGET,
      // The estate survives a reset; the analysis does not. Both halves matter: fourteen
      // procedures is an estate fact and beat 1 opens on it.
      afterReset: emptied,
      replay: {
        elapsedMs,
        triageReplayedFrom: (await runRow(triage.agentRunId))?.replayedFrom ?? null,
        specReplayedFrom: (await runRow(spec.agentRunId))?.replayedFrom ?? null,
        materialised: { triage: triage.materialised ?? null, spec: spec.materialised ?? null },
      },
      spec: {
        recordedChars: recordedSpec?.markdown.length ?? 0,
        liveChars: liveSpec?.markdown.length ?? 0,
        // The load-bearing comparison. A transcript-rebuilt spec would be 2 000 characters.
        identical: (recordedSpec?.markdown ?? null) === (liveSpec?.markdown ?? undefined),
        // And it is attributed to the run whose steps are on screen, not to a run in another
        // database that this one cannot reach.
        agentRunId: liveSpec?.agentRunId ?? null,
        replayedRunId: spec.agentRunId,
      },
      classification: {
        recorded: recordedProcedure?.oracleClass ?? null,
        live: liveProcedure?.oracleClass ?? null,
        campaignStatus: liveProcedure?.campaignStatus ?? null,
      },
      spend: { atBlank: spendAtBlank, afterReplay: await spend() },
      note: 'the estate is left RESET on purpose — verify-m7 restores it',
    },
    null,
    2,
  ),
);

async function runRow(id: number): Promise<{ replayedFrom: number | null } | undefined> {
  const [row] = await store.db.select({ replayedFrom: agentRuns.replayedFrom }).from(agentRuns).where(eq(agentRuns.id, id));
  return row;
}

await store.pool.end();
