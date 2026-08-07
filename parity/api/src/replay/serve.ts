import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentRuns, agentSteps, diffs, procedures, shadowCases, shadowRuns } from '../db/schema.js';
import type { Config } from '../env.js';
import type { RunHandle, StartRun, StepListener } from '../agent/runner.js';
import type { Finding } from '../shadow/diff.js';
import type { ShadowImplementation, ShadowOptions, ShadowResult } from '../shadow/run.js';
import { materialiseArtefacts } from './materialise.js';
import { procedureIdByName, replaySource } from './source.js';
import { replaySpeed } from './mode.js';
import { findRecording, playRecording } from './stream.js';

/**
 * `PARITY_MODE=replay` — serving a recorded run instead of making one.
 *
 * Two shims, one for each kind of run the platform makes, and they share a shape:
 *
 *  1. find the recording, and **refuse loudly if there is none**;
 *  2. create a real row for the replay, marked `replayed_from`;
 *  3. re-materialise what the recording produced, progressively, at the recorded cadence;
 *  4. spend nothing and touch no estate.
 *
 * Step 3 is the one that is easy to get wrong. The obvious implementation streams the recorded
 * steps to the browser and writes nothing — and it produces a completely empty screen, because
 * `Procedure.tsx` uses the SSE event as a *signal to refetch* and discards the payload. The
 * table is the interface. So the rows are written as the replay proceeds, and the event goes out
 * after the insert.
 *
 * The recordings come from a SECOND database (`./source.ts`), which `make demo-reset` cannot
 * reach. That is what makes beat 1's empty estate and a replayed beat 2 compatible: the reset
 * truncates `agent_runs` and `agent_steps` along with everything else, so recordings kept in the
 * live database could only ever re-show what was already on the screen.
 *
 * And a run does not only emit steps — it **produced** something. The spec, the golden cases, the
 * service. Those are copied from the source as the run finishes (`./materialise.ts`), because
 * `runner.ts` truncates every tool input to 2 000 characters and the payload was never in the
 * transcript to begin with.
 *
 * A replay whose recording is missing throws rather than emitting nothing, because a silent
 * empty replay is indistinguishable from a model that returned nothing, which is precisely the
 * failure a replay must not be able to have.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serve one agent run from its recording.
 *
 * The new row carries the recorded model, turn count and output — that is what is being
 * replayed and the screen should say so — but `cost_usd` and the token counts stay NULL,
 * because nothing was spent. `verify-m7` reads the estate's total cost before and after a
 * replay and requires it not to move; a row that copied the recorded cost would make that
 * check fail, and copying it would be a lie in the one column that measures whether replay
 * is doing what it claims.
 *
 * No audit rows either. The audit log falls out of the `PostToolUse` hook, no hook fired, and
 * inventing entries would break the claim that nothing in it is instrumented by hand.
 */
export async function replayAgentRun(
  db: Db,
  config: Config,
  request: StartRun,
  onStep?: StepListener,
): Promise<RunHandle> {
  if (request.procedureName === null) {
    throw new Error(`replay mode: ${request.skillName} has no procedure, so there is nothing to look a recording up by`);
  }

  const source = await replaySource(config);
  const recording = await findRecording(source, {
    skill: request.skillName,
    procedureName: request.procedureName,
  });
  if (recording === null) {
    throw new Error(
      `replay mode: no recorded ${request.skillName} run for ${request.procedureName} in the ` +
        'replay source. Run `make load-replay-source`, or run live. A replay of nothing is not a replay.',
    );
  }

  const procedureId = await procedureIdByName(db, request.procedureName);

  const runId = randomUUID();
  const started = Date.now();
  const [run] = await db
    .insert(agentRuns)
    .values({
      runId,
      skill: recording.skill,
      taskClass: request.taskClass,
      procedureId,
      status: 'running',
      provider: recording.provider,
      prompt: request.prompt,
      replayedFrom: recording.agentRunId,
    })
    .returning({ id: agentRuns.id });

  await playRecording(recording, async (step) => {
    await db.insert(agentSteps).values({ agentRunId: run.id, ...step });
    onStep?.(step);
  });

  // What the run PRODUCED, not just what it said. Written after the last step and before the run
  // is marked succeeded, so a screen refreshing on that final event finds the artefact already
  // there rather than a run that finished and left nothing behind.
  const materialised = await materialiseArtefacts(db, source, {
    skill: recording.skill,
    procedureName: request.procedureName,
    agentRunId: run.id,
  });

  await db
    .update(agentRuns)
    .set({
      status: 'succeeded',
      model: recording.model,
      output: recording.output,
      numTurns: recording.numTurns,
      durationMs: Date.now() - started,
      finishedAt: new Date(),
    })
    .where(eq(agentRuns.id, run.id));

  return {
    runId,
    agentRunId: run.id,
    materialised: materialised.rows,
    result: {
      model: recording.model,
      // Empty, and honestly so: no SDK session was created, so no skill was loaded into one.
      skillsLoaded: [],
      text: recording.output ?? '',
      isError: false,
      stopReason: 'replay',
      numTurns: recording.numTurns ?? 0,
      durationMs: Date.now() - started,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      permissionDenials: [],
    },
    blocked: [],
  };
}

interface ReplayedShadow {
  result: ShadowResult;
  procedureId: number;
  findingCount: number;
}

/**
 * Serve one shadow run from its recording — without opening a single database connection.
 *
 * That is the whole difference, and it is why `shadow_runs.replayed_from` exists: a replayed
 * run leaves the estate's fingerprint and the shadow copy's fingerprint exactly where they
 * were, so a row that did not say it was a replay would be indistinguishable from one that had
 * genuinely replayed four hundred calls against a restored database.
 *
 * The cases and their differences are copied, verdicts and all, so the queue fills the way it
 * did on the day. `replay_ms` is the recorded number rather than the wall clock this took —
 * it is a fact about the run being replayed, and it is the number beat 3 quotes. `duration_ms`
 * is what actually elapsed here.
 */
export async function replayShadowRun(db: Db, config: Config, options: ShadowOptions): Promise<ReplayedShadow> {
  const kind = options.kind ?? 'shadow';
  const implementationId: ShadowImplementation = options.implementation ?? 'reference';
  const say = options.onProgress ?? ((): void => undefined);
  const started = Date.now();

  const [procedure] = await db.select().from(procedures).where(eq(procedures.name, options.procedureName));
  if (procedure === undefined) throw new Error(`no procedure named ${options.procedureName} in the estate`);

  const source = await replaySource(config);
  const sourceProcedureId = await procedureIdByName(source, options.procedureName);
  if (sourceProcedureId === null) {
    throw new Error(`replay mode: the replay source has no procedure named ${options.procedureName}`);
  }

  const [recorded] = await source
    .select()
    .from(shadowRuns)
    .where(
      and(
        eq(shadowRuns.procedureId, sourceProcedureId),
        eq(shadowRuns.kind, kind),
        eq(shadowRuns.implementationId, kind === 'aa' ? 'aa' : implementationId),
        eq(shadowRuns.status, 'succeeded'),
        isNull(shadowRuns.replayedFrom),
      ),
    )
    .orderBy(desc(shadowRuns.id))
    .limit(1);

  if (recorded === undefined) {
    throw new Error(
      `replay mode: no recorded ${implementationId} shadow run for ${options.procedureName} in ` +
        'the replay source. Run `make load-replay-source`, or run live. A replay of nothing is not a replay.',
    );
  }

  const [run] = await db
    .insert(shadowRuns)
    .values({
      procedureId: procedure.id,
      status: 'running',
      implementation: recorded.implementation,
      implementationId: recorded.implementationId,
      kind: recorded.kind,
      shadowDatabase: recorded.shadowDatabase,
      casesPlanned: recorded.casesPlanned,
      strataObserved: recorded.strataObserved,
      replayedFrom: recorded.id,
    })
    .returning();

  try {
    // The recorded cadence, spread over the messages the live run emits. `replayMs` is what the
    // replay itself took, so this is the pace the room saw — divided by PARITY_REPLAY_SPEED,
    // which is the only thing that ever compresses it, and which the demo script says out loud.
    const speed = replaySpeed();
    const recordedMs = recorded.replayMs ?? recorded.durationMs ?? 0;
    say(`${recorded.casesPlanned} cases over ${recorded.strataObserved} strata`);

    const beats: string[] = [];
    for (const pass of ['A', 'B']) {
      for (let done = 50; done <= recorded.casesReplayed; done += 50) {
        beats.push(`pass ${pass} ${done}/${recorded.casesReplayed}`);
      }
    }
    const perBeat = beats.length === 0 ? recordedMs / speed : recordedMs / speed / beats.length;
    for (const beat of beats) {
      await sleep(perBeat);
      say(beat);
    }
    if (beats.length === 0) await sleep(recordedMs / speed);

    // Cases first, in sequence order, so the recorded id can be mapped onto the new one. The
    // diffs key on `shadow_case_id`, and a diff pointing at the recording's case rather than
    // this run's would show the right value attached to the wrong replay.
    const recordedCases = await source
      .select()
      .from(shadowCases)
      .where(eq(shadowCases.shadowRunId, recorded.id))
      .orderBy(asc(shadowCases.seq));

    const caseIdMap = new Map<number, number>();
    for (const recordedCase of recordedCases) {
      const { id: _id, shadowRunId: _runId, ...rest } = recordedCase;
      const [copy] = await db
        .insert(shadowCases)
        .values({ ...rest, shadowRunId: run.id })
        .returning({ id: shadowCases.id });
      caseIdMap.set(recordedCase.id, copy.id);
    }

    const recordedDiffs = await source.select().from(diffs).where(eq(diffs.shadowRunId, recorded.id)).orderBy(asc(diffs.id));
    if (recordedDiffs.length > 0) {
      const rows = recordedDiffs.map((row) => {
        const { id: _id, shadowRunId: _runId, shadowCaseId, agentRunId: _a, ...rest } = row;
        const mapped = caseIdMap.get(shadowCaseId);
        if (mapped === undefined) throw new Error(`recorded diff ${row.id} cites case ${shadowCaseId}, which is not in the run`);
        // `agent_run_id` is dropped rather than carried: it names a `classify-diff` run in the
        // SOURCE database, and a foreign key pointing at a row that does not exist here would
        // fail the insert. The verdict and its Czech explanation survive, which is what the queue
        // shows; `verdict_source` still says the model decided it.
        return { ...rest, shadowRunId: run.id, shadowCaseId: mapped, agentRunId: null };
      });
      // In chunks: one 400-case run carries well over a thousand differences, and Postgres
      // takes 65 535 bind parameters per statement — sixteen columns each puts the ceiling
      // around four thousand rows.
      for (let i = 0; i < rows.length; i += 500) await db.insert(diffs).values(rows.slice(i, i + 500));
    }

    const found = await findingsFor(db, run.id);

    await db
      .update(shadowRuns)
      .set({
        status: 'succeeded',
        casesReplayed: recorded.casesReplayed,
        strataCovered: recorded.strataCovered,
        rawDiffs: recorded.rawDiffs,
        noiseDiffs: recorded.noiseDiffs,
        behaviourDiffs: recorded.behaviourDiffs,
        replayMs: recorded.replayMs,
        durationMs: Date.now() - started,
        finishedAt: new Date(),
      })
      .where(eq(shadowRuns.id, run.id));

    say(
      `${recorded.casesReplayed} cases, ${recorded.rawDiffs} raw differences, ` +
        `${recorded.noiseDiffs} resolved in code, ${recorded.rawDiffs - recorded.noiseDiffs} to classify ` +
        `across ${found.length} findings (replayed from run #${recorded.id})`,
    );

    return {
      procedureId: procedure.id,
      findingCount: found.length,
      result: {
        shadowRunId: run.id,
        procedureName: options.procedureName,
        casesReplayed: recorded.casesReplayed,
        strataCovered: recorded.strataCovered,
        strataObserved: recorded.strataObserved,
        rawDiffs: recorded.rawDiffs,
        resolvedByCanonicaliser: recorded.noiseDiffs,
        surviving: recorded.rawDiffs - recorded.noiseDiffs,
        findings: found,
        replayMs: recorded.replayMs ?? 0,
        durationMs: Date.now() - started,
        shadowDatabase: recorded.shadowDatabase,
        implementation: recorded.implementation,
        implementationId: recorded.implementationId,
        replayedFrom: recorded.id,
      },
    };
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

/**
 * The findings of a run, read back out of the rows rather than computed from two passes.
 *
 * Live, `findings()` builds these while diffing. There is no diffing here, so they are grouped
 * out of the copied rows — the same grouping the queue does, which is what makes the replayed
 * queue identical to the recorded one.
 */
export async function findingsFor(db: Db, shadowRunId: number): Promise<Finding[]> {
  const rows = await db
    .select()
    .from(diffs)
    .innerJoin(shadowCases, eq(shadowCases.id, diffs.shadowCaseId))
    .where(and(eq(diffs.shadowRunId, shadowRunId), eq(diffs.canonicalEqual, false)))
    .orderBy(asc(shadowCases.seq), asc(diffs.id));

  const grouped = new Map<string, Finding>();
  for (const { diffs: diff, shadow_cases: shadowCase } of rows) {
    const existing = grouped.get(diff.signature);
    if (existing === undefined) {
      grouped.set(diff.signature, {
        signature: diff.signature,
        scope: diff.scope as Finding['scope'],
        tableName: diff.tableName,
        columnName: diff.columnName,
        cases: 1,
        rowsAffected: diff.rowsAffected,
        sample: {
          seq: shadowCase.seq,
          sourceInvocationId: shadowCase.sourceInvocationId,
          oldValue: diff.oldValue,
          newValue: diff.newValue,
        },
      });
      continue;
    }
    existing.cases++;
    existing.rowsAffected += diff.rowsAffected;
  }

  return [...grouped.values()].sort((a, b) => b.cases - a.cases || a.signature.localeCompare(b.signature));
}

/**
 * Classification, replayed: read the verdicts the recording already carries.
 *
 * `classifyRun` makes one model call per finding. In replay mode there is nothing to ask — the
 * copied diffs arrive with their verdicts, their reasons and the Czech explanation the queue
 * shows. Reading them back rather than re-deriving them keeps the one number that matters
 * honest: zero model runs, zero dollars.
 */
export async function replayedVerdicts(
  db: Db,
  shadowRunId: number,
): Promise<{ signature: string; verdict: string | null; reason: string | null; explanationCs: string | null; cases: number }[]> {
  const rows = await db
    .select()
    .from(diffs)
    .where(and(eq(diffs.shadowRunId, shadowRunId), eq(diffs.canonicalEqual, false)))
    .orderBy(asc(diffs.id));

  const grouped = new Map<string, { signature: string; verdict: string | null; reason: string | null; explanationCs: string | null; cases: Set<number> }>();
  for (const row of rows) {
    const existing = grouped.get(row.signature);
    if (existing === undefined) {
      grouped.set(row.signature, {
        signature: row.signature,
        verdict: row.verdict,
        reason: row.noiseReason,
        explanationCs: row.explanationCs,
        cases: new Set([row.shadowCaseId]),
      });
      continue;
    }
    existing.cases.add(row.shadowCaseId);
  }

  return [...grouped.values()].map((entry) => ({
    signature: entry.signature,
    verdict: entry.verdict,
    reason: entry.reason,
    explanationCs: entry.explanationCs,
    cases: entry.cases.size,
  }));
}
