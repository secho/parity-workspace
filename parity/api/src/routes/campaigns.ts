import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { agentReadiness, type Config } from '../env.js';
import { CAMPAIGNS } from '../campaign/definitions.js';
import { campaignRun, latestRuns, startCampaign } from '../campaign/run.js';

/**
 * The Kampaně screen: three buttons, and a run to poll.
 *
 * `POST /api/campaigns/:key` returns **202 and a row**, not a result. The work continues in the
 * background — `Zmapovat estate` is twenty-eight model runs and Vite's dev proxy would kill the
 * request minutes before it finished. `GET /api/campaigns/:id` is what the screen polls.
 */
export async function campaignRoutes(app: FastifyInstance, db: Db, config: Config): Promise<void> {
  /** The three definitions, as the screen renders them. Code, served — never a table. */
  app.get('/api/campaigns', async () => ({
    campaigns: CAMPAIGNS.map((c) => ({
      key: c.key,
      title: c.title,
      description: c.description,
      needsTarget: c.needsTarget,
    })),
    runs: await latestRuns(db),
    agentReady: agentReadiness(),
  }));

  app.get<{ Params: { id: string } }>('/api/campaigns/runs/:id', async (req, reply) => {
    const run = await campaignRun(db, Number(req.params.id));
    if (run === null) return reply.code(404).send({ error: 'no such campaign run' });
    return { run };
  });

  app.post<{ Params: { key: string }; Body: { target?: string } }>('/api/campaigns/:key', async (req, reply) => {
    // Asked before the row is created rather than discovered by fourteen failing items. The
    // deletion campaign makes no model calls at all, so it is deliberately not gated on this.
    const outcome = await startCampaign(db, config, { campaign: req.params.key, target: req.body?.target ?? null });
    return reply.code(outcome.status).send(outcome.body);
  });
}
