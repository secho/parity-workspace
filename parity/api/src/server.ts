import Fastify from 'fastify';
import { openStore, waitForPostgres } from './db/client.js';
import { applyMigrations } from './db/migrate.js';
import { loadConfig } from './env.js';
import { estateRoutes } from './routes/estate.js';
import { healthRoutes } from './routes/health.js';
import { opsRoutes } from './routes/ops.js';

const config = loadConfig();
const store = openStore(config.pgUrl);
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

await waitForPostgres(store.pool);
await applyMigrations(store.db);

await healthRoutes(app, store.db);
await estateRoutes(app, store.db);
await opsRoutes(app, store.db, config);

await app.listen({ host: '0.0.0.0', port: config.port });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => store.close()).then(() => process.exit(0));
  });
}
