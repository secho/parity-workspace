import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { goldenTests, invariants, procedures, serviceArtifacts, specs } from '../db/schema.js';
import { procedureIdByName } from './source.js';

/**
 * What a replayed run **produced**, copied from the replay source into the live database.
 *
 * This is the half of replay that is easy to forget and impossible to fake. `runner.ts` truncates
 * every tool input to 2 000 characters, so the `write_spec` step in a recording carries 2 000
 * characters of a specification that is 15 368 long. The steps are a transcript; the payload lives
 * in `specs`, `golden_tests`, `invariants` and `service_artifacts`. Re-emitting the transcript and
 * stopping there gives you a procedure screen with a step stream and an empty Specifikace tab.
 *
 * So each skill declares what it writes, and a replayed run of that skill copies exactly that,
 * for exactly that procedure, at the moment the run finishes.
 *
 * **Three rules hold everything together.**
 *
 * 1. *By name, never by id.* `demo-reset` re-ingests, so `procedures.id` is assigned fresh. It
 *    comes out the same today because ingest is deterministic; depending on that would be a bug
 *    waiting for the first estate that changes.
 * 2. *`agent_run_id` points at the REPLAY, not at the recording.* The recorded run does not exist
 *    in the live database, and the row is genuinely the output of the run that just happened on
 *    this screen. Following the link has to land somewhere real.
 * 3. *Nothing here moves the ladder.* `oracle_state` is promoted by `promoteAfterOracle` and
 *    `promoteAfterShadow`, from real executions that still happen in replay mode — recording the
 *    baseline runs the procedure, and it costs nothing because it is not a model call. Copying a
 *    promoted state would be the one place replay stopped being a replay and became a fixture.
 *    The single exception is `campaign_status = 'specced'`, which `write_triage` sets directly and
 *    no later step re-derives.
 */

export interface Materialised {
  /** Table → rows written. Empty means the skill produces no artefacts, not that it failed. */
  rows: Record<string, number>;
}

export async function materialiseArtefacts(
  live: Db,
  source: Db,
  input: { skill: string; procedureName: string; agentRunId: number },
): Promise<Materialised> {
  const liveId = await procedureIdByName(live, input.procedureName);
  const sourceId = await procedureIdByName(source, input.procedureName);
  if (liveId === null || sourceId === null) return { rows: {} };

  switch (input.skill) {
    case 'triage':
      return { rows: await copyTriage(live, source, liveId, sourceId) };
    case 'extract-spec':
      return { rows: await copySpec(live, source, liveId, sourceId, input.agentRunId) };
    case 'generate-oracle':
      return { rows: await copyOracle(live, source, liveId, sourceId, input.agentRunId) };
    case 'implement-service':
      return { rows: await copyService(live, source, liveId, sourceId, input.agentRunId) };
    default:
      // `classify-diff` writes verdicts onto `diffs`, and those arrive with the shadow run's own
      // replay rather than with the agent run's. Nothing to do, and saying so beats a silent
      // default that would hide a skill somebody forgot to add.
      return { rows: {} };
  }
}

/** Exactly what `write_triage` writes: the classification, and the first rung of campaign status. */
async function copyTriage(live: Db, source: Db, liveId: number, sourceId: number): Promise<Record<string, number>> {
  const [row] = await source.select().from(procedures).where(eq(procedures.id, sourceId));
  if (row === undefined) return {};

  await live
    .update(procedures)
    .set({
      oracleClass: row.oracleClass,
      riskClass: row.riskClass,
      seamRequirements: row.seamRequirements,
      campaignStatus: 'specced',
    })
    .where(eq(procedures.id, liveId));

  return { procedures: 1 };
}

async function copySpec(
  live: Db,
  source: Db,
  liveId: number,
  sourceId: number,
  agentRunId: number,
): Promise<Record<string, number>> {
  const [row] = await source.select().from(specs).where(eq(specs.procedureId, sourceId));
  if (row === undefined) return {};

  const written = await live
    .insert(specs)
    .values({ markdown: row.markdown, model: row.model, procedureId: liveId, agentRunId })
    // Idempotent: `specs.procedure_id` is unique, and replaying the same run twice in a rehearsal
    // must not fail. The second replay is the same specification, so overwrite rather than skip —
    // the `agent_run_id` should point at the run whose steps are on screen now.
    .onConflictDoUpdate({
      target: specs.procedureId,
      set: { markdown: row.markdown, model: row.model, agentRunId, createdAt: new Date() },
    })
    .returning({ id: specs.id });

  return { specs: written.length };
}

/**
 * The golden cases and the invariants — but NOT the oracle runs that executed them.
 *
 * `recordBaseline` and `runSuite` still run for real in replay mode: they execute the procedure
 * against the estate inside a transaction that rolls back, which costs seconds and no money. So
 * the expectations are recorded on the day, by the same code that recorded them originally, and
 * the ladder moves because a suite genuinely passed rather than because a row said it had.
 */
async function copyOracle(
  live: Db,
  source: Db,
  liveId: number,
  sourceId: number,
  agentRunId: number,
): Promise<Record<string, number>> {
  const cases = await source.select().from(goldenTests).where(eq(goldenTests.procedureId, sourceId)).orderBy(asc(goldenTests.id));
  const rules = await source.select().from(invariants).where(eq(invariants.procedureId, sourceId)).orderBy(asc(invariants.id));

  const written: Record<string, number> = {};

  if (cases.length > 0) {
    const rows = await live
      .insert(goldenTests)
      .values(
        cases.map(({ id: _id, procedureId: _p, agentRunId: _a, ...rest }) => ({
          ...rest,
          procedureId: liveId,
          agentRunId,
        })),
      )
      .onConflictDoNothing({ target: [goldenTests.procedureId, goldenTests.name] })
      .returning({ id: goldenTests.id });
    written.golden_tests = rows.length;
  }

  if (rules.length > 0) {
    const rows = await live
      .insert(invariants)
      .values(
        rules.map(({ id: _id, procedureId: _p, agentRunId: _a, ...rest }) => ({
          ...rest,
          procedureId: liveId,
          agentRunId,
        })),
      )
      .onConflictDoNothing({ target: [invariants.procedureId, invariants.name] })
      .returning({ id: invariants.id });
    written.invariants = rows.length;
  }

  return written;
}

/**
 * The service the agent wrote.
 *
 * Copied into `service_artifacts` only — the files on disk are the host's business, because
 * parity-api deliberately has no write mount into the demo app. `make adopt-service` is what
 * materialises them, in replay exactly as in a live run, and `/health` is what proves the two
 * agree. A replay that wrote files would be the one place the platform reached into the estate's
 * repository, and it is refused there for a reason.
 */
async function copyService(
  live: Db,
  source: Db,
  liveId: number,
  sourceId: number,
  agentRunId: number,
): Promise<Record<string, number>> {
  const files = await source
    .select()
    .from(serviceArtifacts)
    .where(eq(serviceArtifacts.procedureId, sourceId))
    .orderBy(asc(serviceArtifacts.attempt), asc(serviceArtifacts.path));
  if (files.length === 0) return {};

  const rows = await live
    .insert(serviceArtifacts)
    .values(
      files.map(({ id: _id, procedureId: _p, agentRunId: _a, ...rest }) => ({
        ...rest,
        procedureId: liveId,
        agentRunId,
      })),
    )
    .onConflictDoNothing({ target: [serviceArtifacts.procedureId, serviceArtifacts.attempt, serviceArtifacts.path] })
    .returning({ id: serviceArtifacts.id });

  return { service_artifacts: rows.length };
}
