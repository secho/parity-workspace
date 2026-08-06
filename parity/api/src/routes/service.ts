import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { procedures, pullRequests } from '../db/schema.js';
import { agentReadiness, prReadiness, type Config } from '../env.js';
import { assemblePr, commitPr } from '../pr/bundle.js';
import { generateService } from '../service/generate.js';
import { isComplete, latestArtifacts } from '../service/artifacts.js';

/**
 * What the Procedura → Služba and → PR tabs read, and the two buttons that write.
 *
 * The generated source is served from here rather than from a disk Parity shares with the
 * demo app: `make adopt-service` is an HTTP client of this route, which is what keeps
 * parity-api free of any mount into `parity-platform-demo-app`. See ../service/artifacts.ts.
 */
export async function serviceRoutes(app: FastifyInstance, db: Db, config: Config): Promise<void> {
  /** The generated service as stored: files, hashes, and whether it is complete enough to adopt. */
  app.get<{ Params: { name: string } }>('/api/procedures/:name/service', async (req, reply) => {
    const [procedure] = await db.select().from(procedures).where(eq(procedures.name, req.params.name));
    if (procedure === undefined) return reply.code(404).send({ error: 'no such procedure' });

    const artifacts = await latestArtifacts(db, procedure.id);
    return {
      procedure: procedure.name,
      artifacts,
      complete: isComplete(artifacts),
      agentReady: agentReadiness(),
    };
  });

  /**
   * Write the service.
   *
   * One live Opus run. `feedback` carries what the previous attempt got wrong — the failing
   * golden cases and the surviving shadow findings — so a second attempt is a correction
   * rather than a re-roll.
   */
  app.post<{ Params: { name: string }; Body: { feedback?: string } }>(
    '/api/procedures/:name/service',
    async (req, reply) => {
      const readiness = agentReadiness();
      if (!readiness.ready) return reply.code(503).send({ error: readiness.reason, reasonCode: readiness.reasonCode });

      const result = await generateService(db, config, {
        procedureName: req.params.name,
        feedback: req.body?.feedback ?? null,
      });
      if (result === null) return reply.code(404).send({ error: 'no such procedure' });
      return result;
    },
  );

  /** The PR as assembled, plus whether it could be opened at all. */
  app.get<{ Params: { name: string } }>('/api/procedures/:name/pr', async (req, reply) => {
    const [procedure] = await db.select().from(procedures).where(eq(procedures.name, req.params.name));
    if (procedure === undefined) return reply.code(404).send({ error: 'no such procedure' });

    const rows = await db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.procedureId, procedure.id))
      .orderBy(desc(pullRequests.id));

    // The readiness object is what the UI renders when there is no token. It says why there is
    // no URL, which is the only honest thing to put where a URL would go.
    return { pullRequests: rows, latest: rows[0] ?? null, readiness: prReadiness(config) };
  });

  /**
   * Assemble, and — only when asked in so many words — open.
   *
   * `commit: false` is the default and is what the gate uses. Opening a pull request on a
   * public repository is the one act in this platform that `make demo-reset` cannot take back,
   * so it is never a side effect of anything: the tier table refuses `open_pr` to every task
   * class, which means the thing that sets `commit: true` always has a person behind it.
   */
  app.post<{ Params: { name: string }; Body: { summaryCs?: string; fixCandidatesCs?: string; commit?: boolean } }>(
    '/api/procedures/:name/pr',
    async (req, reply) => {
      const assembled = await assemblePr(db, config, {
        procedureName: req.params.name,
        summaryCs: req.body?.summaryCs ?? '',
        fixCandidatesCs: req.body?.fixCandidatesCs ?? '',
      });
      if (assembled === null) {
        return reply.code(409).send({ error: 'nothing to open a PR for — no complete generated service' });
      }
      if (req.body?.commit !== true) return { pullRequest: assembled, opened: false, readiness: prReadiness(config) };

      const readiness = prReadiness(config);
      if (!readiness.ready) return reply.code(503).send({ error: readiness.reason, reasonCode: readiness.reasonCode });

      const opened = await commitPr(db, config, req.params.name);
      return { pullRequest: opened, opened: opened?.status === 'open', readiness };
    },
  );
}
