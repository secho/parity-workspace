import type { FastifyInstance } from 'fastify';
import { flush, stats, samplerStats, resetSampler, resetWriteSetCache } from '../capture/index.js';

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

  /**
   * Reset the sampler's counters and the cached column metadata.
   *
   * Both live in memory and both outlive `make seed`, which drops and recreates the
   * database. Without this, a second traffic run against a freshly seeded database
   * inherits the first run's call counts and its set of already-seen branches — so it
   * samples differently, and two consecutive `seed && traffic` runs stop producing
   * identical numbers. The traffic generator calls this before it issues anything.
   * Column ids are not stable across a reseed either, hence the metadata cache goes too.
   */
  app.post('/api/_capture/reset', async () => {
    await flush();
    resetSampler();
    resetWriteSetCache();
    return { reset: true };
  });
}
