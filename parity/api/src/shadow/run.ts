import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { diffs as diffsTable, procedures, shadowCases, shadowRuns } from '../db/schema.js';
import type { Config } from '../env.js';
import { connect } from '../ingest/mssql.js';
import { readIdentityColumns, readParameters } from '../oracle/execute.js';
import { selectCases, DEFAULT_CASE_LIMIT } from './cases.js';
import { readColumns, readTrackedTables } from './changetracking.js';
import { connectShadowRunner, revertShadow, shadowReadiness } from './database.js';
import { diffCase, findings, type CaseDiff, type Finding } from './diff.js';
import { releaseService, replayProcedure, replayService, type ReplayOutcome } from './replay.js';

/**
 * One shadow run, end to end.
 *
 *   revert → pass A (the procedure) → revert → pass B (the replacement) → revert → diff
 *
 * Both passes start from the same restored state and apply the same cases in the same order,
 * which is the only way two sides can be said to have seen the same database. The reverts are
 * ~450 ms each on this estate, so the isolation costs about a second and a half of a run that
 * takes twenty.
 *
 * The final revert is not tidiness. It leaves the shadow database ready for the next run, and
 * it means the state a human inspects after a run is the state the run started from rather
 * than whatever the last case happened to leave.
 */

/** The negative control replays the procedure against itself and must find nothing. */
export type ShadowKind = 'shadow' | 'aa';

export interface ShadowOptions {
  procedureName: string;
  kind?: ShadowKind;
  limit?: number;
  onProgress?: (message: string) => void;
}

export interface ShadowResult {
  shadowRunId: number;
  procedureName: string;
  casesReplayed: number;
  strataCovered: number;
  strataObserved: number;
  rawDiffs: number;
  resolvedByCanonicaliser: number;
  surviving: number;
  findings: Finding[];
  replayMs: number;
  durationMs: number;
  shadowDatabase: string;
}

export async function runShadow(db: Db, config: Config, options: ShadowOptions): Promise<ShadowResult> {
  const started = Date.now();
  const kind: ShadowKind = options.kind ?? 'shadow';
  const limit = options.limit ?? DEFAULT_CASE_LIMIT;
  const say = options.onProgress ?? ((): void => undefined);

  const [procedure] = await db.select().from(procedures).where(eq(procedures.name, options.procedureName));
  if (procedure === undefined) throw new Error(`no procedure named ${options.procedureName} in the estate`);

  const readiness = await shadowReadiness(config);
  if (!readiness.ready) throw new Error(readiness.reason ?? 'shadow database is not ready');

  // Cases come from the estate's capture, read with the analysis login. Nothing about
  // selecting what to replay touches the shadow database, and nothing about replaying it
  // touches the estate.
  const estate = await connect(config);
  const selection = await selectCases(estate, options.procedureName, limit);
  await estate.close();
  say(`${selection.cases.length} cases over ${selection.strata} strata`);

  const implementation = kind === 'aa' ? `${options.procedureName} (A/A control)` : 'pricing-service (hand-written, M5)';
  const [run] = await db
    .insert(shadowRuns)
    .values({
      procedureId: procedure.id,
      status: 'running',
      implementation,
      kind,
      shadowDatabase: config.mssql.shadowDatabase,
      casesPlanned: selection.cases.length,
      strataObserved: selection.strata,
    })
    .returning();

  try {
    let pool = await connectShadowRunner(config);
    const parameters = await readParameters(pool, options.procedureName);
    const identityColumns = await readIdentityColumns(pool);
    const context = { tracked: await readTrackedTables(pool), columns: await readColumns(pool) };
    await pool.close();

    const reset = async (): Promise<void> => {
      await releaseService(config.pricingServiceUrl);
      await revertShadow(config);
    };

    await reset();
    const replayStarted = Date.now();

    pool = await connectShadowRunner(config);
    const passA = await replayProcedure(pool, options.procedureName, parameters, selection.cases, context, (done) => {
      if (done % 50 === 0) say(`pass A ${done}/${selection.cases.length}`);
    });
    await pool.close();

    await reset();

    pool = await connectShadowRunner(config);
    const passB =
      kind === 'aa'
        ? await replayProcedure(pool, options.procedureName, parameters, selection.cases, context, (done) => {
            if (done % 50 === 0) say(`pass B ${done}/${selection.cases.length}`);
          })
        : await replayService(pool, config.pricingServiceUrl, options.procedureName, selection.cases, context, (done) => {
            if (done % 50 === 0) say(`pass B ${done}/${selection.cases.length}`);
          });
    await pool.close();

    const replayMs = Date.now() - replayStarted;
    await reset();

    // --- diff, in code, before anything is shown to a model ----------------
    const perCase = selection.cases.map((replayCase, index) => ({
      seq: index,
      sourceInvocationId: replayCase.invocationId,
      stratum: replayCase.stratum,
      branchKey: replayCase.branchKey,
      params: replayCase.params,
      old: passA[index],
      neu: passB[index],
      diff: diffCase(passA[index], passB[index], { identityColumns }),
    }));

    const persisted = await persist(db, run.id, perCase);
    const surviving = perCase.flatMap((c) => c.diff.diffs).filter((d) => !d.canonicalEqual);
    const found = findings(perCase);

    const result: ShadowResult = {
      shadowRunId: run.id,
      procedureName: options.procedureName,
      casesReplayed: perCase.length,
      strataCovered: new Set(perCase.map((c) => c.stratum)).size,
      strataObserved: selection.strata,
      rawDiffs: persisted.rawDiffs,
      resolvedByCanonicaliser: persisted.rawDiffs - surviving.length,
      surviving: surviving.length,
      findings: found,
      replayMs,
      durationMs: Date.now() - started,
      shadowDatabase: config.mssql.shadowDatabase,
    };

    await db
      .update(shadowRuns)
      .set({
        status: 'succeeded',
        casesReplayed: result.casesReplayed,
        strataCovered: result.strataCovered,
        rawDiffs: result.rawDiffs,
        noiseDiffs: result.resolvedByCanonicaliser,
        replayMs,
        durationMs: result.durationMs,
        finishedAt: new Date(),
      })
      .where(eq(shadowRuns.id, run.id));

    // A shadow run existed, so `oracle_state` moves to `shadow` and the blocker becomes
    // `čeká na rozhodnutí`. It moves on the fact of the run, not on its verdicts: what the
    // run found is the queue's business, and a run that found nothing is still a run.
    //
    // `proven` is M6's to grant, after the agent-generated service replays green against a
    // decision that has actually been taken. The A/A control never promotes anything — it is
    // a test of the harness, not of the estate.
    if (kind !== 'aa') {
      await db
        .update(procedures)
        .set({ oracleState: 'shadow', campaignStatus: 'shadow' })
        .where(eq(procedures.id, procedure.id));
    }

    say(
      `${result.casesReplayed} cases, ${result.rawDiffs} raw differences, ` +
        `${result.resolvedByCanonicaliser} resolved in code, ${result.surviving} to classify ` +
        `across ${found.length} findings`,
    );
    return result;
  } catch (err) {
    await db
      .update(shadowRuns)
      .set({
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
        finishedAt: new Date(),
      })
      .where(eq(shadowRuns.id, run.id));
    throw err;
  }
}

interface CaseRecord {
  seq: number;
  sourceInvocationId: number;
  stratum: string;
  branchKey: string | null;
  params: Record<string, unknown>;
  old: ReplayOutcome;
  neu: ReplayOutcome;
  diff: CaseDiff;
}

async function persist(db: Db, shadowRunId: number, perCase: CaseRecord[]): Promise<{ rawDiffs: number }> {
  let rawDiffs = 0;

  for (const record of perCase) {
    // Whole canonical outcomes only for cases that differ. A four-hundred-case run holds two
    // tables of row images on both sides; keeping every one of them would put tens of
    // megabytes into Postgres per run for rows nobody opens. An agreeing case keeps its
    // fingerprint, which is the whole of the evidence that it agreed.
    const keepOutcome = !record.diff.equal;

    const [row] = await db
      .insert(shadowCases)
      .values({
        shadowRunId,
        seq: record.seq,
        sourceInvocationId: record.sourceInvocationId,
        branchKey: record.branchKey,
        stratum: record.stratum,
        inputParams: record.params,
        equal: record.diff.equal,
        oldFingerprint: record.diff.oldFingerprint,
        newFingerprint: record.diff.newFingerprint,
        oldOutcome: keepOutcome ? record.diff.oldCanonical : null,
        newOutcome: keepOutcome ? record.diff.newCanonical : null,
        oldNormalisations: record.diff.oldCanonical.normalisations,
        newNormalisations: record.diff.newCanonical.normalisations,
        oldError: record.old.error,
        newError: record.neu.error,
        oldMs: record.old.durationMs,
        newMs: record.neu.durationMs,
      })
      .returning();

    if (record.diff.diffs.length === 0) continue;
    rawDiffs += record.diff.diffs.length;

    await db.insert(diffsTable).values(
      record.diff.diffs.map((diff) => ({
        shadowRunId,
        shadowCaseId: row.id,
        scope: diff.scope,
        tableName: diff.tableName,
        columnName: diff.columnName,
        rowsAffected: diff.rowsAffected,
        oldValue: diff.oldValue ?? null,
        newValue: diff.newValue ?? null,
        signature: diff.signature,
        canonicalEqual: diff.canonicalEqual,
        // Resolved in code: the verdict is recorded now and no agent run is attached, which
        // is what `verify-m5` reads back as proof the model never saw it.
        verdict: diff.canonicalEqual ? 'noise' : null,
        verdictSource: diff.canonicalEqual ? 'canonicaliser' : null,
        noiseReason: diff.noiseReason,
      })),
    );
  }

  return { rawDiffs };
}
