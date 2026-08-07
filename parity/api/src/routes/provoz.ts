import { asc, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { llmEndpoint } from '../agent/client.js';
import { loadSkills } from '../agent/skills.js';
import type { Db } from '../db/client.js';
import { agentRuns, auditEntries, policyRules } from '../db/schema.js';
import { agentReadiness, type Config } from '../env.js';
import { activeMode } from '../replay/mode.js';

/**
 * Provoz — skills, policy tiers and the audit log on one page, per SCHEDULE's cut.
 * Thin but real: every row here is read from disk or from the database, and the page says
 * plainly when something is not wired yet rather than showing a plausible placeholder.
 */
export async function provozRoutes(app: FastifyInstance, db: Db, config: Config): Promise<void> {
  app.get('/api/skills', async () => {
    const skills = await loadSkills(config.skillsDir);
    return {
      skillsDir: config.skillsDir,
      skills: skills.map((s) => ({
        name: s.name,
        description: s.description,
        model: s.model,
        availableFrom: s.availableFrom,
      })),
    };
  });

  app.get('/api/policy', async () => {
    const rules = await db.select().from(policyRules).orderBy(asc(policyRules.taskClass), asc(policyRules.toolName));
    return { rules };
  });

  app.get<{ Querystring: { limit?: string } }>('/api/audit', async (request) => {
    const limit = Math.min(Number(request.query.limit ?? 200), 1000);
    const rows = await db
      .select({
        id: auditEntries.id,
        seq: auditEntries.seq,
        toolName: auditEntries.toolName,
        inputSummary: auditEntries.inputSummary,
        resultSummary: auditEntries.resultSummary,
        durationMs: auditEntries.durationMs,
        outcome: auditEntries.outcome,
        reason: auditEntries.reason,
        createdAt: auditEntries.createdAt,
        runId: agentRuns.runId,
        skill: agentRuns.skill,
        taskClass: agentRuns.taskClass,
      })
      .from(auditEntries)
      .innerJoin(agentRuns, eq(agentRuns.id, auditEntries.agentRunId))
      .orderBy(desc(auditEntries.createdAt))
      .limit(limit);
    return { entries: rows };
  });

  app.get('/api/runs', async () => {
    const runs = await db.select().from(agentRuns).orderBy(desc(agentRuns.startedAt)).limit(100);
    return { runs };
  });

  /**
   * What the top-right badge reads. The model reported is the one the SDK actually used on
   * the most recent run, not the one configured — a badge that shows configuration would
   * keep saying the right thing after the routing broke.
   */
  app.get('/api/runtime', async () => {
    const endpoint = llmEndpoint();
    const [latest] = await db
      .select({ model: agentRuns.model, provider: agentRuns.provider, startedAt: agentRuns.startedAt })
      .from(agentRuns)
      .where(eq(agentRuns.status, 'succeeded'))
      .orderBy(desc(agentRuns.startedAt))
      .limit(1);

    const readiness = agentReadiness();
    return {
      provider: endpoint.provider,
      baseUrl: endpoint.baseUrl,
      mode: activeMode(config),
      agentReady: readiness.ready,
      agentBlockedReason: readiness.reasonCode,
      lastModelUsed: latest?.model ?? null,
      lastRunAt: latest?.startedAt ?? null,
    };
  });
}
