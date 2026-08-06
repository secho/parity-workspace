import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface Store {
  db: Db;
  pool: pg.Pool;
  close: () => Promise<void>;
}

export function openStore(pgUrl: string): Store {
  const pool = new pg.Pool({ connectionString: pgUrl, max: 10 });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

/** Postgres is in its own container and may still be starting when the API boots. */
export async function waitForPostgres(pool: pg.Pool, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}
