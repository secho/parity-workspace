import { getPool, sql } from '../db.js';
import { TRACKED_TABLES } from './tables.js';

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
 * One batch, twelve result sets — not twelve round-trips. Measured in the M1 spike: a
 * single table extraction over a 16k-row table costs ~38 ms, most of it round-trip, so
 * twelve separate calls would dominate the traffic budget on their own.
 */
async function buildExtractionSql(): Promise<string> {
  if (extractionSql) return extractionSql;
  const columns = await loadColumns();

  const statements = TRACKED_TABLES.map((table) => {
    const cols = columns.get(table.name) ?? [];
    const join = table.pk.map((k) => `x.[${k}] = ct.[${k}]`).join(' AND ');
    const pkSelect = table.pk.map((k) => `ct.[${k}] AS [pk_${k}]`).join(', ');

    const valueSelect = cols
      .map(
        (c) =>
          `a.[${c.name}] AS [a_${c.name}], b.[${c.name}] AS [b_${c.name}], ` +
          `CHANGE_TRACKING_IS_COLUMN_IN_MASK(${c.columnId}, ct.SYS_CHANGE_COLUMNS) AS [m_${c.name}]`,
      )
      .join(',\n         ');

    return `
      SELECT ct.SYS_CHANGE_OPERATION AS [__op], ${pkSelect},
         ${valueSelect}
      FROM CHANGETABLE(CHANGES dbo.[${table.name}], @v0) ct
      LEFT JOIN dbo.[${table.name}] a ON ${join.replace(/x\./g, 'a.')}
      LEFT JOIN dbo.[${table.name}] FOR SYSTEM_TIME AS OF @t0 b ON ${join.replace(/x\./g, 'b.')};`;
  });

  extractionSql = statements.join('\n');
  return extractionSql;
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

export async function extractWriteSet(mark: CallMark): Promise<WriteSet> {
  const pool = await getPool();
  const columns = await loadColumns();
  const batch = await buildExtractionSql();

  const result = await pool
    .request()
    .input('v0', sql.BigInt, mark.version)
    .input('t0', sql.DateTime2, mark.t0)
    .query(batch);

  const writeSet: WriteSet = {};

  // One result set per tracked table, in the order the batch was generated.
  const recordsets = result.recordsets as unknown as Record<string, unknown>[][];

  recordsets.forEach((rows, index) => {
    const table = TRACKED_TABLES[index];
    if (!table || rows.length === 0) return;

    const cols = columns.get(table.name) ?? [];
    const changes: RowChange[] = [];

    for (const row of rows) {
      const op = String(row.__op) as 'I' | 'U' | 'D';
      const pk: Record<string, unknown> = {};
      for (const k of table.pk) pk[k] = row[`pk_${k}`];

      const changed: ColumnChange[] = [];
      for (const c of cols) {
        const before = row[`b_${c.name}`] ?? null;
        const after = row[`a_${c.name}`] ?? null;

        // The CT mask is the authority on an UPDATE — it reports what the statement
        // wrote, including a write that happened to set the same value. For inserts and
        // deletes the mask covers every column, so fall back to "has a value".
        const inMask = row[`m_${c.name}`] === 1 || row[`m_${c.name}`] === true;
        const include =
          op === 'U' ? inMask || !equalish(before, after) : op === 'I' ? after !== null : before !== null;

        if (include) changed.push({ column: c.name, before, after });
      }

      changes.push({ pk, op, columns: changed });
    }

    if (changes.length > 0) writeSet[table.name] = changes;
  });

  return writeSet;
}

/** Resets memoised metadata. The seed drops and recreates the database, so column ids
 *  are not stable across a reseed. */
export function resetWriteSetCache(): void {
  columnCache = null;
  extractionSql = null;
}
