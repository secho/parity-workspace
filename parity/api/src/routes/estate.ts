import { asc, eq, or, sql as raw } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { couplingEdges, procedureCalls, procedureColumns, procedures } from '../db/schema.js';
import { blockerFor } from '../estate/blocker.js';
import { blockerBreakdown, statusBar, totalsFor, type CoverageRow } from '../estate/coverage.js';

/** Every procedure the API hands out carries its blocker, computed on the way past. */
function withBlocker<T extends CoverageRow>(row: T): T & { blocker: ReturnType<typeof blockerFor> } {
  return { ...row, blocker: blockerFor(row) };
}

export async function estateRoutes(app: FastifyInstance, db: Db): Promise<void> {
  app.get('/api/estate', async () => {
    const rows = await db
      .select({
        name: procedures.name,
        schemaName: procedures.schemaName,
        lineCount: procedures.lineCount,
        invocations90d: procedures.invocations90d,
        lastInvokedAt: procedures.lastInvokedAt,
        oracleClass: procedures.oracleClass,
        oracleState: procedures.oracleState,
        campaignStatus: procedures.campaignStatus,
        domain: procedures.domain,
        riskClass: procedures.riskClass,
        ownerTeam: procedures.ownerTeam,
        usesDynamicSql: procedures.usesDynamicSql,
      })
      .from(procedures)
      .orderBy(asc(procedures.name));

    return {
      totals: totalsFor(rows),
      statusBar: statusBar(rows),
      blockers: blockerBreakdown(rows),
      procedures: rows.map(withBlocker),
    };
  });

  app.get<{ Params: { name: string } }>('/api/procedures/:name', async (request, reply) => {
    const [procedure] = await db.select().from(procedures).where(eq(procedures.name, request.params.name));
    if (procedure === undefined) return reply.code(404).send({ error: 'procedure not found' });

    const columns = await db
      .select()
      .from(procedureColumns)
      .where(eq(procedureColumns.procedureId, procedure.id))
      .orderBy(asc(procedureColumns.tableName), asc(procedureColumns.columnName));

    const edges = await db
      .select({
        tableName: couplingEdges.tableName,
        columnName: couplingEdges.columnName,
        a: couplingEdges.aProcedureId,
        b: couplingEdges.bProcedureId,
      })
      .from(couplingEdges)
      .where(or(eq(couplingEdges.aProcedureId, procedure.id), eq(couplingEdges.bProcedureId, procedure.id)))
      .orderBy(asc(couplingEdges.tableName), asc(couplingEdges.columnName));

    const names = new Map(
      (await db.select({ id: procedures.id, name: procedures.name }).from(procedures)).map((r) => [r.id, r.name]),
    );

    const calls = await db
      .select({ callerId: procedureCalls.callerId, calleeId: procedureCalls.calleeId })
      .from(procedureCalls)
      .where(or(eq(procedureCalls.callerId, procedure.id), eq(procedureCalls.calleeId, procedure.id)));

    // How many procedures write each column, so the view can rank the collisions that
    // mean something above the ones that do not. A column six procedures write is an
    // audit column; a column exactly two write is a fight nobody wrote down. Computed,
    // never a hardcoded list of column names — Parity has to stay pointable at an estate
    // whose conventions it has never seen.
    const writerCounts = await db
      .select({
        tableName: procedureColumns.tableName,
        columnName: procedureColumns.columnName,
        writers: raw<number>`count(*)::int`,
      })
      .from(procedureColumns)
      .where(eq(procedureColumns.access, 'write'))
      .groupBy(procedureColumns.tableName, procedureColumns.columnName);
    const writersOf = new Map(writerCounts.map((w) => [`${w.tableName}.${w.columnName}`, w.writers]));

    return {
      procedure: withBlocker(procedure),
      reads: columns.filter((c) => c.access === 'read'),
      writes: columns.filter((c) => c.access === 'write'),
      // Who else writes the columns this procedure writes, and which column they collide
      // on. Narrowest sharing first: that is where the surprise is.
      coupling: edges
        .map((e) => ({
          tableName: e.tableName,
          columnName: e.columnName,
          other: names.get(e.a === procedure.id ? e.b : e.a) ?? '?',
          writers: writersOf.get(`${e.tableName}.${e.columnName}`) ?? 2,
        }))
        .sort((x, y) =>
          x.writers !== y.writers
            ? x.writers - y.writers
            : x.tableName !== y.tableName
              ? x.tableName.localeCompare(y.tableName)
              : x.columnName.localeCompare(y.columnName),
        ),
      calls: calls.filter((c) => c.callerId === procedure.id).map((c) => names.get(c.calleeId) ?? '?'),
      calledBy: calls.filter((c) => c.calleeId === procedure.id).map((c) => names.get(c.callerId) ?? '?'),
    };
  });

  /** The blocker breakdown rows link here — each one is a filtered slice of the estate. */
  app.get<{ Querystring: { blocker?: string } }>('/api/procedures', async (request) => {
    const rows = await db
      .select({
        name: procedures.name,
        invocations90d: procedures.invocations90d,
        oracleClass: procedures.oracleClass,
        oracleState: procedures.oracleState,
        campaignStatus: procedures.campaignStatus,
        domain: procedures.domain,
      })
      .from(procedures)
      .orderBy(asc(procedures.name));

    const wanted = request.query.blocker;
    const filtered = wanted === undefined ? rows : rows.filter((r) => blockerFor(r)?.key === wanted);
    return { procedures: filtered.map(withBlocker) };
  });

  /** Used by the coupling view: the full graph, one row per shared column. */
  app.get('/api/coupling', async () => {
    const names = new Map(
      (await db.select({ id: procedures.id, name: procedures.name }).from(procedures)).map((r) => [r.id, r.name]),
    );
    const edges = await db
      .select()
      .from(couplingEdges)
      .orderBy(asc(couplingEdges.tableName), asc(couplingEdges.columnName));
    return {
      edges: edges.map((e) => ({
        tableName: e.tableName,
        columnName: e.columnName,
        a: names.get(e.aProcedureId) ?? '?',
        b: names.get(e.bProcedureId) ?? '?',
      })),
    };
  });
}
