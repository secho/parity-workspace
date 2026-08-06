import { asc, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { agentRuns, agentSteps, procedures, specs } from '../db/schema.js';
import { agentReadiness, type Config } from '../env.js';
import { executeRun, specRun, triageRun } from '../agent/runner.js';

/**
 * Agent runs, and their steps streaming to the UI.
 *
 * A run is started with POST and watched with SSE. The steps are persisted as they happen,
 * so the stream is a view onto the table rather than the only copy — reload the page
 * mid-run and nothing is lost.
 */

type Listener = (event: { seq: number; kind: string; toolName: string | null; text: string | null }) => void;

/** Live runs, so an SSE subscriber attaches to one already in flight. */
const listeners = new Map<string, Set<Listener>>();

export async function agentRoutes(app: FastifyInstance, db: Db, config: Config): Promise<void> {
  const start = async (
    procedureName: string,
    kind: 'triage' | 'spec',
  ): Promise<{ runId: string; status: number; body: unknown }> => {
    const readiness = agentReadiness();
    if (!readiness.ready) {
      // Fail loudly and immediately rather than fourteen procedures into a sweep.
      return { runId: '', status: 503, body: { error: 'agent not configured', reason: readiness.reason } };
    }

    const request = kind === 'triage' ? triageRun(procedureName) : specRun(procedureName);
    const handle = await executeRun(db, config, request, (step) => {
      for (const listener of listeners.get(procedureName) ?? []) listener(step);
    });

    return {
      runId: handle.runId,
      status: 200,
      body: {
        runId: handle.runId,
        model: handle.result.model,
        skillsLoaded: handle.result.skillsLoaded,
        turns: handle.result.numTurns,
        costUsd: handle.result.costUsd,
        blocked: handle.blocked,
        output: handle.result.text,
      },
    };
  };

  app.post<{ Params: { name: string } }>('/api/procedures/:name/triage', async (request, reply) => {
    const result = await start(request.params.name, 'triage');
    return reply.code(result.status).send(result.body);
  });

  app.post<{ Params: { name: string } }>('/api/procedures/:name/spec', async (request, reply) => {
    const result = await start(request.params.name, 'spec');
    return reply.code(result.status).send(result.body);
  });

  /** The specification, for the Procedura → Specifikace tab. */
  app.get<{ Params: { name: string } }>('/api/procedures/:name/spec', async (request, reply) => {
    const [procedure] = await db.select().from(procedures).where(eq(procedures.name, request.params.name));
    if (procedure === undefined) return reply.code(404).send({ error: 'procedure not found' });
    const [spec] = await db.select().from(specs).where(eq(specs.procedureId, procedure.id));
    return { spec: spec ?? null };
  });

  /** Agent runs for one procedure, newest first, with their steps. */
  app.get<{ Params: { name: string } }>('/api/procedures/:name/runs', async (request, reply) => {
    const [procedure] = await db.select().from(procedures).where(eq(procedures.name, request.params.name));
    if (procedure === undefined) return reply.code(404).send({ error: 'procedure not found' });

    const runs = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.procedureId, procedure.id))
      .orderBy(desc(agentRuns.startedAt));

    const withSteps = await Promise.all(
      runs.map(async (run) => ({
        ...run,
        steps: await db.select().from(agentSteps).where(eq(agentSteps.agentRunId, run.id)).orderBy(asc(agentSteps.seq)),
      })),
    );
    return { runs: withSteps };
  });

  /** Live agent steps for a procedure. */
  app.get<{ Params: { name: string } }>('/api/procedures/:name/stream', async (request, reply) => {
    const name = request.params.name;
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    reply.raw.write(': connected\n\n');

    const listener: Listener = (event) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    const set = listeners.get(name) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(name, set);

    const keepAlive = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15_000);
    request.raw.on('close', () => {
      clearInterval(keepAlive);
      set.delete(listener);
      if (set.size === 0) listeners.delete(name);
    });

    await new Promise(() => undefined);
  });
}
