import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import type { Config } from '../env.js';
import { ingest, resetState } from '../ingest/run.js';

/** Operational endpoints. `make ingest` and `make demo-reset` go through the CLI rather
 *  than these, but the UI needs a way to re-read the estate without a shell. */
export async function opsRoutes(app: FastifyInstance, db: Db, config: Config): Promise<void> {
  app.post('/api/_ops/ingest', async () => ingest(db, config));

  app.post('/api/_ops/reset', async () => {
    await resetState(db);
    return ingest(db, config);
  });
}
