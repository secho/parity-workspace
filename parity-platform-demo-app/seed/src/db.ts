import sql from 'mssql';
import { readFile } from 'node:fs/promises';

export const config: sql.config = {
  server: process.env.MSSQL_HOST ?? 'localhost',
  port: Number(process.env.MSSQL_PORT ?? 1433),
  user: 'sa',
  password: process.env.MSSQL_SA_PASSWORD ?? 'ParityShop_Dev_2026!',
  options: {
    encrypt: true,
    trustServerCertificate: true,
    // Seeding inserts ~13k wide rows; the default 15s is not enough on a cold start.
    requestTimeout: 120_000,
  },
  pool: { max: 4, min: 0, idleTimeoutMillis: 30_000 },
};

export async function connect(database?: string): Promise<sql.ConnectionPool> {
  return new sql.ConnectionPool({ ...config, database }).connect();
}

/**
 * Run a .sql file. The mssql driver has no notion of GO — it is a sqlcmd batch
 * separator, not T-SQL — so split on it and run each batch in turn.
 */
export async function runSqlFile(pool: sql.ConnectionPool, path: string): Promise<void> {
  const text = await readFile(path, 'utf8');
  const batches = text
    .split(/^\s*GO\s*$/gim)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  for (const [i, batch] of batches.entries()) {
    try {
      await pool.request().batch(batch);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${path}: batch ${i + 1} failed: ${msg}\n--- batch ---\n${batch.slice(0, 400)}`);
    }
  }
}
