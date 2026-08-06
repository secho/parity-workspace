import sql from 'mssql';

/**
 * The database this service prices against.
 *
 * `PRICING_DB` is the whole point of the indirection: in a shadow run it names the restored
 * copy, never the estate. The credential is `parity_runner` — the same principal the oracle
 * harness executes under, with no DDL and a DENY on the procedure that sends mail.
 */
const config: sql.config = {
  server: process.env.MSSQL_HOST ?? 'mssql',
  port: Number(process.env.MSSQL_PORT ?? 1433),
  database: process.env.PRICING_DB ?? 'ParityShop_Shadow',
  user: process.env.PRICING_DB_USER ?? 'parity_runner',
  password: process.env.PRICING_DB_PASSWORD ?? 'Parity_Runner_2026!',
  options: { encrypt: true, trustServerCertificate: true, requestTimeout: 60_000 },
  pool: { max: 4, min: 0, idleTimeoutMillis: 30_000 },
};

let pool: sql.ConnectionPool | null = null;

export async function getPool(): Promise<sql.ConnectionPool> {
  if (pool === null) pool = await new sql.ConnectionPool(config).connect();
  return pool;
}

/**
 * Drop the pool.
 *
 * The shadow harness resets the database between passes with a RESTORE, and RESTORE needs
 * exclusive access — a pooled connection sitting idle does not fail the restore, it *blocks*
 * it. So the harness asks this service to let go first. A service that quietly held one
 * connection open would turn a 530 ms reset into an unbounded wait, and the symptom would be
 * a shadow run that simply never finishes.
 */
export async function disconnect(): Promise<void> {
  const current = pool;
  pool = null;
  await current?.close();
}

export const databaseName = (): string => config.database ?? '';
