import { getPool, sql } from '../db.js';
import { TRACKED_TABLES, type TrackedTable } from './tables.js';

/**
 * Write-set extraction: Change Tracking says WHICH rows and columns changed, temporal
 * history says what the values WERE, and the base table says what they ARE.
 *
 * CHANGETABLE never stores values — that is the whole reason system versioning is on.
 */

export interface ColumnChange {
  column: string;
  before: unknown;
  after: unknown;
}

export interface RowChange {
  pk: Record<string, unknown>;
  op: 'I' | 'U' | 'D';
  columns: ColumnChange[];
}

export type WriteSet = Record<string, RowChange[]>;

export interface CallMark {
  version: string;
  /** Server-side UTC instant, used as the temporal AS OF point. */
  t0: Date;
  /** Ambient values the procedure itself could read. See context.getdate. */
  context: AmbientContext;
}

export interface AmbientContext {
  /** What GETDATE() returns inside the procedure's session — four procedures BRANCH on this. */
  getdate: string;
  sysdatetime: string;
  sysutcdatetime: string;
  datefirst: number;
  language: string;
}

interface ColumnMeta {
  name: string;
  columnId: number;
}

let columnCache: Map<string, ColumnMeta[]> | null = null;
let extractionSql: string | null = null;

async function loadColumns(): Promise<Map<string, ColumnMeta[]>> {
  if (columnCache) return columnCache;
  const pool = await getPool();
  const names = TRACKED_TABLES.map((t) => `'${t.name}'`).join(',');
  const result = await pool.request().query(`
    SELECT t.name AS TableName, c.name AS ColumnName, c.column_id AS ColumnId
    FROM sys.tables t
    JOIN sys.columns c ON c.object_id = t.object_id
    WHERE SCHEMA_NAME(t.schema_id) = 'dbo'
      AND t.name IN (${names})
      AND c.is_hidden = 0          -- period columns are ours, not the estate's
    ORDER BY t.name, c.column_id`);

  const map = new Map<string, ColumnMeta[]>();
  for (const row of result.recordset as { TableName: string; ColumnName: string; ColumnId: number }[]) {
    if (!map.has(row.TableName)) map.set(row.TableName, []);
    map.get(row.TableName)!.push({ name: row.ColumnName, columnId: row.ColumnId });
  }
  columnCache = map;
  return map;
}

/**
 * Phase 1: which rows and columns changed, per table. Reads only Change Tracking's own
 * side tables and evaluates the column mask — it never touches the base tables.
 *
 * This has to be separate from fetching values. The obvious single-query form joins
 * `FOR SYSTEM_TIME AS OF` against all twelve tables on every capture, and AS OF unions
 * base with history, so every extraction scanned every table whether or not it had
 * changed. Measured: ~3 s per capture, against 38 ms for a single table in isolation.
 * Most calls touch one to five tables, so the fix is simply not to read the rest.
 */
async function buildDetectSql(): Promise<string> {
  if (extractionSql) return extractionSql;
  const columns = await loadColumns();

  extractionSql = TRACKED_TABLES.map((table) => {
    const cols = columns.get(table.name) ?? [];
    const pkSelect = table.pk.map((k) => `ct.[${k}] AS [pk_${k}]`).join(', ');
    const maskSelect = cols
      .map((c) => `CHANGE_TRACKING_IS_COLUMN_IN_MASK(${c.columnId}, ct.SYS_CHANGE_COLUMNS) AS [m_${c.name}]`)
      .join(', ');
    return `SELECT ct.SYS_CHANGE_OPERATION AS [__op], ${pkSelect}${maskSelect ? `, ${maskSelect}` : ''}
            FROM CHANGETABLE(CHANGES dbo.[${table.name}], @v0) ct;`;
  }).join('\n');

  return extractionSql;
}

/** Phase 2: row images for the handful of rows phase 1 reported, filtered by primary key
 *  so both the base table and the temporal history can seek instead of scan. */
function buildImageSql(table: TrackedTable, cols: ColumnMeta[], rowCount: number): string {
  // `cols` already contains the key columns. Selecting them again produced a duplicate
  // column name, which the driver collapses into an array — so the row key came back as
  // "78,78" and never matched, silently nulling every before/after value.
  const list = cols.map((c) => `[${c.name}]`).join(', ');
  const predicate =
    table.pk.length === 1
      ? `[${table.pk[0]}] IN (${Array.from({ length: rowCount }, (_, i) => `@k${i}_0`).join(', ')})`
      : Array.from({ length: rowCount }, (_, i) =>
          `(${table.pk.map((k, j) => `[${k}] = @k${i}_${j}`).join(' AND ')})`,
        ).join(' OR ');

  return `
    SELECT ${list} FROM dbo.[${table.name}] WHERE ${predicate};
    SELECT ${list} FROM dbo.[${table.name}] FOR SYSTEM_TIME AS OF @t0 WHERE ${predicate};`;
}

/** Taken in a single round-trip so the CT version and the AS OF instant agree, and so the
 *  ambient clock is the server's own rather than Node's (they drift). */
export async function markCall(): Promise<CallMark> {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT CHANGE_TRACKING_CURRENT_VERSION() AS version,
           SYSUTCDATETIME()  AS t0,
           GETDATE()         AS getdate,
           SYSDATETIME()     AS sysdatetime,
           SYSUTCDATETIME()  AS sysutcdatetime,
           @@DATEFIRST       AS datefirst,
           @@LANGUAGE        AS language`);
  const row = result.recordset[0] as Record<string, unknown>;
  return {
    version: String(row.version ?? '0'),
    t0: row.t0 as Date,
    context: {
      getdate: (row.getdate as Date).toISOString(),
      sysdatetime: (row.sysdatetime as Date).toISOString(),
      sysutcdatetime: (row.sysutcdatetime as Date).toISOString(),
      datefirst: Number(row.datefirst),
      language: String(row.language),
    },
  };
}

const equalish = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return String(a) === String(b);
};

/** Cap the rows imaged per table. A 40-line order is the realistic worst case; anything
 *  beyond this is a bulk operation whose full image is not worth the capture cost. */
const MAX_IMAGED_ROWS = 200;

export async function extractWriteSet(mark: CallMark): Promise<WriteSet> {
  const pool = await getPool();
  const columns = await loadColumns();

  // --- phase 1: what changed -------------------------------------------------
  const detected = await pool
    .request()
    .input('v0', sql.BigInt, mark.version)
    .query(await buildDetectSql());

  const detectedSets = detected.recordsets as unknown as Record<string, unknown>[][];
  const pending: { table: TrackedTable; rows: Record<string, unknown>[] }[] = [];
  detectedSets.forEach((rows, index) => {
    const table = TRACKED_TABLES[index];
    if (table && rows.length > 0) pending.push({ table, rows: rows.slice(0, MAX_IMAGED_ROWS) });
  });
  if (pending.length === 0) return {};

  // --- phase 2: values, only for the tables that actually changed ------------
  // One round-trip per changed table rather than one shared batch: the key parameter
  // names repeat per table. `pending` is one to five tables in practice, never twelve.
  type Image = {
    after: Map<string, Record<string, unknown>>;
    before: Map<string, Record<string, unknown>>;
  };
  const images = new Map<string, Image>();

  for (const { table, rows } of pending) {
    const request = pool.request().input('t0', sql.DateTime2, mark.t0);
    rows.forEach((row, i) => {
      table.pk.forEach((k, j) => request.input(`k${i}_${j}`, row[`pk_${k}`] as never));
    });

    const result = await request.query(buildImageSql(table, columns.get(table.name) ?? [], rows.length));
    const [afterRows = [], beforeRows = []] = result.recordsets as unknown as Record<string, unknown>[][];
    const key = (r: Record<string, unknown>): string => table.pk.map((k) => String(r[k])).join(' ');

    images.set(table.name, {
      after: new Map(afterRows.map((r) => [key(r), r])),
      before: new Map(beforeRows.map((r) => [key(r), r])),
    });
  }

  // --- assemble --------------------------------------------------------------
  const writeSet: WriteSet = {};
  for (const { table, rows } of pending) {
    const cols = columns.get(table.name) ?? [];
    const image = images.get(table.name)!;
    const changes: RowChange[] = [];

    for (const row of rows) {
      const op = String(row.__op) as 'I' | 'U' | 'D';
      const pk: Record<string, unknown> = {};
      for (const k of table.pk) pk[k] = row[`pk_${k}`];
      const lookup = table.pk.map((k) => String(pk[k])).join('');
      const after = image.after.get(lookup) ?? {};
      const before = image.before.get(lookup) ?? {};

      const changed: ColumnChange[] = [];
      for (const c of cols) {
        const beforeValue = before[c.name] ?? null;
        const afterValue = after[c.name] ?? null;

        // The CT mask is the authority on an UPDATE — it reports what the statement
        // wrote, including a write that set the same value back. For inserts and deletes
        // the mask covers every column, so fall back to "has a value".
        const inMask = row[`m_${c.name}`] === 1 || row[`m_${c.name}`] === true;
        const include =
          op === 'U'
            ? inMask || !equalish(beforeValue, afterValue)
            : op === 'I'
              ? afterValue !== null
              : beforeValue !== null;

        if (include) changed.push({ column: c.name, before: beforeValue, after: afterValue });
      }

      changes.push({ pk, op, columns: changed });
    }

    if (changes.length > 0) writeSet[table.name] = changes;
  }

  return writeSet;
}

/** Resets memoised metadata. The seed drops and recreates the database, so column ids
 *  are not stable across a reseed. */
export function resetWriteSetCache(): void {
  columnCache = null;
  extractionSql = null;
}
