import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentRuns, agentSteps, auditEntries, procedures } from '../db/schema.js';
import type { Config } from '../env.js';
import { llmEndpoint, runSkill, type RunResult } from './client.js';
import { buildHooks } from './hooks.js';
import { loadPolicy } from './policy.js';
import { findSkill, loadSkills } from './skills.js';
import { parityTools, TOOL, type ToolContext } from './tools.js';

/**
 * One skill run, end to end: create the row, stream the steps, persist everything.
 *
 * Everything needed to replay a run is written down as it happens rather than
 * reconstructed afterwards, because M7's `PARITY_MODE=replay` is supposed to be a read
 * from these tables. A run that succeeded but left no trace would be indistinguishable
 * from one that never happened.
 */

export interface StartRun {
  skillName: string;
  taskClass: string;
  procedureName: string | null;
  prompt: string;
  maxTurns: number;
  allowedTools: string[];
}

export type StepListener = (step: { seq: number; kind: string; toolName: string | null; text: string | null }) => void;

export interface RunHandle {
  runId: string;
  agentRunId: number;
  result: RunResult;
  blocked: { toolName: string; reason: string }[];
}

export async function executeRun(
  db: Db,
  config: Config,
  request: StartRun,
  onStep?: StepListener,
): Promise<RunHandle> {
  const skills = await loadSkills(config.skillsDir);
  const skill = await findSkill(config.skillsDir, request.skillName);
  const runId = randomUUID();
  const endpoint = llmEndpoint();

  const [procedure] =
    request.procedureName === null
      ? [undefined]
      : await db.select({ id: procedures.id }).from(procedures).where(eq(procedures.name, request.procedureName));

  const [run] = await db
    .insert(agentRuns)
    .values({
      runId,
      skill: skill.name,
      taskClass: request.taskClass,
      procedureId: procedure?.id ?? null,
      status: 'running',
      provider: endpoint.provider,
      prompt: request.prompt,
    })
    .returning({ id: agentRuns.id });

  const toolContext: ToolContext = {
    db,
    config,
    procedureName: request.procedureName,
    agentRunId: run.id,
  };

  const blocked: { toolName: string; reason: string }[] = [];
  let seq = 0;
  const nextSeq = (): number => ++seq;

  const recordStep = async (kind: string, toolName: string | null, text: string | null): Promise<void> => {
    const step = { seq: nextSeq(), kind, toolName, text };
    await db.insert(agentSteps).values({ agentRunId: run.id, ...step });
    onStep?.(step);
  };

  try {
    const result = await runSkill({
      skill,
      allSkills: skills,
      prompt: request.prompt,
      workspaceRoot: config.agentWorkspace,
      runId,
      maxTurns: request.maxTurns,
      allowedTools: request.allowedTools,
      mcpServers: { parity: parityTools(toolContext) },
      hooks: buildHooks({
        db,
        agentRunId: run.id,
        policy: await loadPolicy(db, request.taskClass),
        nextSeq,
        onBlocked: (toolName, reason) => blocked.push({ toolName, reason }),
      }),
      onMessage: async (message) => {
        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'text' && block.text.trim() !== '') await recordStep('assistant', null, block.text);
            if (block.type === 'tool_use') await recordStep('tool_use', block.name, JSON.stringify(block.input).slice(0, 2000));
          }
        }
      },
    });

    // A tool the SDK refuses because it is not in `allowedTools` is denied *before* PreToolUse
    // runs, so no hook fires and nothing reaches the audit log. That leaves the audit with a
    // hole in the worst possible place: `sp_PlaceOrder`'s run attempted Bash — the agent
    // reaching for a shell it does not have — and that attempt was the one event in 185 tool
    // calls with no record of it. The SDK reports these on the result message, so the receipt
    // exists; it just was not being written down.
    //
    // Same shape as M3's PostToolUseFailure fix: the claim is that nothing is instrumented by
    // hand and therefore nothing can be forgotten, and a silent gap is worse than no claim.
    for (const denial of result.permissionDenials) {
      await db.insert(auditEntries).values({
        agentRunId: run.id,
        seq: nextSeq(),
        toolName: denial.tool_name,
        inputSummary: JSON.stringify(denial.tool_input).slice(0, 500),
        resultSummary: null,
        outcome: 'denied',
        reason: `nepovolený nástroj pro tuhle úlohu — ${denial.tool_name} není v allowedTools`,
      });
    }

    await db
      .update(agentRuns)
      .set({
        status: result.isError ? 'failed' : blocked.length > 0 ? 'blocked' : 'succeeded',
        model: result.model,
        output: result.text,
        numTurns: result.numTurns,
        costUsd: result.costUsd === null ? null : String(result.costUsd),
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: result.durationMs,
        finishedAt: new Date(),
      })
      .where(eq(agentRuns.id, run.id));

    return { runId, agentRunId: run.id, result, blocked };
  } catch (err) {
    await db
      .update(agentRuns)
      .set({ status: 'failed', error: err instanceof Error ? err.message : String(err), finishedAt: new Date() })
      .where(eq(agentRuns.id, run.id));
    throw err;
  }
}

// --- the skills ------------------------------------------------------------------------

/** Triage reads and classifies. It may record a classification and nothing else. */
export const triageRun = (procedureName: string): StartRun => ({
  skillName: 'triage',
  taskClass: 'triage',
  procedureName,
  maxTurns: 14,
  allowedTools: [TOOL.readProcedure, TOOL.queryCapture, TOOL.writeTriage],
  prompt: `Use the triage skill to classify the stored procedure ${procedureName}.

Read its source with read_procedure and its captured production traffic with query_capture
before deciding anything. Then record the result with write_triage.

Classify from the code, not from the name, and not from how often it is called.`,
});

/** Extract-spec reads and writes prose. It may not touch the classification. */
export const specRun = (procedureName: string): StartRun => ({
  skillName: 'extract-spec',
  taskClass: 'spec',
  procedureName,
  maxTurns: 20,
  allowedTools: [TOOL.readProcedure, TOOL.queryCapture, TOOL.writeSpec],
  prompt: `Use the extract-spec skill to write the specification for the stored procedure ${procedureName}.

Read its source with read_procedure and a sample of its captured invocations with
query_capture — the captured traffic is what tells you which values actually occur and
which branches actually run.

Write the finished specification with write_spec. It must be in Czech and must follow the
section structure the skill gives you.`,
});

/**
 * Generate-oracle chooses cases and states invariants. It cannot execute anything — the
 * expectations are recorded afterwards by running the procedure, which is Parity's job and
 * not the model's.
 */
export const oracleRun = (procedureName: string): StartRun => ({
  skillName: 'generate-oracle',
  taskClass: 'oracle',
  procedureName,
  maxTurns: 24,
  allowedTools: [TOOL.readProcedure, TOOL.queryCapture, TOOL.listCaptureCases, TOOL.writeGoldenTests, TOOL.writeInvariants],
  prompt: `Use the generate-oracle skill to build the behavioural reference for ${procedureName}.

Read its source with read_procedure and its captured traffic with query_capture. Then call
list_capture_cases — that is the set of real invocations you may choose from, one per observed
branch. Choose the smallest set that covers every branch, and record it with write_golden_tests
citing the invocation ids. You cannot supply inputs of your own; they are read from the capture.

Then propose invariants with write_invariants. Use the supported kinds so they are actually
checked; file anything you cannot express that way as advisory rather than dropping it.`,
});
