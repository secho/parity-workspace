import sql from 'mssql';
import type { AmbientContext, RowImage, WriteSet } from '../oracle/execute.js';

/**
 * Write-set extraction on the shadow database, from Change Tracking.
 *
 * This is the mechanism M4 could not use. A golden test runs inside a transaction that never
 * commits, and CT records committed change, so M4 fingerprints every candidate table before
 * and after the call instead. The shadow replay commits, so CT is available — and it is the
 * difference between reading two full scans of a 16 930-row, 72-column table per case and
 * reading only the rows that moved.
 *
 * Two phases, and the split is M1's finding rather than a preference. The single-query form
 * joins the base table on every capture, and CT's own side tables are tiny while the base
 * tables are not: M1 measured ~3 s per capture against 38 ms for one table in isolation.
 * Phase 1 asks CT alone what changed and touches no base table; phase 2 reads images only
 * for the one to five tables that actually did.
 *
 * **Post-images only.** M4's `execute.ts` says the same and for the same reason, one layer
 * along: a shadow diff compares what the old procedure produced against what the new
 * implementation produced, both from the same starting state. "What the row became" on each
 * side is the whole of the answer. A before-image would describe the state both sides
 * started from, which is identical by construction and therefore says nothing.
 *
 * Nothing here is imported from the demo app. Parity reaches ParityShop over the database
 * connection and nothing else, and the shadow database is no different.
 */

/** Cap per table. A 40-line order is the realistic worst case; M1 and M4 use the same bound. */
const MAX_ROWS_PER_TABLE = 200;

const bracket = (identifier: string): string => `[${identifier.replace(/]/g, ']]')}]`;

export interface TrackedTable {
  name: string;
  pk: string[];
}

/**
 * Which tables Change Tracking watches, and their keys — both straight from the engine.
 *
 * Never a committed list of table names. Parity has to stay pointable at an estate whose
 * conventions it has never seen, and a hardcoded list is the one thing that would make the
 * "point it at Alza tomorrow" claim untrue in the code rather than in the pitch.
 */
export async function readTrackedTables(pool: sql.ConnectionPool): Promise<TrackedTable[]> {
  const result = await pool.request().query(`
    SELECT t.name AS tableName, c.name AS columnName, ic.key_ordinal AS ordinal
    FROM sys.change_tracking_tables ct
    JOIN sys.tables t ON t.object_id = ct.object_id
    JOIN sys.indexes i ON i.object_id = t.object_id AND i.is_primary_key = 1
    JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
    JOIN sys.columns c ON c.object_id = t.object_id AND c.column_id = ic.column_id
    WHERE SCHEMA_NAME(t.schema_id) = 'dbo'
    ORDER BY t.name, ic.key_ordinal`);

  const keys = new Map<string, string[]>();
  for (const row of result.recordset as { tableName: string; columnName: string }[]) {
    keys.set(row.tableName, [...(keys.get(row.tableName) ?? []), row.columnName]);
  }
  return [...keys.entries()].map(([name, pk]) => ({ name, pk }));
}

/**
 * The visible columns of each tracked table.
 *
 * `is_hidden = 0` drops the period columns system versioning adds. Those are the estate's
 * infrastructure rather than its data, and a diff that reported them would report a
 * difference on every single row.
 */
export async function readColumns(pool: sql.ConnectionPool): Promise<Map<string, string[]>> {
  const result = await pool.request().query(`
    SELECT t.name AS tableName, c.name AS columnName
    FROM sys.tables t
    JOIN sys.columns c ON c.object_id = t.object_id
    WHERE SCHEMA_NAME(t.schema_id) = 'dbo' AND c.is_hidden = 0
    ORDER BY t.name, c.column_id`);

  const columns = new Map<string, string[]>();
  for (const row of result.recordset as { tableName: string; columnName: string }[]) {
    columns.set(row.tableName, [...(columns.get(row.tableName) ?? []), row.columnName]);
  }
  return columns;
}

export interface CallMark {
  version: string;
  context: AmbientContext;
  /** Server clock before the call. Half of the window the canonicaliser normalises against. */
  clockFrom: number;
}

/**
 * Taken in one round-trip so the CT version and the ambient values agree — M1's rule, and
 * the reason a shadow run can be compared to a capture at all.
 */
export async function markCall(pool: sql.ConnectionPool): Promise<CallMark> {
  const row = (
    await pool.request().query(`
      SELECT CHANGE_TRACKING_CURRENT_VERSION() AS version,
             GETDATE() AS clockFrom,
             CONVERT(varchar(33), GETDATE(), 126) AS getdate,
             CONVERT(varchar(33), SYSDATETIME(), 126) AS sysdatetime,
             CONVERT(varchar(33), SYSUTCDATETIME(), 126) AS sysutcdatetime,
             @@DATEFIRST AS datefirst, @@LANGUAGE AS language`)
  ).recordset[0] as Record<string, unknown>;

  return {
    version: String(row.version ?? '0'),
    clockFrom: (row.clockFrom as Date).getTime(),
    context: {
      getdate: String(row.getdate),
      sysdatetime: String(row.sysdatetime),
      sysutcdatetime: String(row.sysutcdatetime),
      datefirst: Number(row.datefirst),
      language: String(row.language),
    },
  };
}

export interface ExtractedWriteSet {
  writeSet: WriteSet;
  truncatedTables: string[];
}

/**
 * Everything committed since `mark`, as post-images.
 *
 * The replay is deliberately serial. A concurrent write would land inside this version
 * window and be attributed to a call that did not make it — M1's write-lane reasoning
 * applies unchanged, and a write set that quietly absorbs someone else's row is exactly the
 * defect that would make every downstream verdict untrustworthy.
 */
export async function extractWriteSet(
  pool: sql.ConnectionPool,
  mark: CallMark,
  tables: TrackedTable[],
  columns: Map<string, string[]>,
): Promise<ExtractedWriteSet> {
  // --- phase 1: what changed, from CT alone -----------------------------------
  const detect = tables
    .map(
      (t) => `SELECT ct.SYS_CHANGE_OPERATION AS __op, ${t.pk.map((k) => `ct.${bracket(k)}`).join(', ')}
              FROM CHANGETABLE(CHANGES dbo.${bracket(t.name)}, @v0) ct
              ORDER BY ${t.pk.map((k) => `ct.${bracket(k)}`).join(', ')};`,
    )
    .join('\n');

  const detected = (
    await pool.request().input('v0', sql.BigInt, mark.version).query(detect)
  ).recordsets as unknown as Record<string, unknown>[][];

  const pending = tables
    .map((table, index) => ({ table, rows: detected[index] ?? [] }))
    .filter((p) => p.rows.length > 0);

  if (pending.length === 0) return { writeSet: {}, truncatedTables: [] };

  // --- phase 2: images, only for the tables that changed -----------------------
  // One round-trip per changed table rather than one shared batch: the key parameter names
  // repeat across tables. In practice `pending` is one to five, never all twelve.
  const writeSet: WriteSet = {};
  const truncatedTables: string[] = [];

  for (const { table, rows } of pending) {
    if (rows.length > MAX_ROWS_PER_TABLE) truncatedTables.push(table.name);
    const capped = rows.slice(0, MAX_ROWS_PER_TABLE);

    const request = pool.request();
    capped.forEach((row, i) => {
      table.pk.forEach((k, j) => request.input(`k${i}_${j}`, row[k] as never));
    });

    const predicate =
      table.pk.length === 1
        ? `${bracket(table.pk[0])} IN (${capped.map((_, i) => `@k${i}_0`).join(', ')})`
        : capped
            .map((_, i) => `(${table.pk.map((k, j) => `${bracket(k)} = @k${i}_${j}`).join(' AND ')})`)
            .join(' OR ');

    const list = (columns.get(table.name) ?? []).map(bracket).join(', ');
    const images = (
      await request.query(`SELECT ${list} FROM dbo.${bracket(table.name)} WHERE ${predicate};`)
    ).recordset as unknown as Record<string, unknown>[];

    const key = (values: Record<string, unknown>, source: string[]): string =>
      source.map((k) => String(values[k])).join(' ');
    const byKey = new Map(images.map((r) => [key(r, table.pk), r]));

    writeSet[table.name] = capped.map((row): RowImage => {
      const op = String(row.__op) as 'I' | 'U' | 'D';
      const pk = Object.fromEntries(table.pk.map((k) => [k, row[k]]));
      // A deleted row has no post-image, and CT's own record is the only evidence it existed.
      const image = op === 'D' ? null : (byKey.get(key(pk, table.pk)) ?? null);
      return { pk, op, row: image };
    });
  }

  return { writeSet, truncatedTables };
}
