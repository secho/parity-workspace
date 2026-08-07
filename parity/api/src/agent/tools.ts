import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { and, desc, eq, isNull, ne, or, sql as raw, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { decisions, diffs, goldenTests, invariants, procedures, shadowRuns, specs } from '../db/schema.js';
import type { Config } from '../env.js';
import { connect, readCatalog } from '../ingest/mssql.js';
import { invariantSpec, unknownIdentifiers, type InvariantSpec } from '../oracle/invariants.js';
import { runShadow } from '../shadow/run.js';
import { outcomeSignature } from '../capture/signature.js';
import { nextAttempt, recordArtifact, serviceFileRefusal } from '../service/artifacts.js';
import { assemblePr } from '../pr/bundle.js';

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
  /**
   * Which attempt `write_service_file` writes under, fixed for the whole run.
   *
   * Derived per call it would drift mid-run: the first file would open attempt 3, and the
   * second, seeing 3 already stored, would open 4 — leaving two half-attempts and nothing
   * complete enough to adopt.
   */
  serviceAttempt?: number;
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
          // Promote, never demote — the same rule the oracle and shadow ladders already follow.
          // A flat `'specced'` un-deletes a procedure: run `Smazat mrtvé procedury` and then
          // `Zmapovat estate`, which is the order beat 2 wants, and triage walks the three dead
          // ones back from `deleted` to `specced`. Found by rehearsing the beat in that order.
          campaignStatus: raw`case when ${procedures.campaignStatus} = 'untouched' then 'specced' else ${procedures.campaignStatus} end`,
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

        // A tolerance wide enough to blur the reference table against itself is not a rate
        // check, and the platform refuses it rather than asking nicely.
        //
        // M4 learned that a rate rule's *scale* can be wrong in a way that reads fine in the
        // JSON, and answered it by echoing the compared values back. `tolerance` is the same
        // trap one parameter along, and echoing turned out not to be enough: a later run
        // proposed 0.02 against a table holding {0,10 · 0,15 · 0,20 · 0,21}, whose adjacent
        // rates are 0,01 apart. That tolerance cannot tell 20 % from 21 %, and it swallowed a
        // derived rate of 0,168 — the planted promo/VAT defect — by matching it to 0,15 within
        // 0,018. The suite came back green having lost the one thing it exists to find.
        //
        // Same division of labour as the policy hook and M4's rare-branch floor: a rule that
        // matters is enforced by the platform, not requested in a prompt.
        const references = new Map<string, number[]>();
        const tooCoarse = new Set<string>();

        for (const item of accepted.filter((a) => a.kind === 'value_from_table')) {
          const spec = item.spec as Extract<InvariantSpec, { kind: 'value_from_table' }>;
          const key = `${spec.referenceTable}.${spec.referenceColumn}`;
          if (!references.has(key)) {
            const rows = (
              await pool.request().query(`SELECT DISTINCT [${spec.referenceColumn}] AS v FROM dbo.[${spec.referenceTable}]`)
            ).recordset as { v: number }[];
            references.set(
              key,
              rows.map((r) => Number(r.v)),
            );
          }

          const scaled = [...new Set((references.get(key) ?? []).map((v) => v * spec.referenceScale))].sort((a, b) => a - b);
          let gap = Infinity;
          for (let i = 1; i < scaled.length; i++) gap = Math.min(gap, scaled[i] - scaled[i - 1]);
          // One reference value has no gap to be confused with, so any tolerance is honest.
          if (!Number.isFinite(gap) || spec.tolerance < gap / 2) continue;

          tooCoarse.add(item.name);
          rejected.push(
            `${item.name}: tolerance ${spec.tolerance} cannot tell the reference values apart — the closest two ` +
              `(${scaled.join(', ')}) are ${gap.toFixed(4)} apart, so anything at or above ${(gap / 2).toFixed(4)} ` +
              `matches more than one of them and the rule stops discriminating. Resend with a tolerance below ` +
              `${(gap / 2).toFixed(4)}, or file it as advisory.`,
          );
        }

        if (tooCoarse.size > 0) {
          const usable = accepted.filter((a) => !tooCoarse.has(a.name));
          accepted.length = 0;
          accepted.push(...usable);
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

  /**
   * Record the verdict on one finding from a shadow run.
   *
   * The vocabulary is closed and the tool enforces it, for the same reason invariants are a
   * closed vocabulary evaluated in code: free text presented as a verdict is a comment, and a
   * comment that looks like verification is what this build exists not to ship. A `noise`
   * reason outside the skill's list is refused rather than stored — the skill's own words are
   * "if the reason is not in that list, it is **not** noise".
   */
  const classifyDiff = tool(
    'classify_diff',
    'Record the verdict on one difference from a shadow run: noise with a reason from the closed list, or behaviour_change with a Czech explanation.',
    {
      signature: z.string().describe('The finding signature you were given, copied exactly'),
      verdict: z.enum(['noise', 'behaviour_change']),
      reason: z
        .enum(['time', 'identifier', 'ordering', 'float_precision', 'unstable_collection'])
        .nullable()
        .describe('Required for noise, must be null for behaviour_change'),
      explanation_cs: z
        .string()
        .describe('Czech. For behaviour_change: what changed and its business consequence, two sentences.'),
    },
    async ({ signature, verdict, reason, explanation_cs }) => {
      if (verdict === 'noise' && reason === null) {
        return text('Rejected: a noise verdict needs a reason from the list. If none of them fits, it is not noise.');
      }
      if (verdict === 'behaviour_change' && reason !== null) {
        return text('Rejected: a behaviour_change carries no noise reason. Set reason to null.');
      }
      if (explanation_cs.trim() === '') {
        return text('Rejected: explanation_cs is empty. A verdict nobody can read is not a verdict.');
      }

      // Scoped to the newest run carrying this signature unclassified. A signature names a
      // shape — `write_set:OrderLedger.TotalVat:material` — not a run, so once M6 re-runs a
      // shadow after a decision, an unscoped update would reach back and label the previous
      // run's rows with this run's verdict.
      const [newest] = await context.db
        .select({ shadowRunId: diffs.shadowRunId })
        .from(diffs)
        .where(and(eq(diffs.signature, signature), isNull(diffs.verdict)))
        .orderBy(desc(diffs.shadowRunId))
        .limit(1);

      if (newest === undefined) {
        return text(`No unclassified difference carries the signature ${signature}. Check you copied it exactly.`);
      }

      const updated = await context.db
        .update(diffs)
        .set({
          verdict,
          verdictSource: 'classify-diff',
          noiseReason: reason,
          explanationCs: explanation_cs,
          agentRunId: context.agentRunId,
        })
        .where(
          and(
            eq(diffs.signature, signature),
            isNull(diffs.verdict),
            eq(diffs.shadowRunId, newest.shadowRunId),
          ),
        )
        .returning({ id: diffs.id });

      if (updated.length === 0) {
        return text(`No unclassified difference carries the signature ${signature}. Check you copied it exactly.`);
      }
      return text(
        `Recorded ${verdict}${reason === null ? '' : ` (${reason})`} for ${signature} — applied to ${updated.length} difference${updated.length === 1 ? '' : 's'}.`,
      );
    },
  );

  /**
   * Start a shadow run.
   *
   * Real work, not a description of it: this replays captured invocations against the
   * replacement on the restored copy and returns what the diff engine found. Nothing about
   * the mechanism changes because a model asked for it rather than a human — the same
   * function the CLI and the API route call.
   */
  const runShadowTool = tool(
    'run_shadow',
    'Replay captured invocations of a procedure against its replacement on the shadow database, and report what differs.',
    {
      name: z.string().describe('Procedure name, e.g. sp_CalculateOrderTotal'),
      cases: z.number().int().min(1).max(2000).optional().describe('How many captured invocations to replay'),
    },
    async ({ name, cases }) => {
      const result = await runShadow(context.db, context.config, { procedureName: name, limit: cases });
      return text(
        [
          `Shadow run ${result.shadowRunId} against ${result.shadowDatabase}.`,
          `${result.casesReplayed} cases replayed over ${result.strataCovered}/${result.strataObserved} observed strata in ${(result.replayMs / 1000).toFixed(1)}s.`,
          `${result.rawDiffs} raw differences; ${result.resolvedByCanonicaliser} were resolved by canonicalisation in code and ${result.surviving} survived.`,
          '',
          'Findings:',
          ...result.findings.map((f) => `  ${f.signature} — ${f.cases} cases`),
        ].join('\n'),
      );
    },
  );

  /**
   * Record a human's decision on a finding.
   *
   * Tier 3 in the policy table for every task class, so the `PreToolUse` hook refuses it and
   * the item lands in the queue instead. That is not a placeholder — it is the rule the
   * decision queue exists to enforce, made executable: the one thing an agent may never do is
   * decide, on a person's behalf, that changed behaviour is acceptable. The tool is real so
   * that the refusal is real.
   */
  const recordDecision = tool(
    'record_decision',
    'Record a decision on one behavioural difference: preserve the old behaviour, accept the new one, or escalate.',
    {
      signature: z.string().describe('The finding signature'),
      action: z.enum(['preserve', 'accept', 'escalate']),
      note: z.string().describe('Why, in Czech'),
    },
    async ({ signature, action, note }) => {
      const [diff] = await context.db.select().from(diffs).where(eq(diffs.signature, signature)).limit(1);
      if (diff === undefined) return text(`No finding carries the signature ${signature}.`);

      const [run] = await context.db.select().from(shadowRuns).where(eq(shadowRuns.id, diff.shadowRunId));
      await context.db
        .insert(decisions)
        .values({
          procedureId: run.procedureId,
          shadowRunId: diff.shadowRunId,
          diffSignature: signature,
          action,
          note,
          decidedBy: 'agent',
          agentRunId: context.agentRunId,
        })
        .onConflictDoUpdate({
          target: [decisions.shadowRunId, decisions.diffSignature],
          set: { action, note, decidedAt: new Date() },
        });

      return text(`Recorded ${action} for ${signature}.`);
    },
  );

  /**
   * The specification, back out of the database.
   *
   * `implement-service` is given a spec to reproduce, and the spec is prose written by an
   * earlier run rather than anything on this run's disk. Handing it over in the prompt would
   * work for one procedure and fall over on a long one; a tool keeps it out of the context
   * until it is asked for, and puts a row in the audit log saying it was read.
   */
  const readSpec = tool(
    'read_spec',
    'Read the stored Czech specification for the procedure under analysis.',
    { name: z.string().describe('Procedure name, e.g. sp_CalculateOrderTotal') },
    async ({ name }) => {
      const [row] = await context.db
        .select({ markdown: specs.markdown })
        .from(specs)
        .innerJoin(procedures, eq(specs.procedureId, procedures.id))
        .where(eq(procedures.name, name));
      if (row === undefined) return text(`No specification has been written for ${name}.`);
      return text(row.markdown);
    },
    { annotations: { readOnlyHint: true } },
  );

  /**
   * Write one file of the replacement service.
   *
   * The path is checked against a closed allowlist here rather than described in the skill,
   * for the same reason the rare-branch floor lives in `write_golden_tests` and the tolerance
   * check lives in `write_invariants`: a rule that matters is enforced by the platform, not
   * requested in a prompt. `index.ts` and `db.ts` are the shadow harness's contract and are
   * not the agent's to rewrite — see ../service/artifacts.ts for why that is a claim worth
   * making out loud rather than a limitation worth hiding.
   *
   * There is no matching read tool for the golden tests' recorded expectations, and there is
   * no policy row that could permit one. An implementation fitted to the oracle is not
   * measured by it.
   */
  const writeServiceFile = tool(
    'write_service_file',
    'Write one source file of the replacement service. Only the business-logic files are writable; the HTTP shell belongs to the migration harness.',
    {
      // z.string(), not z.enum: the allowed set depends on which procedure the run is for, and
      // a schema cannot see that. The refusal below is the enforcement — and it is a better one,
      // because zod would have thrown an opaque schema error the agent could not act on.
      path: z.string().describe('Which file, relative to the service src/ directory for this procedure.'),
      contents: z.string().describe('The complete file. Node 22 + TypeScript, ESM, importing only fastify and mssql.'),
    },
    async ({ path, contents }) => {
      if (context.procedureName === null) return text('No procedure is under analysis in this run.');
      const [row] = await context.db.select().from(procedures).where(eq(procedures.name, context.procedureName));
      if (row === undefined) return text(`No procedure named ${context.procedureName}.`);

      // Both refusals live in `service/artifacts.ts` so that a gate can exercise the real
      // decision without a live model run. This is the whole enforcement — the schema takes a
      // plain string, because which paths are allowed depends on the run's procedure and a
      // schema cannot see that.
      const refusal = serviceFileRefusal(context.procedureName, path, contents);
      if (refusal !== null) return text(refusal);

      const attempt = context.serviceAttempt ?? (await nextAttempt(context.db, row.id));
      const stored = await recordArtifact(context.db, {
        procedureId: row.id,
        agentRunId: context.agentRunId,
        attempt,
        path,
        contents,
      });
      return text(
        `Stored ${path} (${contents.length} characters, sha256 ${stored.sha256.slice(0, 12)}) as attempt ${attempt} of the ${context.procedureName} service.`,
      );
    },
  );

  /**
   * Open the pull request.
   *
   * Tier 3 for every task class, so the hook refuses it and the PR waits for a person — the
   * same shape as `record_decision` and for the same reason. The tool is fully implemented,
   * which is what makes the refusal mean something: `probe-pr` provokes it live rather than
   * reading the policy table back, because `seedPolicy` writes that table unconditionally and
   * a check against it could not fail.
   *
   * Assembling is not opening. This tool assembles the branch, the files and the Czech body
   * and persists them either way; whether it also pushes is the human's click.
   */
  const openPr = tool(
    'open_pr',
    'Open a pull request carrying the specification, the golden tests, the generated service and the recorded decision.',
    {
      name: z.string().describe('Procedure name the migration is for'),
      summary_cs: z.string().describe('Two or three sentences, in Czech, on what this change does'),
      fix_candidates_cs: z
        .string()
        .describe('Defects reproduced deliberately and what the correct behaviour would be. Czech. Empty string if none.'),
    },
    async ({ name, summary_cs, fix_candidates_cs }) => {
      const assembled = await assemblePr(context.db, context.config, {
        procedureName: name,
        summaryCs: summary_cs,
        fixCandidatesCs: fix_candidates_cs,
      });
      if (assembled === null) return text(`Nothing to open a PR for: ${name} has no generated service yet.`);
      return text(
        `Assembled a pull request for ${name}: branch ${assembled.branch}, ${(assembled.files as { path: string }[]).length} files, ${assembled.body.length} characters of body. It has NOT been opened — that is a human's click.`,
      );
    },
  );

  return createSdkMcpServer({
    name: 'parity',
    version: '1.0.0',
    instructions:
      'Tools for reading the stored-procedure estate and recording findings about it. These are the only route to information about a procedure — there is no shell and no file access outside your working directory.',
    tools: [
      readProcedure,
      queryCapture,
      listCaptureCases,
      writeTriage,
      writeSpec,
      writeGoldenTests,
      writeInvariants,
      classifyDiff,
      runShadowTool,
      recordDecision,
      readSpec,
      writeServiceFile,
      openPr,
    ],
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
  classifyDiff: 'mcp__parity__classify_diff',
  runShadow: 'mcp__parity__run_shadow',
  recordDecision: 'mcp__parity__record_decision',
  readSpec: 'mcp__parity__read_spec',
  writeServiceFile: 'mcp__parity__write_service_file',
  openPr: 'mcp__parity__open_pr',
} as const;
