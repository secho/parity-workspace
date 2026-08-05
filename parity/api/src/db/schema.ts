import { relations } from 'drizzle-orm';
import { boolean, index, integer, pgTable, serial, text, timestamp, unique } from 'drizzle-orm/pg-core';

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
