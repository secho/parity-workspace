import type { FastifyInstance } from 'fastify';
import { getPool } from '../db.js';

export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_req, reply) => {
    try {
      const pool = await getPool();
      await pool.request().query('SELECT 1 AS ok');
      return { status: 'ok', database: 'ParityShop' };
    } catch (err) {
      return reply.code(503).send({ status: 'degraded', error: err instanceof Error ? err.message : String(err) });
    }
  });
}
