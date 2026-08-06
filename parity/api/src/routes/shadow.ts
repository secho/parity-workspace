import { and, desc, eq, inArray, isNull, sql as raw } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { decisions, diffs, procedures, shadowCases, shadowRuns } from '../db/schema.js';
import type { Config } from '../env.js';
import { runShadow } from '../shadow/run.js';
import { classifyRun } from '../shadow/classify.js';

/**
 * What the Procedura → Shadow tab and the Fronta rozhodnutí screen read.
 *
 * A queue **item is derived**, never stored: it is a group of `diffs` sharing a signature,
 * classified `behaviour_change`, with no matching `decisions` row. Same rule as `blocker` and
 * as M4's `confirmed` — a stored "still open" flag drifts from the rows it was drawn from,
 * and a queue that has drifted shows a human work that is already done.
 */

interface QueueItem {
  signature: string;
  procedure: string;
  procedureId: number;
  shadowRunId: number;
  scope: string;
  tableName: string | null;
  columnName: string | null;
  cases: number;
  rowsAffected: number;
  explanationCs: string | null;
  ownerTeam: string | null;
  riskClass: string | null;
  sample: {
    sourceInvocationId: number;
    branchKey: string | null;
    inputParams: unknown;
    oldValue: unknown;
    newValue: unknown;
  } | null;
  decision: { action: string; note: string | null; decidedBy: string; decidedAt: Date } | null;
}

/**
 * The newest succeeded shadow run of each procedure.
 *
 * The queue shows work, not an archive. A finding's `signature` names the *shape* of a
 * difference — `write_set:OrderLedger.TotalVat:material` — so it recurs identically in every
 * run that reproduces it, and an unscoped queue therefore listed the same finding once per
 * run. A human re-running a shadow run then had to decide everything twice, and React was
 * handed duplicate keys into the bargain.
 *
 * Found in use rather than in review: three runs existed, four findings each, and the queue
 * asked for eight decisions. The same scoping mistake had already been fixed in
 * `classify_diff` and in the decision undo — anything keyed on a signature has to say which
 * run it means.
 *
 * A superseded run keeps its rows and its decisions; it simply stops being the thing the
 * queue asks about.
 */
async function latestRunIds(db: Db): Promise<number[]> {
  const rows = await db
    .select({ id: shadowRuns.id, procedureId: shadowRuns.procedureId })
    .from(shadowRuns)
    .where(and(eq(shadowRuns.kind, 'shadow'), eq(shadowRuns.status, 'succeeded')))
    .orderBy(desc(shadowRuns.id));

  const seen = new Set<number>();
  return rows.filter((row) => !seen.has(row.procedureId) && seen.add(row.procedureId)).map((row) => row.id);
}

/**
 * Every behaviour_change finding, with its decision if one has been taken.
 *
 * `shadowRunId === null` means "the estate", which is the latest run of every procedure —
 * never every run of every procedure.
 */
async function itemsFor(db: Db, shadowRunId: number | null): Promise<QueueItem[]> {
  const scope = shadowRunId === null ? await latestRunIds(db) : [shadowRunId];
  if (scope.length === 0) return [];
  const rows = await db
    .select({
      signature: diffs.signature,
      shadowRunId: diffs.shadowRunId,
      scope: diffs.scope,
      tableName: diffs.tableName,
      columnName: diffs.columnName,
      explanationCs: diffs.explanationCs,
      cases: raw<number>`count(distinct ${diffs.shadowCaseId})::int`,
      rowsAffected: raw<number>`sum(${diffs.rowsAffected})::int`,
      minCaseId: raw<number>`min(${diffs.shadowCaseId})::int`,
      procedureId: procedures.id,
      procedure: procedures.name,
      ownerTeam: procedures.ownerTeam,
      riskClass: procedures.riskClass,
    })
    .from(diffs)
    .innerJoin(shadowRuns, eq(shadowRuns.id, diffs.shadowRunId))
    .innerJoin(procedures, eq(procedures.id, shadowRuns.procedureId))
    .where(and(eq(diffs.verdict, 'behaviour_change'), inArray(diffs.shadowRunId, scope)))
    .groupBy(
      diffs.signature,
      diffs.shadowRunId,
      diffs.scope,
      diffs.tableName,
      diffs.columnName,
      diffs.explanationCs,
      procedures.id,
      procedures.name,
      procedures.ownerTeam,
      procedures.riskClass,
    )
    .orderBy(desc(raw`count(distinct ${diffs.shadowCaseId})`), diffs.signature);

  const taken = await db.select().from(decisions);
  const byKey = new Map(taken.map((d) => [`${d.shadowRunId} ${d.diffSignature}`, d]));

  const items: QueueItem[] = [];
  for (const row of rows) {
    // The lowest case id, so the side-by-side a human sees is the same one between runs and
    // the same one the classifier was shown.
    const [sample] = await db
      .select({
        sourceInvocationId: shadowCases.sourceInvocationId,
        branchKey: shadowCases.branchKey,
        inputParams: shadowCases.inputParams,
        oldValue: diffs.oldValue,
        newValue: diffs.newValue,
      })
      .from(diffs)
      .innerJoin(shadowCases, eq(shadowCases.id, diffs.shadowCaseId))
      .where(and(eq(diffs.shadowRunId, row.shadowRunId), eq(diffs.signature, row.signature)))
      .orderBy(shadowCases.seq)
      .limit(1);

    const decision = byKey.get(`${row.shadowRunId} ${row.signature}`);
    items.push({
      signature: row.signature,
      procedure: row.procedure,
      procedureId: row.procedureId,
      shadowRunId: row.shadowRunId,
      scope: row.scope,
      tableName: row.tableName,
      columnName: row.columnName,
      cases: row.cases,
      rowsAffected: row.rowsAffected,
      explanationCs: row.explanationCs,
      ownerTeam: row.ownerTeam,
      riskClass: row.riskClass,
      sample: sample ?? null,
      decision:
        decision === undefined
          ? null
          : { action: decision.action, note: decision.note, decidedBy: decision.decidedBy, decidedAt: decision.decidedAt },
    });
  }

  return items;
}

export async function shadowRoutes(app: FastifyInstance, db: Db, config: Config): Promise<void> {
  app.get<{ Params: { name: string } }>('/api/procedures/:name/shadow', async (request, reply) => {
    const [procedure] = await db.select().from(procedures).where(eq(procedures.name, request.params.name));
    if (procedure === undefined) return reply.code(404).send({ error: 'procedure not found' });

    const runs = await db
      .select()
      .from(shadowRuns)
      .where(eq(shadowRuns.procedureId, procedure.id))
      .orderBy(desc(shadowRuns.id));

    // The A/A control is a test of the harness, not of the estate. Showing it beside real
    // runs would put a run that is supposed to find nothing next to one that found something
    // and invite the reader to compare them.
    const real = runs.filter((run) => run.kind !== 'aa');
    const latest = real[0] ?? null;

    const breakdown =
      latest === null
        ? []
        : await db
            .select({
              verdict: diffs.verdict,
              verdictSource: diffs.verdictSource,
              noiseReason: diffs.noiseReason,
              n: raw<number>`count(*)::int`,
            })
            .from(diffs)
            .where(eq(diffs.shadowRunId, latest.id))
            .groupBy(diffs.verdict, diffs.verdictSource, diffs.noiseReason)
            .orderBy(desc(raw`count(*)`));

    return {
      runs: real,
      controlRuns: runs.filter((run) => run.kind === 'aa'),
      latestRun: latest,
      breakdown,
      findings: latest === null ? [] : await itemsFor(db, latest.id),
    };
  });

  /**
   * Every decision ever taken on this procedure, newest first — by PROCEDURE, not by run.
   *
   * The queue is scoped to the latest run because it shows work, and work that has been
   * superseded is not work. But that scoping has a consequence M6 makes visible: the moment
   * the generated service replays green, the latest run has zero findings, so the queue
   * empties — and it takes the *decided* list with it. Beat 4 of the demo would end on a blank
   * screen, immediately after the most important click in the whole thing.
   *
   * A decision is not work, it is a record. It belongs to the procedure and it outlives the
   * run that provoked it, which is exactly what the PR has to attach.
   */
  app.get<{ Params: { name: string } }>('/api/procedures/:name/decisions', async (req, reply) => {
    const [procedure] = await db.select().from(procedures).where(eq(procedures.name, req.params.name));
    if (procedure === undefined) return reply.code(404).send({ error: 'no such procedure' });

    const rows = await db
      .select({
        id: decisions.id,
        signature: decisions.diffSignature,
        action: decisions.action,
        note: decisions.note,
        decidedBy: decisions.decidedBy,
        decidedAt: decisions.decidedAt,
        shadowRunId: decisions.shadowRunId,
        implementation: shadowRuns.implementation,
      })
      .from(decisions)
      .innerJoin(shadowRuns, eq(decisions.shadowRunId, shadowRuns.id))
      .where(eq(decisions.procedureId, procedure.id))
      .orderBy(desc(decisions.decidedAt));

    return { procedure: procedure.name, decisions: rows };
  });

  /**
   * Start a shadow run, then classify what survived canonicalisation.
   *
   * Long — twenty seconds of replay plus one model run per finding — so the client is
   * expected to hold the request open. The SSE stream on the procedure page carries progress.
   */
  app.post<{ Params: { name: string }; Body: { cases?: number; classify?: boolean } }>(
    '/api/procedures/:name/shadow/run',
    async (request, reply) => {
      const [procedure] = await db.select().from(procedures).where(eq(procedures.name, request.params.name));
      if (procedure === undefined) return reply.code(404).send({ error: 'procedure not found' });

      const result = await runShadow(db, config, {
        procedureName: request.params.name,
        limit: request.body?.cases,
      });
      if (request.body?.classify === false) return { run: result, classified: null };
      return { run: result, classified: await classifyRun(db, config, result) };
    },
  );

  /** Every open finding across the estate. This is the Fronta screen. */
  app.get('/api/queue', async () => {
    const items = await itemsFor(db, null);
    return {
      open: items.filter((item) => item.decision === null),
      decided: items.filter((item) => item.decision !== null),
    };
  });

  /**
   * The header counter.
   *
   * Deliberately scoped to the latest shadow run rather than to "today". `SPEC.md` §4 words it
   * as `X odchylek dnes`, and a wall-clock window would give a different number at each
   * rehearsal for reasons that have nothing to do with the estate — which is the drift hard
   * rule 5 exists to prevent. What the sentence is actually for is "how much did the machine
   * absorb, and how much reached a person", and the run is the honest unit for that.
   */
  app.get('/api/queue/summary', async () => {
    const [latest] = await db
      .select()
      .from(shadowRuns)
      .where(eq(shadowRuns.kind, 'shadow'))
      .orderBy(desc(shadowRuns.id))
      .limit(1);

    const items = await itemsFor(db, null);
    return {
      latestRun: latest ?? null,
      rawDiffs: latest?.rawDiffs ?? 0,
      resolvedInCode: latest?.noiseDiffs ?? 0,
      reachedHuman: items.filter((item) => item.decision === null).length,
      decided: items.filter((item) => item.decision !== null).length,
    };
  });

  /** `Zachovat chování` · `Přijmout změnu` · `Eskalovat`. */
  app.post<{ Params: { signature: string }; Body: { action?: string; note?: string; shadowRunId?: number } }>(
    '/api/queue/:signature/decision',
    async (request, reply) => {
      const action = request.body?.action ?? '';
      if (!['preserve', 'accept', 'escalate'].includes(action)) {
        return reply.code(400).send({ error: 'action must be preserve, accept or escalate' });
      }

      const signature = decodeURIComponent(request.params.signature);
      const [diff] = await db
        .select({ shadowRunId: diffs.shadowRunId, procedureId: shadowRuns.procedureId })
        .from(diffs)
        .innerJoin(shadowRuns, eq(shadowRuns.id, diffs.shadowRunId))
        .where(
          request.body?.shadowRunId === undefined
            ? eq(diffs.signature, signature)
            : and(eq(diffs.signature, signature), eq(diffs.shadowRunId, request.body.shadowRunId)),
        )
        .orderBy(desc(diffs.shadowRunId))
        .limit(1);

      if (diff === undefined) return reply.code(404).send({ error: 'no finding with that signature' });

      const [row] = await db
        .insert(decisions)
        .values({
          procedureId: diff.procedureId,
          shadowRunId: diff.shadowRunId,
          diffSignature: signature,
          action,
          note: request.body?.note ?? null,
          decidedBy: 'human',
        })
        .onConflictDoUpdate({
          target: [decisions.shadowRunId, decisions.diffSignature],
          set: { action, note: request.body?.note ?? null, decidedBy: 'human', decidedAt: new Date() },
        })
        .returning();

      return { decision: row };
    },
  );

  /**
   * Undo, so a rehearsal can put the queue back without a reset.
   *
   * Scoped to one run, like the POST and like the uniqueness key. A signature names a shape
   * rather than a run, so an unscoped delete would undo the same finding's decision in every
   * shadow run that ever produced it — including ones a later run is supposed to inherit.
   */
  app.delete<{ Params: { signature: string }; Querystring: { shadowRunId?: string } }>(
    '/api/queue/:signature/decision',
    async (request) => {
      const signature = decodeURIComponent(request.params.signature);
      const scoped = request.query.shadowRunId;

      const shadowRunId =
        scoped === undefined
          ? (
              await db
                .select({ id: decisions.shadowRunId })
                .from(decisions)
                .where(eq(decisions.diffSignature, signature))
                .orderBy(desc(decisions.shadowRunId))
                .limit(1)
            )[0]?.id
          : Number(scoped);

      if (shadowRunId === undefined) return { removed: 0 };

      const removed = await db
        .delete(decisions)
        .where(and(eq(decisions.diffSignature, signature), eq(decisions.shadowRunId, shadowRunId)))
        .returning();
      return { removed: removed.length };
    },
  );

  /** Everything a run resolved without asking anyone — the evidence for the §8 claim. */
  app.get<{ Params: { id: string } }>('/api/shadow-runs/:id/diffs', async (request) => {
    const shadowRunId = Number(request.params.id);
    const rows = await db
      .select({
        signature: diffs.signature,
        verdict: diffs.verdict,
        verdictSource: diffs.verdictSource,
        noiseReason: diffs.noiseReason,
        tableName: diffs.tableName,
        columnName: diffs.columnName,
        cases: raw<number>`count(distinct ${diffs.shadowCaseId})::int`,
        rows: raw<number>`sum(${diffs.rowsAffected})::int`,
        sawModel: raw<boolean>`bool_or(${diffs.agentRunId} is not null)`,
      })
      .from(diffs)
      .where(eq(diffs.shadowRunId, shadowRunId))
      .groupBy(diffs.signature, diffs.verdict, diffs.verdictSource, diffs.noiseReason, diffs.tableName, diffs.columnName)
      .orderBy(desc(raw`sum(${diffs.rowsAffected})`));

    const unclassified = (
      await db.select({ id: diffs.id }).from(diffs).where(and(eq(diffs.shadowRunId, shadowRunId), isNull(diffs.verdict)))
    ).length;

    return { diffs: rows, unclassified };
  });
}
