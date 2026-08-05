// ParityShop monolith. Deliberately unlayered: it invokes stored procedures and
// serves the result. The business logic lives in the database — that is the point,
// and it is what makes the estate worth refactoring.

import Fastify from 'fastify';
import healthRoutes from './routes/health.js';
import shopRoutes from './routes/shop.js';
import opsRoutes from './routes/ops.js';
import captureRoutes from './routes/capture.js';
import { runWithContext, flush } from './capture/index.js';
import { closePool } from './db.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

// Carry the caller's context to the capture wrapper without threading an extra argument
// through all eleven procedure wrappers. The traffic generator sets the simulated clock
// and a session id; the shop sets neither and capture falls back to the real clock.
app.addHook('onRequest', (req, _reply, done) => {
  const simulated = req.headers['x-parity-simulated-at'];
  const parsed = typeof simulated === 'string' ? new Date(simulated) : undefined;
  runWithContext(
    {
      simulatedAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined,
      sessionId: typeof req.headers['x-parity-session'] === 'string' ? req.headers['x-parity-session'] : undefined,
      caller: typeof req.headers['x-parity-caller'] === 'string' ? req.headers['x-parity-caller'] : `${req.method} ${req.url}`,
    },
    done,
  );
});

await app.register(healthRoutes);
await app.register(shopRoutes);
await app.register(opsRoutes);
await app.register(captureRoutes);

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
    await flush(); // never lose buffered capture rows on shutdown
    await closePool();
    process.exit(0);
  });
}
