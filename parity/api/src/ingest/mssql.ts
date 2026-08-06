import sql from 'mssql';
import type { Config } from '../env.js';

/**
 * Parity's only route into the estate. Parity never imports the demo app's code — that
 * separation is the whole argument, because it has to look like something that could be
 * pointed at Alza's real estate tomorrow.
 *
 * Two principals, and the difference between them is the point. `connect` is the analysis
 * connection: db_datareader plus VIEW DEFINITION, and every query in this file uses it.
 * `connectRunner` is the one exception in the codebase — the oracle harness, which has to
 * execute a procedure to find out what it does. Nothing here writes under either.
 */

export interface EstateProcedure {
  name: string;
  schemaName: string;
  definition: string;
}

export interface InvocationStat {
  procName: string;
  invocations: number;
  lastInvokedAt: Date | null;
}

export interface CatalogRow {
  tableName: string;
  columnName: string;
}

/**
 * `verify-m1` issues probe calls of its own, tagged `verify:%`. Counting them would mean
 * running an acceptance gate moves the numbers on the Estate screen — exactly the drift
 * hard rule 5 exists to prevent. The same filter the M1 gate applies to itself.
 */
const NOT_VERIFY = "(CallerContext IS NULL OR CallerContext NOT LIKE 'verify:%')";

const pool = (config: Config, user: string, password: string): Promise<sql.ConnectionPool> =>
  new sql.ConnectionPool({
    server: config.mssql.server,
    port: config.mssql.port,
    database: config.mssql.database,
    user,
    password,
    options: { encrypt: true, trustServerCertificate: true, requestTimeout: 120_000 },
  }).connect();

/** The analysis connection. Cannot write, and the engine is what refuses it. */
export async function connect(config: Config): Promise<sql.ConnectionPool> {
  return pool(config, config.mssql.user, config.mssql.password);
}

/**
 * The execution connection, for the oracle harness only.
 *
 * May EXECUTE and may write; every caller wraps the call in a transaction it always rolls
 * back. Two things it still cannot do, and both are grants rather than conventions: it has
 * no DDL, so it cannot alter the estate it is verifying; and it is DENYed
 * `sp_SyncWarehouseDispatch`, because that procedure sends mail and a sent mail cannot be
 * rolled back. See `parity-platform-demo-app/db/41-parity-runner.sql`.
 */
export async function connectRunner(config: Config): Promise<sql.ConnectionPool> {
  return pool(config, config.mssql.runnerUser, config.mssql.runnerPassword);
}

export async function readProcedures(pool: sql.ConnectionPool): Promise<EstateProcedure[]> {
  const result = await pool.request().query(`
    SELECT s.name AS schemaName, o.name AS name, m.definition AS definition
    FROM sys.sql_modules m
    JOIN sys.objects o ON o.object_id = m.object_id
    JOIN sys.schemas s ON s.schema_id = o.schema_id
    WHERE o.type = 'P'
    ORDER BY o.name`);
  return result.recordset as EstateProcedure[];
}

export async function readInvocationStats(pool: sql.ConnectionPool): Promise<InvocationStat[]> {
  const result = await pool.request().query(`
    SELECT ProcName AS procName, COUNT(*) AS invocations, MAX(CalledAt) AS lastInvokedAt
    FROM parity_capture.Invocation
    WHERE ${NOT_VERIFY}
    GROUP BY ProcName`);
  return result.recordset as InvocationStat[];
}

/** Real table and column names. The parser resolves every identifier against these, so it
 *  can never invent a table and temp tables need no special case. */
export async function readCatalog(pool: sql.ConnectionPool): Promise<CatalogRow[]> {
  const result = await pool.request().query(`
    SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'dbo'
    ORDER BY TABLE_NAME, ORDINAL_POSITION`);
  return result.recordset as CatalogRow[];
}
