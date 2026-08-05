import Fastify from 'fastify';
import { seedPolicy } from './agent/policy.js';
import { openStore, waitForPostgres } from './db/client.js';
import { applyMigrations } from './db/migrate.js';
import { agentReadiness, loadConfig } from './env.js';
import { agentRoutes } from './routes/agent.js';
import { estateRoutes } from './routes/estate.js';
import { healthRoutes } from './routes/health.js';
import { opsRoutes } from './routes/ops.js';
import { provozRoutes } from './routes/provoz.js';

const config = loadConfig();
const store = openStore(config.pgUrl);
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

await waitForPostgres(store.pool);
await applyMigrations(store.db);
// The tier table is configuration, not user data: it is reasserted on every boot so the
// policy the hook enforces is the policy in the repository.
await seedPolicy(store.db);

await healthRoutes(app, store.db);
await estateRoutes(app, store.db);
await opsRoutes(app, store.db, config);
await agentRoutes(app, store.db, config);
await provozRoutes(app, store.db, config);

const readiness = agentReadiness();
if (!readiness.ready) app.log.warn(`agent runs are unavailable: ${readiness.reason}`);

await app.listen({ host: '0.0.0.0', port: config.port });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => store.close()).then(() => process.exit(0));
  });
}
