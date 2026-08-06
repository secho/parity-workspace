// What `verify-m7` shells out to for section 7 — replay, observed rather than asserted.
//
// Three measurements, all of them made by actually doing the thing:
//
//   1. an agent run served from a recording: the steps it re-materialised, in order, against
//      the steps the recording holds; how long it took against how long the recording took;
//      and — the load-bearing one — the estate's total model spend before and after;
//   2. a shadow run served from a recording: the row it wrote, what it copied, and the fact
//      that classification made zero model runs;
//   3. the negative control: a replay with no recording, which must throw rather than
//      quietly emit nothing.
//
// It runs with PARITY_MODE forced to `replay` regardless of how the container is configured,
// because the gate must be able to check replay on a stack that is serving live.

import { and, eq, isNull, sql } from 'drizzle-orm';
import { openStore, waitForPostgres } from '../db/client.js';
import { agentRuns, agentSteps, procedures, shadowRuns } from '../db/schema.js';
import { loadConfig } from '../env.js';
import { executeRun, specRun, type StartRun } from '../agent/runner.js';
import { runShadow } from '../shadow/run.js';
import { classifyRun } from '../shadow/classify.js';
import { findRecording } from '../replay/stream.js';

const procedureName = process.argv[2] ?? 'sp_CalculateOrderTotal';
const speed = process.argv[3] ?? '10';

process.env.PARITY_REPLAY_SPEED = speed;
const config = { ...loadConfig(), mode: 'replay' };

const store = openStore(config.pgUrl);
await waitForPostgres(store.pool);

const spend = async (): Promise<number> => {
  const [row] = await store.db.select({ total: sql<string>`coalesce(sum(${agentRuns.costUsd}), 0)` }).from(agentRuns);
  return Number(row.total);
};

const spendBefore = await spend();

// --- 1 · an agent run, served -------------------------------------------------------------
const recording = await findRecording(store.db, { skill: 'extract-spec', procedureName, speed: 1 });
const recordedGapMs = (recording?.steps ?? []).reduce((sum, step) => sum + step.delayMs, 0);

const started = Date.now();
const handle = await executeRun(store.db, config, specRun(procedureName));
const elapsedMs = Date.now() - started;

const [replayedRow] = await store.db.select().from(agentRuns).where(eq(agentRuns.id, handle.agentRunId));
const replayedSteps = await store.db
  .select({ seq: agentSteps.seq, kind: agentSteps.kind, toolName: agentSteps.toolName, text: agentSteps.text })
  .from(agentSteps)
  .where(eq(agentSteps.agentRunId, handle.agentRunId))
  .orderBy(agentSteps.seq);

// Same steps, in the same order, with the same tool names and the same text. Comparing the
// count alone would pass on a run that emitted the right number of wrong things.
const recordedSteps = (recording?.steps ?? []).map((s) => ({ seq: s.seq, kind: s.kind, toolName: s.toolName, text: s.text }));
const stepsIdentical = JSON.stringify(recordedSteps) === JSON.stringify(replayedSteps);

// --- 2 · a shadow run, served -------------------------------------------------------------
const [procedure] = await store.db.select().from(procedures).where(eq(procedures.name, procedureName));
const [recordedShadow] = await store.db
  .select()
  .from(shadowRuns)
  .where(
    and(
      eq(shadowRuns.procedureId, procedure?.id ?? -1),
      eq(shadowRuns.implementationId, 'generated'),
      eq(shadowRuns.status, 'succeeded'),
      isNull(shadowRuns.replayedFrom),
    ),
  )
  .orderBy(sql`${shadowRuns.id} desc`)
  .limit(1);

// The GENERATED run, not the reference one, and the reason is worth stating. A replayed run is
// the newest run of its procedure, and everything that asks for "the latest shadow run" would
// then be asking about it — including the decision queue, whose findings are keyed to the run
// that produced them. Replaying the reference run would re-open four findings that were decided
// weeks ago, and `verify-m6` would go red on a milestone it has nothing to do with.
const shadowStarted = Date.now();
const shadow = await runShadow(store.db, config, { procedureName, implementation: 'generated' });
const classified = await classifyRun(store.db, config, shadow);
const shadowElapsedMs = Date.now() - shadowStarted;

// And then it is removed again, for the same reason plus one: a copied run carries every one of
// its differences, so a gate that left them behind would add a thousand-odd `diffs` rows to the
// estate every time anyone ran it. The measurement above is the receipt; the rows are not.
await store.db.delete(shadowRuns).where(eq(shadowRuns.id, shadow.shadowRunId));
const [stillThere] = await store.db.select({ id: shadowRuns.id }).from(shadowRuns).where(eq(shadowRuns.id, shadow.shadowRunId));

// --- 3 · the negative control -------------------------------------------------------------
//
// A skill that was never run against this procedure. Deterministic rather than hardcoded: the
// alphabetically first procedure with no `implement-service` recording, so the probe keeps
// working after any of them gains one.
const [orphan] = await store.db
  .select({ name: procedures.name })
  .from(procedures)
  .where(
    sql`not exists (select 1 from ${agentRuns} where ${agentRuns.procedureId} = ${procedures.id} and ${agentRuns.skill} = 'implement-service')`,
  )
  .orderBy(procedures.name)
  .limit(1);

const missing: StartRun = {
  skillName: 'implement-service',
  taskClass: 'service',
  procedureName: orphan?.name ?? '__no_such_procedure__',
  prompt: 'probe: there is no recording of this, and there must not silently be one',
  maxTurns: 1,
  allowedTools: [],
};

let refusal: string | null = null;
try {
  await executeRun(store.db, config, missing);
} catch (err) {
  refusal = err instanceof Error ? err.message : String(err);
}

const spendAfter = await spend();

// The replayed agent run goes too, once it has been measured.
//
// It is nine steps rather than a thousand diffs, so this is not about size — it is that a gate
// which leaves rows behind is a gate that invalidates the committed snapshot every time anyone
// runs it, and puts a second `extract-spec` run on the procedure screen for the presenter to
// wonder about. The receipts are in this output; the rows are not the receipts.
await store.db.delete(agentRuns).where(eq(agentRuns.id, handle.agentRunId));
const [agentStillThere] = await store.db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.id, handle.agentRunId));

console.log(
  JSON.stringify(
    {
      mode: config.mode,
      speed: Number(speed),
      agent: {
        procedure: procedureName,
        recordedRunId: recording?.agentRunId ?? null,
        replayedFrom: replayedRow?.replayedFrom ?? null,
        recordedSteps: recordedSteps.length,
        replayedSteps: replayedSteps.length,
        stepsIdentical,
        model: replayedRow?.model ?? null,
        costUsd: replayedRow?.costUsd ?? null,
        inputTokens: replayedRow?.inputTokens ?? null,
        status: replayedRow?.status ?? null,
        recordedGapMs,
        expectedMs: Math.round(recordedGapMs / Number(speed)),
        elapsedMs,
        cleanedUp: agentStillThere === undefined,
      },
      shadow: {
        recordedRunId: recordedShadow?.id ?? null,
        shadowRunId: shadow.shadowRunId,
        replayedFrom: shadow.replayedFrom ?? null,
        casesReplayed: shadow.casesReplayed,
        recordedCases: recordedShadow?.casesReplayed ?? null,
        rawDiffs: shadow.rawDiffs,
        recordedRawDiffs: recordedShadow?.rawDiffs ?? null,
        findings: shadow.findings.length,
        behaviourChange: classified.behaviourChange,
        recordedBehaviourDiffs: recordedShadow?.behaviourDiffs ?? null,
        classifyModelRuns: classified.runs,
        classifyCostUsd: classified.costUsd,
        replayMs: shadow.replayMs,
        elapsedMs: shadowElapsedMs,
        cleanedUp: stillThere === undefined,
      },
      negativeControl: {
        procedure: orphan?.name ?? null,
        skill: 'implement-service',
        refused: refusal !== null,
        message: refusal,
      },
      spend: { before: spendBefore, after: spendAfter, moved: spendAfter !== spendBefore },
    },
    null,
    2,
  ),
);

await store.pool.end();
