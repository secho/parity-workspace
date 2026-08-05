import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { procedures, specs } from '../db/schema.js';
import type { Config } from '../env.js';
import { connect } from '../ingest/mssql.js';

/**
 * Parity's own tools, in-process — no external MCP servers to run.
 *
 * These are the ONLY route to knowledge about a procedure. The agent has no Bash, no Glob,
 * no Grep and no web access, and `docs/` is not mounted into this container, so it cannot
 * reach the answer key that says which procedures are dead and where the planted bug is.
 * If it could, triage would be theatre and one question in the room would expose it.
 */

export interface ToolContext {
  db: Db;
  config: Config;
  /** Set per run so write tools land against the right procedure. */
  procedureName: string | null;
  agentRunId: number | null;
}

const text = (value: string): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text: value }],
});

export function parityTools(context: ToolContext) {
  const readProcedure = tool(
    'read_procedure',
    'Read the T-SQL source of one stored procedure in the estate, with its line count and how often it was called in the last 90 days.',
    { name: z.string().describe('Procedure name, e.g. sp_CalculateOrderTotal') },
    async ({ name }) => {
      const [row] = await context.db.select().from(procedures).where(eq(procedures.name, name));
      if (row === undefined) return text(`No procedure named ${name} in the estate.`);
      return text(
        [
          `# ${row.name}`,
          `lines: ${row.lineCount}`,
          `invocations over 90 days: ${row.invocations90d}`,
          `last invoked: ${row.lastInvokedAt?.toISOString() ?? 'never'}`,
          row.usesDynamicSql ? 'note: this procedure builds SQL as a string at runtime' : '',
          '',
          '```sql',
          row.sourceSql,
          '```',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  const queryCapture = tool(
    'query_capture',
    'Summary statistics and sampled invocations for a procedure from the captured production traffic: call counts, distinct branches, recorded inputs, result sets and write sets.',
    {
      name: z.string().describe('Procedure name'),
      samples: z.number().int().min(0).max(5).default(2).describe('How many sampled invocations to include in full'),
    },
    async ({ name, samples }) => {
      const pool = await connect(context.config);
      try {
        const stats = (
          await pool
            .request()
            .input('proc', name).query(`
              SELECT COUNT(*) AS calls,
                     SUM(CASE WHEN Sampled = 1 THEN 1 ELSE 0 END) AS sampled,
                     COUNT(DISTINCT BranchKey) AS branches,
                     MIN(CalledAt) AS firstAt, MAX(CalledAt) AS lastAt,
                     AVG(CAST(DurationMs AS FLOAT)) AS avgMs
              FROM parity_capture.Invocation
              WHERE ProcName = @proc
                AND (CallerContext IS NULL OR CallerContext NOT LIKE 'verify:%')`)
        ).recordset[0] as Record<string, unknown>;

        const branchRows = (
          await pool.request().input('proc', name).query(`
            SELECT TOP 20 BranchKey, COUNT(*) AS n FROM parity_capture.Invocation
            WHERE ProcName = @proc AND BranchKey IS NOT NULL
            GROUP BY BranchKey ORDER BY COUNT(*) DESC`)
        ).recordset as { BranchKey: string; n: number }[];

        const sampleRows =
          samples === 0
            ? []
            : ((
                await pool.request().input('proc', name).input('n', samples).query(`
                  SELECT TOP (@n) InputParams, ResultSet, WriteSet, Context, DurationMs
                  FROM parity_capture.Invocation
                  WHERE ProcName = @proc AND Sampled = 1
                  ORDER BY InvocationID DESC`)
              ).recordset as Record<string, unknown>[]);

        return text(
          [
            `# captured traffic for ${name}`,
            `calls: ${stats.calls}  sampled: ${stats.sampled}  distinct branches: ${stats.branches}`,
            `window: ${String(stats.firstAt ?? '—')} .. ${String(stats.lastAt ?? '—')}`,
            `average duration: ${stats.avgMs === null ? '—' : Number(stats.avgMs).toFixed(1)} ms`,
            '',
            '## branch mix',
            ...branchRows.map((r) => `- ${r.BranchKey}: ${r.n}`),
            '',
            '## sampled invocations',
            // The ambient values matter: several procedures branch on the clock, so an
            // invocation's inputs alone do not determine its behaviour.
            JSON.stringify(sampleRows, null, 2),
          ].join('\n'),
        );
      } finally {
        await pool.close();
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const writeTriage = tool(
    'write_triage',
    'Record the triage result for the procedure under analysis: its oracle class, risk class, and — if nondeterministic — exactly what would have to be injected to make it replayable.',
    {
      oracle_class: z.enum(['pure_read', 'det_write', 'nondet', 'external', 'none']),
      risk_class: z.enum(['money', 'regulatory', 'none']),
      seam_requirements: z
        .string()
        .describe('If nondet or external, name the constructs and what would have to be injected. Otherwise an empty string.'),
      reasoning: z.string().describe('One or two sentences, in Czech, on why this class and not the neighbouring one.'),
    },
    async ({ oracle_class, risk_class, seam_requirements, reasoning }) => {
      if (context.procedureName === null) return text('No procedure is under analysis in this run.');
      await context.db
        .update(procedures)
        .set({
          oracleClass: oracle_class,
          riskClass: risk_class,
          seamRequirements: seam_requirements === '' ? null : seam_requirements,
          campaignStatus: 'specced',
        })
        .where(eq(procedures.name, context.procedureName));
      return text(`Recorded ${context.procedureName}: ${oracle_class} / ${risk_class}. ${reasoning}`);
    },
  );

  const writeSpec = tool(
    'write_spec',
    'Store the finished Czech specification for the procedure under analysis.',
    { markdown: z.string().describe('The complete specification in Markdown, in Czech, following the required section structure.') },
    async ({ markdown }) => {
      if (context.procedureName === null) return text('No procedure is under analysis in this run.');
      const [row] = await context.db.select().from(procedures).where(eq(procedures.name, context.procedureName));
      if (row === undefined) return text(`No procedure named ${context.procedureName}.`);

      await context.db
        .insert(specs)
        .values({ procedureId: row.id, markdown, agentRunId: context.agentRunId })
        .onConflictDoUpdate({
          target: specs.procedureId,
          set: { markdown, agentRunId: context.agentRunId, createdAt: new Date() },
        });
      return text(`Stored specification for ${context.procedureName} (${markdown.length} characters).`);
    },
  );

  return createSdkMcpServer({
    name: 'parity',
    version: '1.0.0',
    instructions:
      'Tools for reading the stored-procedure estate and recording findings about it. These are the only route to information about a procedure — there is no shell and no file access outside your working directory.',
    tools: [readProcedure, queryCapture, writeTriage, writeSpec],
  });
}

/** Fully-qualified names, which is how allowedTools and the policy table refer to them. */
export const TOOL = {
  readProcedure: 'mcp__parity__read_procedure',
  queryCapture: 'mcp__parity__query_capture',
  writeTriage: 'mcp__parity__write_triage',
  writeSpec: 'mcp__parity__write_spec',
} as const;
