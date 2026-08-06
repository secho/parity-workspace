import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { diffs, shadowCases, shadowRuns } from '../db/schema.js';
import type { Config } from '../env.js';
import { classifyDiffRun, executeRun } from '../agent/runner.js';
import { stableKey } from '../oracle/canonicalise.js';
import { replayedVerdicts } from '../replay/serve.js';
import type { Finding } from './diff.js';
import type { ShadowResult } from './run.js';

/**
 * Ask the model about what canonicalisation could not settle — and only that.
 *
 * The division of labour is `SPEC.md` §8's, and it is visible in the numbers: hundreds of raw
 * differences are resolved in code, and a handful of *findings* reach a model. One run per
 * finding, so the model-call count is a property of the estate rather than of the traffic
 * volume, and two identical shadow runs ask the same number of questions.
 *
 * The evidence a run receives is assembled here rather than in the prompt template, because
 * it has to be the same evidence a human sees in the queue. A model reasoning about one thing
 * while the side-by-side shows another is how a plausible verdict gets attached to the wrong
 * finding.
 */

export interface Verdict {
  signature: string;
  verdict: 'noise' | 'behaviour_change' | null;
  reason: string | null;
  explanationCs: string | null;
  cases: number;
}

export interface ClassifyResult {
  findings: Finding[];
  runs: number;
  noise: number;
  behaviourChange: number;
  unclassified: number;
  verdicts: Verdict[];
  costUsd: number;
}

const truncate = (value: unknown, max = 400): string => {
  const rendered = typeof value === 'string' ? value : stableKey(value);
  return rendered.length > max ? `${rendered.slice(0, max)}…` : rendered;
};

/**
 * What one finding looks like, in the words the skill expects: the inputs, the old value, the
 * new value, and what the canonicaliser already normalised away.
 */
export async function evidenceFor(db: Db, shadowRunId: number, finding: Finding): Promise<string> {
  const [row] = await db
    .select({
      inputParams: shadowCases.inputParams,
      sourceInvocationId: shadowCases.sourceInvocationId,
      branchKey: shadowCases.branchKey,
      oldNormalisations: shadowCases.oldNormalisations,
      newNormalisations: shadowCases.newNormalisations,
      oldValue: diffs.oldValue,
      newValue: diffs.newValue,
      rowsAffected: diffs.rowsAffected,
      oldError: shadowCases.oldError,
      newError: shadowCases.newError,
    })
    .from(diffs)
    .innerJoin(shadowCases, eq(shadowCases.id, diffs.shadowCaseId))
    .where(and(eq(diffs.shadowRunId, shadowRunId), eq(diffs.signature, finding.signature)))
    .orderBy(shadowCases.seq)
    .limit(1);

  const where =
    finding.scope === 'write_set'
      ? `write set, ${finding.tableName}${finding.columnName === null ? ' (which rows were written)' : `.${finding.columnName}`}`
      : finding.scope === 'result_set'
        ? `result set ${finding.columnName}`
        : 'the call itself (one side raised an error and the other did not)';

  return [
    `Difference in: ${where}`,
    `Seen in ${finding.cases} of the replayed cases, over ${finding.rowsAffected} written rows.`,
    '',
    `Sample case — captured invocation ${row?.sourceInvocationId ?? '?'}, branch ${row?.branchKey ?? '-'}`,
    `  inputs:     ${truncate(row?.inputParams)}`,
    `  old (stored procedure): ${truncate(row?.oldValue)}`,
    `  new (replacement):      ${truncate(row?.newValue)}`,
    ...(row?.oldError !== null || row?.newError !== null
      ? [`  old error: ${row?.oldError ?? 'none'}`, `  new error: ${row?.newError ?? 'none'}`]
      : []),
    '',
    `Normalisations the canonicaliser applied to this case before comparing:`,
    `  old side: ${(row?.oldNormalisations as string[] | null)?.join(', ') || 'none'}`,
    `  new side: ${(row?.newNormalisations as string[] | null)?.join(', ') || 'none'}`,
  ].join('\n');
}

export async function classifyRun(
  db: Db,
  config: Config,
  run: ShadowResult,
  onProgress?: (message: string) => void,
): Promise<ClassifyResult> {
  const say = onProgress ?? ((): void => undefined);

  let noise = 0;
  let behaviourChange = 0;
  let costUsd = 0;
  let runs = 0;
  const verdicts: Verdict[] = [];

  // In replay mode the verdicts arrived with the copied rows — reason, Czech explanation and
  // all. Asking the model again would be the one place a "replayed" run quietly spent money,
  // and it would be free to answer differently, which is what hard rule 5 forbids.
  if (config.mode === 'replay') {
    const recorded = await replayedVerdicts(db, run.shadowRunId);
    const change = recorded.filter((v) => v.verdict === 'behaviour_change').length;
    say(`${recorded.length} findings, verdicts replayed — no model run`);
    await db.update(shadowRuns).set({ behaviourDiffs: change }).where(eq(shadowRuns.id, run.shadowRunId));
    return {
      findings: run.findings,
      runs: 0,
      noise: recorded.filter((v) => v.verdict === 'noise').length,
      behaviourChange: change,
      unclassified: recorded.filter((v) => v.verdict === null).length,
      verdicts: recorded.map((v) => ({ ...v, verdict: v.verdict as Verdict['verdict'] })),
      costUsd: 0,
    };
  }

  for (const finding of run.findings) {
    const evidence = await evidenceFor(db, run.shadowRunId, finding);
    say(`classifying ${finding.signature} (${finding.cases} cases)`);

    const handle = await executeRun(
      db,
      config,
      classifyDiffRun(run.procedureName, finding.signature, evidence),
    );
    runs++;
    costUsd += handle.result.costUsd ?? 0;

    const [recorded] = await db
      .select({ verdict: diffs.verdict, reason: diffs.noiseReason, explanationCs: diffs.explanationCs })
      .from(diffs)
      .where(and(eq(diffs.shadowRunId, run.shadowRunId), eq(diffs.signature, finding.signature)))
      .limit(1);

    if (recorded?.verdict === 'noise') noise++;
    else if (recorded?.verdict === 'behaviour_change') behaviourChange++;

    verdicts.push({
      signature: finding.signature,
      verdict: (recorded?.verdict ?? null) as Verdict['verdict'],
      reason: recorded?.reason ?? null,
      explanationCs: recorded?.explanationCs ?? null,
      cases: finding.cases,
    });
  }

  const unclassified = (
    await db
      .select({ id: diffs.id })
      .from(diffs)
      .where(and(eq(diffs.shadowRunId, run.shadowRunId), isNull(diffs.verdict)))
  ).length;

  // The headline the Estate screen and the queue both read. Stored on the run rather than
  // recomputed, because it is a fact about what happened during it.
  await db
    .update(shadowRuns)
    .set({ behaviourDiffs: behaviourChange })
    .where(eq(shadowRuns.id, run.shadowRunId));

  return { findings: run.findings, runs, noise, behaviourChange, unclassified, verdicts, costUsd };
}
