import sql from 'mssql';

let pool: sql.ConnectionPool | null = null;

const config: sql.config = {
  server: process.env.MSSQL_HOST ?? 'localhost',
  port: Number(process.env.MSSQL_PORT ?? 1433),
  database: process.env.MSSQL_DATABASE ?? 'ParityShop',
  user: 'sa',
  password: process.env.MSSQL_SA_PASSWORD ?? 'ParityShop_Dev_2026!',
  options: { encrypt: true, trustServerCertificate: true, requestTimeout: 60_000 },
  pool: { max: 20, min: 2, idleTimeoutMillis: 30_000 },
};

export async function getPool(): Promise<sql.ConnectionPool> {
  if (pool?.connected) return pool;
  pool = await new sql.ConnectionPool(config).connect();
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.close();
  pool = null;
}

export { sql };
