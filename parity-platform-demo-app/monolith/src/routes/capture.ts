import type { FastifyInstance } from 'fastify';
import { flush, stats, samplerStats } from '../capture/index.js';

/**
 * Capture control surface. Not business logic — this is the traffic generator's and
 * verify-m1's handle on the buffered recorder, namespaced so it reads as infrastructure.
 */
export default async function captureRoutes(app: FastifyInstance): Promise<void> {
  // The recorder batches rows; the generator calls this once it has finished issuing
  // traffic so nothing is left sitting in the buffer when verify starts reading.
  app.post('/api/_capture/flush', async () => {
    const written = await flush();
    return { flushed: written, ...stats() };
  });

  app.get('/api/_capture/stats', async () => ({ ...stats(), sampler: samplerStats() }));
}
