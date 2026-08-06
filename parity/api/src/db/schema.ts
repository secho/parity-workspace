import { relations } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

/**
 * Parity's own state. Deliberately not the demo app's database — Parity must look
 * like something that could be pointed at Alza's real estate tomorrow, and that
 * means it owns nothing inside the estate it analyses.
 *
 * `blocker` is ABSENT ON PURPOSE. It is computed from oracle_class + oracle_state +
 * domain on every read (see ../estate/blocker.ts). A stored blocker drifts from
 * reality and then lies on the main screen. `verify-m2` asserts no table here has a
 * column by that name.
 */

export const procedures = pgTable(
  'procedures',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull().unique(),
    schemaName: text('schema_name').notNull(),
    sourceSql: text('source_sql').notNull(),
    lineCount: integer('line_count').notNull(),
    domain: text('domain'),

    /** Counted from parity_capture.Invocation, excluding the acceptance gate's own probes. */
    invocations90d: integer('invocations_90d').notNull().default(0),
    /** The SIMULATED timeline the traffic generator invented — the 90 days of history. */
    lastInvokedAt: timestamp('last_invoked_at', { withTimezone: true }),

    /** pure_read | det_write | nondet | external | none — set by M3's triage, null until then. */
    oracleClass: text('oracle_class'),
    /** none | golden | invariants | shadow | proven */
    oracleState: text('oracle_state').notNull().default('none'),
    /** untouched | specced | oracled | shadow | migrated | deleted */
    campaignStatus: text('campaign_status').notNull().default('untouched'),

    ownerTeam: text('owner_team'),
    /** money | regulatory | none */
    riskClass: text('risk_class'),
    /** Seam requirements from triage — what would have to be injected to make it replayable. */
    seamRequirements: text('seam_requirements'),

    /** True when the body builds SQL as a string. Its reads[] are parsed but inferred. */
    usesDynamicSql: boolean('uses_dynamic_sql').notNull().default(false),

    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_procedures_invocations').on(t.invocations90d)],
);

/** Column-level reads and writes, parsed from the T-SQL. One row per access. */
export const procedureColumns = pgTable(
  'procedure_columns',
  {
    id: serial('id').primaryKey(),
    procedureId: integer('procedure_id')
      .notNull()
      .references(() => procedures.id, { onDelete: 'cascade' }),
    tableName: text('table_name').notNull(),
    /** '*' means the whole row — a DELETE, or an INSERT with no column list. */
    columnName: text('column_name').notNull(),
    /** read | write */
    access: text('access').notNull(),
    /** Is this procedure the primary writer of the column? Highest invocation count wins. */
    isWriteOwner: boolean('is_write_owner').notNull().default(false),
    /** True when the parser had to widen: a column-less INSERT, or an ambiguous bare name. */
    inferred: boolean('inferred').notNull().default(false),
  },
  (t) => [
    unique('uq_procedure_column').on(t.procedureId, t.tableName, t.columnName, t.access),
    index('ix_procedure_columns_target').on(t.tableName, t.columnName, t.access),
  ],
);

/**
 * The data-coupling graph: two procedures that write the same column. Materialised at
 * ingest because it is a deterministic function of the parse, not a maintained field.
 * `a` is always the alphabetically earlier procedure, so each pair appears once.
 */
export const couplingEdges = pgTable(
  'coupling_edges',
  {
    id: serial('id').primaryKey(),
    tableName: text('table_name').notNull(),
    columnName: text('column_name').notNull(),
    aProcedureId: integer('a_procedure_id')
      .notNull()
      .references(() => procedures.id, { onDelete: 'cascade' }),
    bProcedureId: integer('b_procedure_id')
      .notNull()
      .references(() => procedures.id, { onDelete: 'cascade' }),
  },
  (t) => [unique('uq_coupling_edge').on(t.tableName, t.columnName, t.aProcedureId, t.bProcedureId)],
);

/**
 * `EXEC` edges. sp_PlaceOrder orchestrates three other procedures, so its captured write
 * set legitimately contains theirs — without this graph that looks like a parser gap,
 * and `verify-m2`'s cross-check against the capture cannot be made sound.
 */
export const procedureCalls = pgTable(
  'procedure_calls',
  {
    id: serial('id').primaryKey(),
    callerId: integer('caller_id')
      .notNull()
      .references(() => procedures.id, { onDelete: 'cascade' }),
    calleeId: integer('callee_id')
      .notNull()
      .references(() => procedures.id, { onDelete: 'cascade' }),
  },
  (t) => [unique('uq_procedure_call').on(t.callerId, t.calleeId)],
);

// --- M3: the agent, its receipts, and what it produced --------------------------------

/**
 * One skill invocation. Everything needed to replay it is persisted here, because
 * `PARITY_MODE=replay` (M7) is meant to be a read from this table rather than a rebuild —
 * and because the demo cannot depend on conference wifi.
 */
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: serial('id').primaryKey(),
    runId: text('run_id').notNull().unique(),
    skill: text('skill').notNull(),
    /** Drives the policy lookup. A run's tier is a property of the task, not the prompt. */
    taskClass: text('task_class').notNull(),
    procedureId: integer('procedure_id').references(() => procedures.id, { onDelete: 'cascade' }),

    /** running | succeeded | failed | blocked */
    status: text('status').notNull().default('running'),
    /** The model that actually served the run, read off the SDK's init message. */
    model: text('model'),
    provider: text('provider'),
    prompt: text('prompt').notNull(),
    output: text('output'),
    error: text('error'),

    numTurns: integer('num_turns'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    durationMs: integer('duration_ms'),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('ix_agent_runs_procedure').on(t.procedureId)],
);

/** What the agent did, in order, for the live step view on the procedure screen. */
export const agentSteps = pgTable(
  'agent_steps',
  {
    id: serial('id').primaryKey(),
    agentRunId: integer('agent_run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    /** assistant | tool_use | tool_result | system | result */
    kind: text('kind').notNull(),
    toolName: text('tool_name'),
    text: text('text'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('uq_agent_step_seq').on(t.agentRunId, t.seq)],
);

/**
 * The audit log. Appended by a `PostToolUse` hook and by the `PreToolUse` gate, so nothing
 * is instrumented by hand and therefore nothing can be forgotten.
 *
 * Token and cost counts are deliberately absent here: the SDK reports them once per run on
 * the result message, not per tool call. They live on `agent_runs`. Inventing a per-call
 * number would be the kind of plausible fiction this whole build exists to avoid.
 */
export const auditEntries = pgTable(
  'audit_entries',
  {
    id: serial('id').primaryKey(),
    agentRunId: integer('agent_run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    toolName: text('tool_name').notNull(),
    inputSummary: text('input_summary'),
    resultSummary: text('result_summary'),
    durationMs: integer('duration_ms'),
    /** allowed | blocked */
    outcome: text('outcome').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_audit_run').on(t.agentRunId)],
);

/**
 * The autonomy-tier table. A real table that really gates: the `PreToolUse` hook reads it
 * and refuses a call above the tier for that task class. Policy enforced by the platform,
 * not by prompt wording — which is the point, and is the difference between a rule and a
 * suggestion.
 */
export const policyRules = pgTable(
  'policy_rules',
  {
    id: serial('id').primaryKey(),
    taskClass: text('task_class').notNull(),
    toolName: text('tool_name').notNull(),
    /** 1 auto-proceed · 2 proceed and record · 3 human decides */
    tier: integer('tier').notNull(),
    requiresHuman: boolean('requires_human').notNull().default(false),
    note: text('note'),
  },
  (t) => [unique('uq_policy_rule').on(t.taskClass, t.toolName)],
);

/** The Czech specification for one procedure. */
export const specs = pgTable(
  'specs',
  {
    id: serial('id').primaryKey(),
    procedureId: integer('procedure_id')
      .notNull()
      .references(() => procedures.id, { onDelete: 'cascade' })
      .unique(),
    markdown: text('markdown').notNull(),
    model: text('model'),
    agentRunId: integer('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

// --- M4: the oracle — what "unchanged behaviour" is measured against -------------------

/**
 * One golden test case: a real call, and what the current procedure does with it.
 *
 * Inputs are never invented. They are taken verbatim from a captured invocation, and
 * `sourceInvocationId` is the receipt — `verify-m4` reads it back and asserts the stored
 * parameters still byte-match the capture, so "generated from real traffic" is checkable
 * rather than claimed.
 *
 * The expectation is **not** the captured result. `docs/DECISIONS.md` records why: ninety
 * days of later traffic touched the same rows, so a captured value and a value produced
 * today differ for reasons that have nothing to do with the code. The baseline is recorded
 * by executing the current procedure inside a rolled-back transaction, which is the only
 * comparison where both sides saw identical state.
 */
export const goldenTests = pgTable(
  'golden_tests',
  {
    id: serial('id').primaryKey(),
    procedureId: integer('procedure_id')
      .notNull()
      .references(() => procedures.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Which observed branch this case covers, from the capture's own coverage proxy. */
    branchKey: text('branch_key'),
    /** Provenance. The captured invocation these inputs came from. */
    sourceInvocationId: bigint('source_invocation_id', { mode: 'number' }).notNull(),
    inputParams: jsonb('input_params').notNull(),
    /** What the clock said when the traffic ran. Not what the baseline saw — see below. */
    capturedContext: jsonb('captured_context'),
    /** What the clock said when the expectation was recorded. M6 pins the service to this. */
    baselineContext: jsonb('baseline_context'),
    expectedResult: jsonb('expected_result').notNull(),
    expectedWriteSet: jsonb('expected_write_set').notNull(),
    /** Which normalisations the expectation depends on, so it cannot overclaim. */
    normalisations: jsonb('normalisations').notNull(),
    /** The agent's one line on why this case earns its place. */
    rationale: text('rationale'),
    agentRunId: integer('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('uq_golden_test_name').on(t.procedureId, t.name), index('ix_golden_tests_proc').on(t.procedureId)],
);

/**
 * A rule that must hold after any run, evaluated in code over the result and the write set.
 *
 * `kind` comes from a closed vocabulary (see ../oracle/invariants.ts). An invariant the
 * agent could not express in it is stored with `evaluable = false` and is reported as
 * advisory — recorded, never counted as passing. A rule nothing checks is a comment, and
 * a comment presented as verification is exactly what this build exists not to ship.
 */
export const invariants = pgTable(
  'invariants',
  {
    id: serial('id').primaryKey(),
    procedureId: integer('procedure_id')
      .notNull()
      .references(() => procedures.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** sum_identity | non_negative | value_from_table | advisory */
    kind: text('kind').notNull(),
    spec: jsonb('spec').notNull(),
    /** Czech, one or two sentences — this is what a reviewer reads on the procedure screen. */
    rationale: text('rationale'),
    evaluable: boolean('evaluable').notNull().default(true),
    agentRunId: integer('agent_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('uq_invariant_name').on(t.procedureId, t.name), index('ix_invariants_proc').on(t.procedureId)],
);

/** One execution of a procedure's whole oracle: every golden case, then every invariant. */
export const oracleRuns = pgTable(
  'oracle_runs',
  {
    id: serial('id').primaryKey(),
    procedureId: integer('procedure_id')
      .notNull()
      .references(() => procedures.id, { onDelete: 'cascade' }),
    /** baseline | verify | probe — a baseline run records expectations, the others check them. */
    kind: text('kind').notNull(),
    goldenPassed: integer('golden_passed').notNull().default(0),
    goldenFailed: integer('golden_failed').notNull().default(0),
    invariantsChecked: integer('invariants_checked').notNull().default(0),
    invariantsViolated: integer('invariants_violated').notNull().default(0),
    durationMs: integer('duration_ms'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('ix_oracle_runs_proc').on(t.procedureId)],
);

export const goldenResults = pgTable(
  'golden_results',
  {
    id: serial('id').primaryKey(),
    oracleRunId: integer('oracle_run_id')
      .notNull()
      .references(() => oracleRuns.id, { onDelete: 'cascade' }),
    goldenTestId: integer('golden_test_id')
      .notNull()
      .references(() => goldenTests.id, { onDelete: 'cascade' }),
    /** pass | fail | error */
    status: text('status').notNull(),
    /** The first field that differed, canonical form. Empty on a pass. */
    detail: text('detail'),
    durationMs: integer('duration_ms'),
  },
  (t) => [unique('uq_golden_result').on(t.oracleRunId, t.goldenTestId)],
);

export const invariantResults = pgTable(
  'invariant_results',
  {
    id: serial('id').primaryKey(),
    oracleRunId: integer('oracle_run_id')
      .notNull()
      .references(() => oracleRuns.id, { onDelete: 'cascade' }),
    invariantId: integer('invariant_id')
      .notNull()
      .references(() => invariants.id, { onDelete: 'cascade' }),
    casesChecked: integer('cases_checked').notNull().default(0),
    casesViolated: integer('cases_violated').notNull().default(0),
    /** Which golden case broke it first, and by how much. This is the finding. */
    firstViolation: text('first_violation'),
  },
  (t) => [unique('uq_invariant_result').on(t.oracleRunId, t.invariantId)],
);

export const proceduresRelations = relations(procedures, ({ many }) => ({
  columns: many(procedureColumns),
}));

export const procedureColumnsRelations = relations(procedureColumns, ({ one }) => ({
  procedure: one(procedures, { fields: [procedureColumns.procedureId], references: [procedures.id] }),
}));

export type Procedure = typeof procedures.$inferSelect;
export type ProcedureColumn = typeof procedureColumns.$inferSelect;
export type CouplingEdge = typeof couplingEdges.$inferSelect;
export type ProcedureCall = typeof procedureCalls.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type AgentStep = typeof agentSteps.$inferSelect;
export type AuditEntry = typeof auditEntries.$inferSelect;
export type PolicyRule = typeof policyRules.$inferSelect;
export type Spec = typeof specs.$inferSelect;
export type GoldenTest = typeof goldenTests.$inferSelect;
export type Invariant = typeof invariants.$inferSelect;
export type OracleRun = typeof oracleRuns.$inferSelect;
export type GoldenResult = typeof goldenResults.$inferSelect;
export type InvariantResult = typeof invariantResults.$inferSelect;
