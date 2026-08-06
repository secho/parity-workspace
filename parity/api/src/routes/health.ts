import { sql as raw } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { procedures } from '../db/schema.js';

export async function healthRoutes(app: FastifyInstance, db: Db): Promise<void> {
  app.get('/health', async (_request, reply) => {
    try {
      const [row] = await db.select({ n: raw<number>`count(*)::int` }).from(procedures);
      return { status: 'ok', procedures: row?.n ?? 0 };
    } catch (err) {
      return reply.code(503).send({ status: 'degraded', error: err instanceof Error ? err.message : String(err) });
    }
  });
}
