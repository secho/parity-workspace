import { sql as raw } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { couplingEdges, procedureCalls, procedureColumns, procedures, specs } from '../db/schema.js';
import type { Config } from '../env.js';
import { couplingEdges as buildEdges, writeOwners, type WriterEntry } from './coupling.js';
import { connect, readCatalog, readInvocationStats, readProcedures } from './mssql.js';
import { buildCatalog, parseProcedure, type ParseResult } from './tsql.js';

/**
 * One ingest: read the estate over the database connection, parse it, and replace the
 * derived artefacts in Parity's own store.
 *
 * Ingest refreshes ESTATE FACTS — source, line counts, invocation counts, the parse and
 * the graphs built from it. It deliberately does not touch ANALYSIS: oracle_class,
 * oracle_state, campaign_status and domain survive a re-ingest, because losing a run's
 * worth of agent work every time someone re-reads the source would be absurd.
 * `make demo-reset` wipes analysis explicitly, which is a different operation.
 */

export interface IngestSummary {
  procedures: number;
  columns: number;
  callEdges: number;
  couplingEdges: number;
  invocations90d: number;
  dynamicSql: string[];
  durationMs: number;
}

export async function ingest(db: Db, config: Config): Promise<IngestSummary> {
  const started = Date.now();
  const pool = await connect(config);

  try {
    const [catalogRows, estateProcedures, stats] = await Promise.all([
      readCatalog(pool),
      readProcedures(pool),
      readInvocationStats(pool),
    ]);

    const catalog = buildCatalog(catalogRows);
    const statsByName = new Map(stats.map((s) => [s.procName, s]));

    const parsed = new Map<string, ParseResult>();
    for (const proc of estateProcedures) parsed.set(proc.name, parseProcedure(proc.definition, catalog));

    // A construct the parser does not understand is a silent under-report, and an absent
    // coupling edge looks exactly like a non-existent one. Refuse rather than guess.
    const unsupported = [...parsed].flatMap(([name, r]) => r.unsupported.map((u) => `${name}: ${u}`));
    if (unsupported.length > 0) {
      throw new Error(`ingest refuses to run — unparsed T-SQL constructs:\n  ${unsupported.join('\n  ')}`);
    }

    const known = new Set(estateProcedures.map((p) => p.name));

    return await db.transaction(async (tx) => {
      // --- estate facts -------------------------------------------------------
      for (const proc of estateProcedures) {
        const stat = statsByName.get(proc.name);
        const result = parsed.get(proc.name)!;
        const values = {
          name: proc.name,
          schemaName: proc.schemaName,
          sourceSql: proc.definition,
          lineCount: proc.definition.split('\n').length,
          invocations90d: Number(stat?.invocations ?? 0),
          lastInvokedAt: stat?.lastInvokedAt ?? null,
          usesDynamicSql: result.usesDynamicSql,
        };
        await tx
          .insert(procedures)
          .values(values)
          .onConflictDoUpdate({ target: procedures.name, set: { ...values, ingestedAt: new Date() } });
      }

      const rows = await tx.select({ id: procedures.id, name: procedures.name }).from(procedures);
      const idOf = new Map(rows.map((r) => [r.name, r.id]));

      // --- derived artefacts, replaced wholesale ------------------------------
      await tx.delete(procedureColumns);
      await tx.delete(procedureCalls);
      await tx.delete(couplingEdges);

      const writers: WriterEntry[] = [...parsed].map(([name, result]) => ({
        procedure: name,
        invocations90d: Number(statsByName.get(name)?.invocations ?? 0),
        writes: result.writes,
      }));
      const owners = writeOwners(writers);

      let columnCount = 0;
      for (const [name, result] of parsed) {
        const procedureId = idOf.get(name)!;
        const values = [
          ...result.reads.map((r) => ({
            procedureId,
            tableName: r.table,
            columnName: r.column,
            access: 'read' as const,
            isWriteOwner: false,
            inferred: r.inferred,
          })),
          ...result.writes.map((w) => ({
            procedureId,
            tableName: w.table,
            columnName: w.column,
            access: 'write' as const,
            isWriteOwner: owners.get(`${w.table}.${w.column}`) === name,
            inferred: w.inferred,
          })),
        ];
        if (values.length > 0) {
          await tx.insert(procedureColumns).values(values);
          columnCount += values.length;
        }
      }

      const callValues = [...parsed].flatMap(([name, result]) =>
        result.calls
          .filter((callee) => known.has(callee) && callee !== name)
          .map((callee) => ({ callerId: idOf.get(name)!, calleeId: idOf.get(callee)! })),
      );
      if (callValues.length > 0) await tx.insert(procedureCalls).values(callValues);

      const edges = buildEdges(writers);
      if (edges.length > 0) {
        await tx.insert(couplingEdges).values(
          edges.map((e) => ({
            tableName: e.tableName,
            columnName: e.columnName,
            aProcedureId: idOf.get(e.a)!,
            bProcedureId: idOf.get(e.b)!,
          })),
        );
      }

      return {
        procedures: estateProcedures.length,
        columns: columnCount,
        callEdges: callValues.length,
        couplingEdges: edges.length,
        invocations90d: stats.reduce((sum, s) => sum + Number(s.invocations), 0),
        dynamicSql: [...parsed].filter(([, r]) => r.usesDynamicSql).map(([n]) => n),
        durationMs: Date.now() - started,
      };
    });
  } finally {
    await pool.close();
  }
}

/**
 * What `make demo-reset` empties, by name.
 *
 * `procedures` cascades to specs, agent_runs, agent_steps and audit_entries. policy_rules is
 * configuration rather than state — reasserted on boot by `seedPolicy` — so it is left alone,
 * and it is the only table here that is.
 *
 * The oracle and shadow tables are named rather than left to CASCADE: beat 1 opens on coverage
 * zero, coverage is a function of oracle_state, and oracle_state only moves because these rows
 * exist. A reset that quietly left them behind would open the demo on the wrong screen — with a
 * decision queue still holding yesterday's findings.
 *
 * `campaign_runs` and `pull_requests` are named for a sharper reason: from M7 neither is
 * reachable by CASCADE. `campaign_runs` has no foreign key at all, and a deletion PR carries a
 * NULL `procedure_id`, so both survive the truncation of `procedures` — beat 1 would open with
 * yesterday's campaign on screen and a deletion PR still assembled.
 *
 * A constant rather than an inline statement because two other things have to agree with it:
 * `SNAPSHOT_TABLES` in `scripts/golden.ts`, which is what a reset can be undone from, and
 * `src/cli/probe-reset.ts`, which truncates inside a transaction it rolls back so that
 * `verify-m7` can check the agreement empirically rather than by reading two files.
 */
export const RESET_TABLES = [
  'coupling_edges',
  'procedure_calls',
  'procedure_columns',
  'golden_results',
  'invariant_results',
  'oracle_runs',
  'golden_tests',
  'invariants',
  'decisions',
  'diffs',
  'shadow_cases',
  'shadow_runs',
  'campaign_runs',
  'pull_requests',
  'agent_runs',
  'specs',
  'procedures',
] as const;

export const RESET_STATEMENT = `TRUNCATE TABLE ${RESET_TABLES.join(', ')} RESTART IDENTITY CASCADE`;

/**
 * Back to "nothing analysed yet". Analysis and estate facts both go; the caller re-ingests,
 * because beat 1 of the demo opens on fourteen procedures with coverage near zero, not on
 * an empty screen.
 */
export async function resetState(db: Db): Promise<void> {
  await db.execute(raw.raw(RESET_STATEMENT));
}
