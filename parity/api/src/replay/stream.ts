import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentRuns, agentSteps, procedures } from '../db/schema.js';
import { replaySpeed } from './mode.js';

/**
 * Re-emitting a recorded run's steps, at the cadence they were recorded at.
 *
 * This is the visual half of replay, and it is deliberately the *only* thing this module does.
 * The artefacts a run produced — the spec, the golden tests, the diffs — are restored from the
 * snapshot (see `scripts/golden.ts`), because they cannot be rebuilt from here: `runner.ts`
 * truncates every tool input to 2 000 characters, so the `write_spec` step carries 2 000
 * characters of a specification that is 15 368 long. The steps are a transcript. The payload
 * lives in its own tables.
 *
 * Cadence comes from `agent_steps.created_at` deltas. That is genuinely the original rhythm —
 * `recordStep` awaits its insert inside the message loop, so the row lands as the step happens —
 * and it needs no new column. Measured on the `sp_CalculateOrderTotal` spec run, the gaps are
 * 3.4s · 3.5s · 3.2s · 0.4s · 3.6s · 143.7s · 125.1s · 18.2s, which is what thinking looks like.
 *
 * `PARITY_REPLAY_SPEED` divides those gaps — see `./mode.ts`, which also holds the runtime
 * switch. At 1 the replay takes exactly as long as the run did; that is the honest default and
 * the reason the demo script has to say which stretches are replayed. Anything above 1 is a
 * compression, and compressions get said out loud.
 */

export interface RecordedStep {
  seq: number;
  kind: string;
  toolName: string | null;
  text: string | null;
  /** Milliseconds to wait *before* emitting this step, already divided by the speed factor. */
  delayMs: number;
}

export interface Recording {
  agentRunId: number;
  runId: string;
  skill: string;
  procedureName: string | null;
  model: string | null;
  provider: string | null;
  output: string | null;
  numTurns: number | null;
  costUsd: string | null;
  durationMs: number | null;
  steps: RecordedStep[];
}

/**
 * The most recent succeeded run of a skill against a procedure.
 *
 * Newest rather than first: a procedure re-run after a correction has two recordings, and the
 * one worth showing is the one whose artefacts are the ones on screen.
 *
 * `replayed_from IS NULL` excludes replays of replays. Their steps would be identical, so this
 * changes nothing visible — but a recording is a run that happened, and the model and turn count
 * carried forward should be the ones a model actually produced. After three rehearsals the
 * newest run of a skill is a replay, and without this the chain would be four deep.
 */
export async function findRecording(
  db: Db,
  options: { skill: string; procedureName: string; speed?: number },
): Promise<Recording | null> {
  const [chosen] = await db
    .select({
      id: agentRuns.id,
      runId: agentRuns.runId,
      skill: agentRuns.skill,
      model: agentRuns.model,
      provider: agentRuns.provider,
      output: agentRuns.output,
      numTurns: agentRuns.numTurns,
      costUsd: agentRuns.costUsd,
      durationMs: agentRuns.durationMs,
    })
    .from(agentRuns)
    .innerJoin(procedures, eq(agentRuns.procedureId, procedures.id))
    .where(
      and(
        eq(procedures.name, options.procedureName),
        eq(agentRuns.skill, options.skill),
        eq(agentRuns.status, 'succeeded'),
        isNull(agentRuns.replayedFrom),
      ),
    )
    .orderBy(desc(agentRuns.id))
    .limit(1);

  if (chosen === undefined) return null;

  const rows = await db
    .select()
    .from(agentSteps)
    .where(eq(agentSteps.agentRunId, chosen.id))
    .orderBy(asc(agentSteps.seq));
  if (rows.length === 0) return null;

  const speed = options.speed ?? replaySpeed();
  const first = rows[0].createdAt.getTime();
  let previous = first;

  return {
    agentRunId: chosen.id,
    runId: chosen.runId,
    skill: chosen.skill,
    procedureName: options.procedureName,
    model: chosen.model,
    provider: chosen.provider,
    output: chosen.output,
    numTurns: chosen.numTurns,
    costUsd: chosen.costUsd,
    durationMs: chosen.durationMs,
    steps: rows.map((row) => {
      const at = row.createdAt.getTime();
      const delayMs = Math.max(0, Math.round((at - previous) / speed));
      previous = at;
      return { seq: row.seq, kind: row.kind, toolName: row.toolName, text: row.text, delayMs };
    }),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Play a recording out through a listener, honouring the recorded gaps.
 *
 * The listener is the same `onStep` callback a live run feeds, so the browser is on an
 * identical code path and genuinely cannot tell the difference. That is the claim, and it is
 * only true because nothing here reshapes the event.
 *
 * `emit` may be async and is awaited: a served replay writes the step row before announcing it,
 * because `Procedure.tsx` treats the SSE event as a signal to refetch and reads the payload
 * from the table. Announcing first would race the browser against the insert.
 */
export async function playRecording(
  recording: Recording,
  emit: (step: {
    seq: number;
    kind: string;
    toolName: string | null;
    text: string | null;
  }) => void | Promise<void>,
): Promise<void> {
  for (const step of recording.steps) {
    if (step.delayMs > 0) await sleep(step.delayMs);
    await emit({ seq: step.seq, kind: step.kind, toolName: step.toolName, text: step.text });
  }
}
