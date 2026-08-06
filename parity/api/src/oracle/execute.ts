import sql from 'mssql';

/**
 * Run one procedure and find out exactly what it did, without leaving a trace.
 *
 * Everything happens inside a transaction that is always rolled back, under the
 * `parity_runner` principal — the only one with EXECUTE, and one with no DDL at all.
 *
 * **Change Tracking cannot be reused here.** M1 captures write sets from
 * `CHANGETABLE(CHANGES …)`, which is the right mechanism for traffic that commits. This
 * transaction never commits, so CT has nothing to report. Instead each table the procedure
 * is known to write is fingerprinted per row before the call and again after, inside the
 * transaction, and the rows whose fingerprint moved are read back in full.
 *
 * Post-images only. A golden test compares one run of the current procedure against another
 * run of it, so "what the row became" is the whole of the answer; before-images are what M5
 * needs to render a diff a human can read, and they can come from the same snapshot then.
 *
 * `BINARY_CHECKSUM` per row, never an aggregate: `docs/DECISIONS.md` records that
 * `CHECKSUM_AGG` is XOR-based and cancels pairwise, so on a table where thousands of rows
 * share a value a small write vanishes entirely.
 */

/** The ambient values the procedure could read. Five of the fourteen branch on the clock. */
export interface AmbientContext {
  getdate: string;
  sysdatetime: string;
  sysutcdatetime: string;
  datefirst: number;
  language: string;
}

export interface RowImage {
  pk: Record<string, unknown>;
  /** I inserted · U updated · D deleted. */
  op: 'I' | 'U' | 'D';
  /** The row as it stood at the end of the call. Null for a delete — there is no after. */
  row: Record<string, unknown> | null;
}

/** table name → the rows it changed. Same shape M1's capture uses, minus before-images. */
export type WriteSet = Record<string, RowImage[]>;

export interface ExecutionOutcome {
  resultSets: unknown[][];
  writeSet: WriteSet;
  context: AmbientContext;
  /**
   * The server clock either side of the call, read through the same driver conversion the
   * row values go through. A timestamp landing inside this window was produced by the clock
   * during this run; one outside it was computed from data. That distinction is what lets
   * the canonicaliser normalise the clock without blanking out dates that carry behaviour.
   */
  clockWindow: { from: number; to: number };
  durationMs: number;
  /** Tables whose change list hit the cap, so a caller can say so rather than under-report. */
  truncatedTables: string[];
}

export interface ProcedureParameter {
  name: string;
  type: string;
  maxLength: number;
  precision: number;
  scale: number;
}

/**
 * A table changing more rows than this in one call means something is wrong with the case
 * selection, not that the write set is genuinely enormous. M1 uses the same bound.
 */
const MAX_ROWS_PER_TABLE = 200;

/** Whole-estate parameter surface is four types. Anything else is a change worth noticing. */
function mssqlType(p: ProcedureParameter): sql.ISqlType {
  switch (p.type) {
    case 'nvarchar':
      return p.maxLength === -1 ? sql.NVarChar(sql.MAX) : sql.NVarChar(p.maxLength / 2);
    case 'varchar':
      return p.maxLength === -1 ? sql.VarChar(sql.MAX) : sql.VarChar(p.maxLength);
    case 'int':
      return sql.Int();
    case 'bigint':
      return sql.BigInt();
    case 'bit':
      return sql.Bit();
    case 'decimal':
    case 'numeric':
      return sql.Decimal(p.precision, p.scale);
    case 'datetime2':
      return sql.DateTime2(p.scale);
    case 'uniqueidentifier':
      return sql.UniqueIdentifier();
    default:
      throw new Error(`no mapping for parameter type ${p.type} on ${p.name}`);
  }
}

export async function readParameters(pool: sql.ConnectionPool, procedureName: string): Promise<ProcedureParameter[]> {
  const result = await pool.request().input('proc', procedureName).query(`
    SELECT p.name AS name, t.name AS type, p.max_length AS maxLength,
           p.precision AS precision, p.scale AS scale
    FROM sys.parameters p
    JOIN sys.types t ON t.user_type_id = p.user_type_id
    WHERE p.object_id = OBJECT_ID('dbo.' + @proc)
    ORDER BY p.parameter_id`);
  return result.recordset as ProcedureParameter[];
}

/**
 * Primary keys straight from the engine, never a committed list of column names. Parity has
 * to stay pointable at an estate whose conventions it has never seen.
 */
export async function readPrimaryKeys(pool: sql.ConnectionPool): Promise<Map<string, string[]>> {
  const result = await pool.request().query(`
    SELECT t.name AS tableName, c.name AS columnName, ic.key_ordinal AS ordinal
    FROM sys.tables t
    JOIN sys.indexes i ON i.object_id = t.object_id AND i.is_primary_key = 1
    JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
    JOIN sys.columns c ON c.object_id = t.object_id AND c.column_id = ic.column_id
    WHERE SCHEMA_NAME(t.schema_id) = 'dbo'
    ORDER BY t.name, ic.key_ordinal`);

  const keys = new Map<string, string[]>();
  for (const row of result.recordset as { tableName: string; columnName: string }[]) {
    keys.set(row.tableName, [...(keys.get(row.tableName) ?? []), row.columnName]);
  }
  return keys;
}

/**
 * IDENTITY columns, from the engine.
 *
 * SQL Server does not give an identity value back on rollback — it is consumed. So two runs
 * of the same INSERT produce different keys against otherwise identical state, and the
 * canonicaliser has to know which columns those are. Guessing "the PK of an inserted row"
 * would over-normalise a table whose key is meaningful data.
 */
export async function readIdentityColumns(pool: sql.ConnectionPool): Promise<Map<string, Set<string>>> {
  const result = await pool.request().query(`
    SELECT t.name AS tableName, c.name AS columnName
    FROM sys.tables t
    JOIN sys.columns c ON c.object_id = t.object_id
    WHERE c.is_identity = 1 AND SCHEMA_NAME(t.schema_id) = 'dbo'`);

  const identity = new Map<string, Set<string>>();
  for (const row of result.recordset as { tableName: string; columnName: string }[]) {
    identity.set(row.tableName, (identity.get(row.tableName) ?? new Set()).add(row.columnName));
  }
  return identity;
}

export interface ExecutionRequest {
  procedureName: string;
  /** Straight off the captured `InputParams`. Keys may carry a leading `@` or not. */
  params: Record<string, unknown>;
  /** Tables this procedure is known to write, from M2's parse plus its EXEC closure. */
  writeTables: string[];
  parameters: ProcedureParameter[];
  primaryKeys: Map<string, string[]>;
}

const bracket = (identifier: string): string => `[${identifier.replace(/]/g, ']]')}]`;

/**
 * Bind captured input parameters onto a request, typed from the engine's own metadata.
 *
 * Exported because M5's shadow replay calls the same procedures with the same captured
 * parameters and must bind them identically. A second copy of the type mapping would drift,
 * and the first symptom would be a "behaviour change" that is really a `varchar` where the
 * other side sent an `nvarchar`.
 *
 * Keys may carry a leading `@` or not, because the capture records whichever the caller used.
 */
export function bindParameters(
  request: sql.Request,
  parameters: ProcedureParameter[],
  params: Record<string, unknown>,
): void {
  for (const parameter of parameters) {
    const bare = parameter.name.replace(/^@/, '');
    const value = params[bare] ?? params[parameter.name] ?? null;
    request.input(bare, mssqlType(parameter), value);
  }
}

/** Run it, watch it, throw the transaction away. */
export async function executeRolledBack(
  pool: sql.ConnectionPool,
  request: ExecutionRequest,
): Promise<ExecutionOutcome> {
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    return await watchWrites({
      newRequest: () => new sql.Request(transaction),
      writeTables: request.writeTables,
      primaryKeys: request.primaryKeys,
      invoke: async () => {
        const call = new sql.Request(transaction);
        bindParameters(call, request.parameters, request.params);
        const result = await call.execute(`dbo.${request.procedureName}`);
        return (result.recordsets ?? []) as unknown as unknown[][];
      },
    });
  } finally {
    // Always. Not on success, not unless something went wrong — always. The estate this runs
    // against is the one the demo depends on being identical between rehearsals.
    await transaction.rollback();
  }
}

export interface WatchRequest {
  /** Every statement must land on the SAME session — the fingerprints live in temp tables. */
  newRequest: () => sql.Request;
  writeTables: string[];
  primaryKeys: Map<string, string[]>;
  /** Whatever changes the database. A procedure call, or an HTTP request to a replacement. */
  invoke: () => Promise<unknown[][]>;
}

/**
 * Fingerprint the tables, do the thing, fingerprint again, and report what moved.
 *
 * Factored out of `executeRolledBack` at M6 so the golden suite can measure a **service** with
 * the same instrument it used to record the expectation. The alternative was a second copy of
 * the checksum logic for the HTTP path, and a second copy would drift — the first symptom
 * being a "behaviour change" that is really two different ways of asking what changed.
 * `docs/DECISIONS.md` records M5 learning that about `bindParameters`.
 *
 * Note there is no transaction here. Whether the work is thrown away is the caller's business:
 * the procedure runs inside one and rolls back, while a service commits over its own
 * connection and the shadow database is reverted afterwards. Both are observable this way,
 * which is the point.
 */
export async function watchWrites(request: WatchRequest): Promise<ExecutionOutcome> {
  const tables = request.writeTables.filter((t) => request.primaryKeys.has(t)).sort();

  {
    for (const [index, table] of tables.entries()) {
      const pk = request.primaryKeys.get(table)!;
      await request.newRequest().batch(`
        IF OBJECT_ID('tempdb..#before_${index}') IS NOT NULL DROP TABLE #before_${index};
        SELECT ${pk.map(bracket).join(', ')}, BINARY_CHECKSUM(*) AS __chk
        INTO #before_${index}
        FROM dbo.${bracket(table)};`);
    }

    // Taken before the call, so it is what the procedure is about to read rather than what
    // the clock had moved on to by the time the call returned.
    const context = (
      await request.newRequest().query(`
        SELECT CONVERT(varchar(33), GETDATE(), 126) AS getdate,
               CONVERT(varchar(33), SYSDATETIME(), 126) AS sysdatetime,
               CONVERT(varchar(33), SYSUTCDATETIME(), 126) AS sysutcdatetime,
               @@DATEFIRST AS datefirst, @@LANGUAGE AS language`)
    ).recordset[0] as AmbientContext;

    const serverNow = async (): Promise<number> =>
      ((await request.newRequest().query(`SELECT GETDATE() AS at`)).recordset[0].at as Date).getTime();

    const windowFrom = await serverNow();
    const started = Date.now();
    const resultSets = await request.invoke();
    const durationMs = Date.now() - started;
    const windowTo = await serverNow();

    const writeSet: WriteSet = {};
    const truncatedTables: string[] = [];

    for (const [index, table] of tables.entries()) {
      const pk = request.primaryKeys.get(table)!;
      const join = pk.map((c) => `a.${bracket(c)} = b.${bracket(c)}`).join(' AND ');
      const changes = request.newRequest();

      // Two full fingerprint passes and one keyed read. The alternative — checksumming the
      // base table inside the join — is not expressible: BINARY_CHECKSUM(*) cannot be
      // qualified by an alias.
      const rows = (
        await changes.batch(`
          IF OBJECT_ID('tempdb..#after_${index}') IS NOT NULL DROP TABLE #after_${index};
          SELECT ${pk.map(bracket).join(', ')}, BINARY_CHECKSUM(*) AS __chk
          INTO #after_${index}
          FROM dbo.${bracket(table)};

          SELECT TOP (${MAX_ROWS_PER_TABLE + 1})
                 CASE WHEN b.${bracket(pk[0])} IS NULL THEN 'I' ELSE 'U' END AS __op, t.*
          FROM #after_${index} a
          JOIN dbo.${bracket(table)} t ON ${pk.map((c) => `t.${bracket(c)} = a.${bracket(c)}`).join(' AND ')}
          LEFT JOIN #before_${index} b ON ${join}
          WHERE b.${bracket(pk[0])} IS NULL OR a.__chk <> b.__chk
          ORDER BY ${pk.map((c) => `a.${bracket(c)}`).join(', ')};

          SELECT 'D' AS __op, ${pk.map((c) => `b.${bracket(c)}`).join(', ')}
          FROM #before_${index} b
          LEFT JOIN #after_${index} a ON ${join}
          WHERE a.${bracket(pk[0])} IS NULL
          ORDER BY ${pk.map((c) => `b.${bracket(c)}`).join(', ')};`)
      ).recordsets as unknown as Record<string, unknown>[][];

      const changed = rows[0] ?? [];
      const deleted = rows[1] ?? [];
      if (changed.length > MAX_ROWS_PER_TABLE) truncatedTables.push(table);

      const images: RowImage[] = [
        ...changed.slice(0, MAX_ROWS_PER_TABLE).map((row) => {
          const { __op: op, ...rest } = row;
          return {
            pk: Object.fromEntries(pk.map((c) => [c, rest[c]])),
            op: op as 'I' | 'U',
            row: rest,
          };
        }),
        ...deleted.map((row) => ({
          pk: Object.fromEntries(pk.map((c) => [c, row[c]])),
          op: 'D' as const,
          row: null,
        })),
      ];

      if (images.length > 0) writeSet[table] = images;
    }

    return {
      resultSets,
      writeSet,
      context,
      clockWindow: { from: windowFrom, to: windowTo },
      durationMs,
      truncatedTables,
    };
  }
}
