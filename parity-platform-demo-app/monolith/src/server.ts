// ParityShop monolith. Deliberately unlayered: it invokes stored procedures and
// serves the result. The business logic lives in the database — that is the point,
// and it is what makes the estate worth refactoring.

import Fastify from 'fastify';
import healthRoutes from './routes/health.js';
import shopRoutes from './routes/shop.js';
import opsRoutes from './routes/ops.js';
import { closePool } from './db.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

await app.register(healthRoutes);
await app.register(shopRoutes);
await app.register(opsRoutes);

const port = Number(process.env.PORT ?? 3000);

try {
  await app.listen({ port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await closePool();
    process.exit(0);
  });
}
