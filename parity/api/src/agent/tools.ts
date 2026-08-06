import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { and, eq, isNull, ne, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { goldenTests, invariants, procedures, specs } from '../db/schema.js';
import type { Config } from '../env.js';
import { connect, readCatalog } from '../ingest/mssql.js';
import { invariantSpec, unknownIdentifiers, type InvariantSpec } from '../oracle/invariants.js';

/**
 * Parity's own tools, in-process — no external MCP servers to run.
 *
 * These are the ONLY route to knowledge about a procedure. The agent has no Bash, no Glob,
 * no Grep and no web access, and `docs/` is not mounted into this container, so it cannot
 * reach the answer key that says which procedures are dead and where the planted bug is.
 * If it could, triage would be theatre and one question in the room would expose it.
 */

/** One captured invocation, as a golden case reads it. */
interface CapturedCase {
  InvocationID: number;
  BranchKey: string | null;
  InputParams: string;
  Context: string | null;
}

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

/**
 * Rows for this procedure that an *earlier* run produced.
 *
 * The write tools replace across runs and accumulate within one. Anything else is wrong in one
 * direction or the other: replacing per call throws away every batch but the last, and never
 * replacing leaves a re-run showing its predecessor's work alongside its own.
 */
function supersededBy(
  table: typeof goldenTests | typeof invariants,
  procedureId: number,
  agentRunId: number | null,
): SQL | undefined {
  if (agentRunId === null) return eq(table.procedureId, procedureId);
  return and(eq(table.procedureId, procedureId), or(isNull(table.agentRunId), ne(table.agentRunId, agentRunId)));
}

/**
 * A coarse shape of what one captured call actually did — what it wrote if it writes, and
 * what it returned if it does not.
 *
 * Coarse on purpose. Exact values differ on every call and would make every invocation its own
 * stratum; the sign-and-shape pattern is what separates "a promo was applied and a loyalty
 * discount was not" from "both were", or "in stock" from "backordered" — distinctions the
 * input-derived branch key cannot see, because both procedures resolve them inside the body.
 */
function outcomeSignature(writeSet: string | null, resultSet: string | null): string {
  const parts = new Set<string>();

  if (writeSet !== null && writeSet !== '') {
    try {
      const parsed = JSON.parse(writeSet) as Record<string, { columns?: { column: string; after: unknown }[] }[]>;
      for (const [table, images] of Object.entries(parsed)) {
        for (const image of images ?? []) {
          for (const change of image.columns ?? []) {
            const value = typeof change.after === 'string' ? Number(change.after) : change.after;
            if (typeof value !== 'number' || Number.isNaN(value)) continue;
            parts.add(`${table}.${change.column}:${value === 0 ? '0' : value > 0 ? '+' : '-'}`);
          }
        }
      }
    } catch {
      /* a malformed capture is not a reason to abandon stratification */
    }
  }

  // A read writes nothing, so a write-derived signature is empty for every call and the whole
  // procedure collapses into one stratum. `sp_GetProductAvailability` is the estate's hottest
  // procedure — 43% of all traffic, one observed branch key — and it drew exactly one candidate
  // case. Claiming a procedure is covered on the strength of a single replayed call is the
  // overclaiming the skill exists to forbid, so for reads the result set supplies the shape.
  if (parts.size === 0 && resultSet !== null && resultSet !== '') {
    try {
      const parsed = JSON.parse(resultSet) as unknown[][];
      parsed.forEach((rows, index) => {
        // Bucketed, not exact: row counts vary continuously and would make every call unique.
        const n = Array.isArray(rows) ? rows.length : 0;
        parts.add(`rs${index}:${n === 0 ? 'empty' : n === 1 ? 'one' : n < 10 ? 'few' : 'many'}`);
        const first = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
        for (const [column, value] of Object.entries(first ?? {})) {
          const numeric = typeof value === 'string' ? Number(value) : value;
          if (typeof numeric === 'number' && !Number.isNaN(numeric)) {
            parts.add(`rs${index}.${column}:${numeric === 0 ? '0' : numeric > 0 ? '+' : '-'}`);
          } else if (typeof value === 'boolean') {
            parts.add(`rs${index}.${column}:${value ? 'T' : 'F'}`);
          } else if (value === null) {
            parts.add(`rs${index}.${column}:null`);
          }
        }
      });
    } catch {
      /* same */
    }
  }

  return [...parts].sort().join(' ');
}

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

  /**
   * The stratified candidate set a golden suite is chosen from.
   *
   * `query_capture` cannot answer "one invocation per observed branch" — it returns the five
   * newest sampled rows and never returns an id, so a case could not cite where it came from.
   * Selection happens here, in code, and is deterministic: the lowest sampled InvocationID
   * per stratum. The agent's judgement is which of these earn a place and why, not which rows
   * exist — that keeps the estate's numbers identical between runs, per hard rule 5.
   *
   * **The stratum is the branch key AND the shape of what the call wrote.** The branch key
   * alone is a proxy built from inputs, and it is too coarse here in a way that matters:
   * every `sp_CalculateOrderTotal` call carrying VERNY20 shares one key, whether or not the
   * customer also had a loyalty discount — and the estate's planted defect lives precisely in
   * the intersection of the two. Keyed on inputs alone the lowest id is a call that never
   * enters that branch, so the defect is unreachable by construction and the oracle reports
   * full branch coverage while missing the one thing worth finding.
   *
   * M1 already learned this once: `docs/DECISIONS.md` records the branch key being widened
   * after it emerged that two procedures resolve country and loyalty tier *inside* the body,
   * so calls with identical parameters take different paths. The outcome signature closes the
   * remaining half — it is derived from the captured write set, so it distinguishes calls by
   * what they did rather than by what they were asked to do.
   */
  const listCaptureCases = tool(
    'list_capture_cases',
    'Candidate golden test cases for a procedure: real captured invocations, stratified by observed branch and by the shape of what each call wrote, with ids and the exact recorded inputs.',
    { name: z.string().describe('Procedure name') },
    async ({ name }) => {
      const pool = await connect(context.config);
      try {
        const rows = (
          await pool.request().input('proc', name).query(`
            SELECT TOP 3000 InvocationID, BranchKey, InputParams, CallerContext, WriteSet, ResultSet
            FROM parity_capture.Invocation
            WHERE ProcName = @proc AND Sampled = 1
              AND (CallerContext IS NULL OR CallerContext NOT LIKE 'verify:%')
            ORDER BY InvocationID`)
        ).recordset as {
          InvocationID: number;
          BranchKey: string | null;
          InputParams: string;
          CallerContext: string | null;
          WriteSet: string | null;
          ResultSet: string | null;
        }[];

        if (rows.length === 0) return text(`No sampled invocations for ${name}. It has no captured traffic to draw on.`);

        const strata = new Map<
          string,
          { id: number; branch: string; caller: string | null; inputs: string; outcome: string; n: number }
        >();

        for (const row of rows) {
          const outcome = outcomeSignature(row.WriteSet, row.ResultSet);
          const key = `${row.BranchKey ?? '-'}|${outcome}`;
          const existing = strata.get(key);
          if (existing === undefined) {
            strata.set(key, {
              id: Number(row.InvocationID),
              branch: row.BranchKey ?? '-',
              caller: row.CallerContext,
              inputs: row.InputParams,
              outcome,
              n: 1,
            });
          } else {
            existing.n += 1;
            // Keep the lowest id, and prefer one carrying a rare-branch tag: those are the
            // deliberately unusual calls, and they are what long-tail coverage is made of.
            if (existing.caller === null && row.CallerContext !== null) {
              existing.id = Number(row.InvocationID);
              existing.caller = row.CallerContext;
              existing.inputs = row.InputParams;
            }
          }
        }

        const candidates = [...strata.values()].sort((a, b) => (b.n !== a.n ? b.n - a.n : a.id - b.id)).slice(0, 40);

        return text(
          [
            `# candidate cases for ${name}`,
            `${rows.length} sampled invocations fall into ${strata.size} distinct strata; ${candidates.length} shown.`,
            'A stratum is one observed branch combined with the shape of what the call wrote,',
            'so two calls with the same parameters that took different paths appear separately.',
            'Cite these invocation ids in write_golden_tests. Do not invent inputs.',
            '',
            ...candidates.map(
              (c) =>
                `- invocation ${c.id} · branch \`${c.branch}\` · ${c.n} calls` +
                `${c.caller === null ? '' : ` · tagged ${c.caller}`}\n` +
                `  wrote: ${c.outcome || '(nothing)'}\n` +
                `  inputs: ${c.inputs}`,
            ),
          ].join('\n'),
        );
      } finally {
        await pool.close();
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  /**
   * Cases are stored by reference, never by value. The agent supplies an invocation id and a
   * reason; the inputs are read out of the capture table here. There is deliberately no way
   * for it to hand over a parameter object of its own — "generated from real traffic" has to
   * be a property of the mechanism, and `verify-m4` re-reads every id to prove it.
   */
  const writeGoldenTests = tool(
    'write_golden_tests',
    'Record the chosen golden test cases for the procedure under analysis. Each one cites a captured invocation by id; its inputs are taken from the capture, not from you.',
    {
      cases: z
        .array(
          z.object({
            invocation_id: z.number().int().describe('An id from list_capture_cases'),
            name: z.string().describe('Short stable identifier, e.g. stacked-promo-loyal'),
            covers: z.string().describe('Which behaviour or branch this case is here to pin down'),
          }),
        )
        .min(1),
    },
    async ({ cases }) => {
      if (context.procedureName === null) return text('No procedure is under analysis in this run.');
      const [procedure] = await context.db.select().from(procedures).where(eq(procedures.name, context.procedureName));
      if (procedure === undefined) return text(`No procedure named ${context.procedureName}.`);

      const pool = await connect(context.config);
      try {
        const ids = cases.map((c) => c.invocation_id);
        const rows = (
          await pool.request().input('proc', context.procedureName).query(`
            SELECT InvocationID, BranchKey, InputParams, Context
            FROM parity_capture.Invocation
            WHERE ProcName = @proc AND Sampled = 1 AND InvocationID IN (${ids.map((n) => Number(n)).join(',') || 'NULL'})`)
        ).recordset as CapturedCase[];

        const captured = new Map(rows.map((r) => [Number(r.InvocationID), r]));
        const missing = ids.filter((id) => !captured.has(id));
        if (missing.length > 0) {
          return text(
            `These ids are not sampled invocations of ${context.procedureName}: ${missing.join(', ')}. Use list_capture_cases.`,
          );
        }

        // Deliberately-rare traffic is always included, whether or not the agent picked it.
        //
        // The long tail is the whole reason branch coverage is hard: those calls are a handful
        // out of tens of thousands, and a suite assembled by judgement drops them silently and
        // still looks complete. Measured, not theorised — one run chose the VERNY20 stratum
        // that carries the estate's promo/VAT defect and the next chose a different ten cases
        // and missed it, so the same oracle reported the defect on Monday and a clean board on
        // Tuesday. Hard rule 5 does not tolerate that, and neither would anyone in the room.
        //
        // The agent still decides the shape of the suite. The platform guarantees the floor:
        // one case per rare-branch stratum, deterministically the lowest sampled id.
        // One per rare *stratum*, not per tag. `MIN(InvocationID)` grouped by CallerContext
        // alone picks invocation 43757 for `traffic:stacked-promo` — a VERNY20 order whose
        // customer had no loyalty discount, so it never enters the stacking branch at all. The
        // defect needs both conditions, and only the outcome signature separates them. Getting
        // this wrong would have guaranteed a case that guarantees nothing.
        const rareRows = (
          await pool.request().input('proc', context.procedureName).query(`
            SELECT InvocationID, CallerContext, WriteSet, ResultSet
            FROM parity_capture.Invocation
            WHERE ProcName = @proc AND Sampled = 1 AND CallerContext LIKE 'traffic:%'
            ORDER BY InvocationID`)
        ).recordset as { InvocationID: number; CallerContext: string; WriteSet: string | null; ResultSet: string | null }[];

        const rareStrata = new Map<string, { CallerContext: string; InvocationID: number }>();
        for (const row of rareRows) {
          const key = `${row.CallerContext}|${outcomeSignature(row.WriteSet, row.ResultSet)}`;
          if (!rareStrata.has(key)) {
            rareStrata.set(key, { CallerContext: row.CallerContext, InvocationID: Number(row.InvocationID) });
          }
        }
        const required = [...rareStrata.values()];

        const missingRare = required.filter((r) => !ids.includes(Number(r.InvocationID)));
        if (missingRare.length > 0) {
          const extra = (
            await pool.request().input('proc', context.procedureName).query(`
              SELECT InvocationID, BranchKey, InputParams, Context
              FROM parity_capture.Invocation
              WHERE ProcName = @proc AND InvocationID IN (${missingRare.map((m) => Number(m.InvocationID)).join(',')})`)
          ).recordset as CapturedCase[];
          for (const row of extra) captured.set(Number(row.InvocationID), row);
        }

        const withRequired = [
          ...cases,
          ...missingRare.map((m) => ({
            invocation_id: Number(m.InvocationID),
            name: `rare-${m.CallerContext.replace(/^traffic:/, '')}-${Number(m.InvocationID)}`,
            covers: `Rare branch ${m.CallerContext}, added by the platform: deliberately unusual traffic that a sampled suite would otherwise drop.`,
          })),
        ];

        // Clear what *earlier runs* left, and only that. A second run of the skill should
        // replace the suite, but a second call within one run must accumulate: the agent
        // batches, and wholesale replacement silently discarded everything but the last batch.
        await context.db.delete(goldenTests).where(supersededBy(goldenTests, procedure.id, context.agentRunId));

        for (const item of withRequired) {
          const row = captured.get(item.invocation_id)!;
          await context.db
            .insert(goldenTests)
            .values({
              procedureId: procedure.id,
              name: item.name,
              branchKey: row.BranchKey,
              sourceInvocationId: item.invocation_id,
              inputParams: JSON.parse(row.InputParams) as unknown,
              capturedContext: row.Context === null ? null : (JSON.parse(row.Context) as unknown),
              // Filled by the baseline pass, which runs the procedure and records what it did.
              expectedResult: [],
              expectedWriteSet: {},
              normalisations: [],
              rationale: item.covers,
              agentRunId: context.agentRunId,
            })
            .onConflictDoUpdate({
              target: [goldenTests.procedureId, goldenTests.name],
              set: {
                branchKey: row.BranchKey,
                sourceInvocationId: item.invocation_id,
                inputParams: JSON.parse(row.InputParams) as unknown,
                rationale: item.covers,
                agentRunId: context.agentRunId,
              },
            });
        }

        return text(
          [
            `Stored ${withRequired.length} golden cases for ${context.procedureName}. Their expectations are recorded next by executing the procedure against each one.`,
            ...(missingRare.length > 0
              ? [
                  '',
                  `Added ${missingRare.length} rare-branch case${missingRare.length === 1 ? '' : 's'} you did not select:`,
                  ...missingRare.map((m) => `  invocation ${Number(m.InvocationID)} · ${m.CallerContext}`),
                  'These are deliberately unusual calls. A suite chosen by judgement drops them and still looks complete, so the platform always includes them.',
                ]
              : []),
          ].join('\n'),
        );
      } finally {
        await pool.close();
      }
    },
  );

  const writeInvariants = tool(
    'write_invariants',
    'Record the invariants for the procedure under analysis. Each is checked in code against what a golden case wrote, so it must use the supported kinds; anything else must be filed as advisory.',
    {
      invariants: z
        .array(
          z.object({
            name: z.string().describe('Short stable identifier, e.g. vat-rate-from-table'),
            rationale: z.string().describe('One or two sentences in Czech: what this rule protects and why it matters.'),
            spec: z
              .record(z.string(), z.unknown())
              .describe(
                'One of: {kind:"sum_identity",table,target,components:[{column,factor}],tolerance} · ' +
                  '{kind:"non_negative",table,columns:[...]} · ' +
                  '{kind:"value_from_table",table,numerator:[{column,factor}],denominator:[{column,factor}],referenceTable,referenceColumn,referenceScale,tolerance} · ' +
                  '{kind:"advisory",note}',
              ),
          }),
        )
        .min(1),
    },
    async ({ invariants: proposed }) => {
      if (context.procedureName === null) return text('No procedure is under analysis in this run.');
      const [procedure] = await context.db.select().from(procedures).where(eq(procedures.name, context.procedureName));
      if (procedure === undefined) return text(`No procedure named ${context.procedureName}.`);

      const pool = await connect(context.config);
      try {
        // Real tables and columns, so a mistyped column cannot become an invariant that
        // silently checks nothing and then sits on screen at zero violations looking healthy.
        const catalog = new Map<string, Set<string>>();
        for (const row of await readCatalog(pool)) {
          catalog.set(row.tableName, (catalog.get(row.tableName) ?? new Set()).add(row.columnName));
        }

        const rejected: string[] = [];
        const accepted: { name: string; kind: string; spec: unknown; rationale: string }[] = [];

        for (const item of proposed) {
          const parsed = invariantSpec.safeParse(item.spec);
          if (!parsed.success) {
            rejected.push(`${item.name}: not a supported invariant shape — ${parsed.error.issues[0]?.message ?? 'invalid'}`);
            continue;
          }
          const unknown = unknownIdentifiers(parsed.data, catalog);
          if (unknown.length > 0) {
            rejected.push(`${item.name}: no such ${unknown.join(', ')}`);
            continue;
          }
          accepted.push({ name: item.name, kind: parsed.data.kind, spec: parsed.data, rationale: item.rationale });
        }

        if (accepted.length > 0) {
          // Same accumulation rule as the golden cases, and for the same reason: the agent
          // sent ten invariants in one call and one in the next, and wholesale replacement
          // kept only the one.
          await context.db.delete(invariants).where(supersededBy(invariants, procedure.id, context.agentRunId));
          for (const item of accepted) {
            await context.db
              .insert(invariants)
              .values({
                procedureId: procedure.id,
                name: item.name,
                kind: item.kind,
                spec: item.spec,
                rationale: item.rationale,
                evaluable: item.kind !== 'advisory',
                agentRunId: context.agentRunId,
              })
              .onConflictDoUpdate({
                target: [invariants.procedureId, invariants.name],
                set: {
                  kind: item.kind,
                  spec: item.spec,
                  rationale: item.rationale,
                  evaluable: item.kind !== 'advisory',
                  agentRunId: context.agentRunId,
                },
              });
          }
        }

        // For a rate check, say out loud what it will be compared against. Getting
        // `referenceScale` backwards makes a correct rule fail on every row, which looks
        // identical to a procedure that is broken everywhere — and it cost a run before this
        // was reported. Seeing "compares against 2100.0000" when you meant a VAT rate is
        // unmissable in a way that reading the parameter back is not.
        const comparisons = await Promise.all(
          accepted
            .filter((a) => a.kind === 'value_from_table')
            .map(async (a) => {
              const spec = a.spec as Extract<InvariantSpec, { kind: 'value_from_table' }>;
              const values = (
                await pool
                  .request()
                  .query(`SELECT DISTINCT [${spec.referenceColumn}] AS v FROM dbo.[${spec.referenceTable}]`)
              ).recordset as { v: number }[];
              const scaled = values
                .map((r) => Number(r.v) * spec.referenceScale)
                .sort((x, y) => x - y)
                .map((n) => n.toFixed(4));
              return `  ${a.name} compares ${spec.referenceTable}.${spec.referenceColumn} × ${spec.referenceScale} = ${scaled.join(', ')}`;
            }),
        );

        return text(
          [
            `Stored ${accepted.length} invariants for ${context.procedureName}.`,
            ...accepted.map((a) => `  ${a.name} (${a.kind})`),
            ...(comparisons.length > 0
              ? ['', 'Rate checks will compare the derived ratio against these values:', ...comparisons,
                 'If those do not look like the rates you meant, your referenceScale is wrong — resend.']
              : []),
            ...(rejected.length > 0 ? ['', 'Rejected — fix and resend, or file as advisory:', ...rejected.map((r) => `  ${r}`)] : []),
          ].join('\n'),
        );
      } finally {
        await pool.close();
      }
    },
  );

  return createSdkMcpServer({
    name: 'parity',
    version: '1.0.0',
    instructions:
      'Tools for reading the stored-procedure estate and recording findings about it. These are the only route to information about a procedure — there is no shell and no file access outside your working directory.',
    tools: [readProcedure, queryCapture, listCaptureCases, writeTriage, writeSpec, writeGoldenTests, writeInvariants],
  });
}

/** Fully-qualified names, which is how allowedTools and the policy table refer to them. */
export const TOOL = {
  readProcedure: 'mcp__parity__read_procedure',
  queryCapture: 'mcp__parity__query_capture',
  listCaptureCases: 'mcp__parity__list_capture_cases',
  writeTriage: 'mcp__parity__write_triage',
  writeSpec: 'mcp__parity__write_spec',
  writeGoldenTests: 'mcp__parity__write_golden_tests',
  writeInvariants: 'mcp__parity__write_invariants',
} as const;
