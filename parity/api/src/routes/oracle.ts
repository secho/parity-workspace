import { asc, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { goldenResults, goldenTests, invariantResults, invariants, oracleRuns, procedures } from '../db/schema.js';
import type { Config } from '../env.js';
import { isConfirmedRule } from '../oracle/invariants.js';
import { runSuite } from '../oracle/suite.js';

/**
 * What the Procedura → Oracle tab reads.
 *
 * Pass rates are computed from the most recent non-probe run, never stored on the case.
 * Same reasoning as `blocker`: a stored verdict drifts from the thing it describes, and a
 * pass rate that has drifted is worse than no pass rate because the screen then claims
 * verification that has not happened.
 */
export async function oracleRoutes(app: FastifyInstance, db: Db, config: Config): Promise<void> {
  app.get<{ Params: { name: string } }>('/api/procedures/:name/oracle', async (request, reply) => {
    const [procedure] = await db.select().from(procedures).where(eq(procedures.name, request.params.name));
    if (procedure === undefined) return reply.code(404).send({ error: 'procedure not found' });

    const cases = await db
      .select()
      .from(goldenTests)
      .where(eq(goldenTests.procedureId, procedure.id))
      .orderBy(asc(goldenTests.name));

    const rules = await db
      .select()
      .from(invariants)
      .where(eq(invariants.procedureId, procedure.id))
      .orderBy(asc(invariants.name));

    // A probe run is a deliberate sabotage. Letting it be the latest run would show the
    // estate as failing for as long as the probe's own restore took.
    const [latest] = await db
      .select()
      .from(oracleRuns)
      .where(eq(oracleRuns.procedureId, procedure.id))
      .orderBy(desc(oracleRuns.id))
      .limit(20)
      .then((rows) => rows.filter((r) => r.kind !== 'probe'));

    const caseResults =
      latest === undefined ? [] : await db.select().from(goldenResults).where(eq(goldenResults.oracleRunId, latest.id));
    const ruleResults =
      latest === undefined
        ? []
        : await db.select().from(invariantResults).where(eq(invariantResults.oracleRunId, latest.id));

    const byCase = new Map(caseResults.map((r) => [r.goldenTestId, r]));
    const byRule = new Map(ruleResults.map((r) => [r.invariantId, r]));

    return {
      latestRun: latest ?? null,
      goldenTests: cases.map((c) => ({
        id: c.id,
        name: c.name,
        branchKey: c.branchKey,
        sourceInvocationId: c.sourceInvocationId,
        inputParams: c.inputParams,
        normalisations: c.normalisations,
        rationale: c.rationale,
        status: byCase.get(c.id)?.status ?? null,
        detail: byCase.get(c.id)?.detail ?? null,
      })),
      invariants: rules.map((r) => {
        const checked = byRule.get(r.id)?.casesChecked ?? 0;
        const violated = byRule.get(r.id)?.casesViolated ?? 0;
        return {
          id: r.id,
          name: r.name,
          kind: r.kind,
          evaluable: r.evaluable,
          rationale: r.rationale,
          casesChecked: checked,
          casesViolated: violated,
          firstViolation: byRule.get(r.id)?.firstViolation ?? null,
          /**
           * Derived, never stored. A rule the current procedure breaks nearly everywhere is
           * describing something other than this procedure; a rule it breaks in one branch is
           * a finding. Both stay on screen — only the claim differs.
           */
          confirmed: isConfirmedRule(r.evaluable, checked, violated),
        };
      }),
    };
  });

  /** Re-run the oracle without the model. Cheap, and the only way to see it go red. */
  app.post<{ Params: { name: string } }>('/api/procedures/:name/oracle/run', async (request, reply) => {
    const [procedure] = await db.select().from(procedures).where(eq(procedures.name, request.params.name));
    if (procedure === undefined) return reply.code(404).send({ error: 'procedure not found' });
    return runSuite(db, config, request.params.name, 'verify');
  });
}
