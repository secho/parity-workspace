import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  goldenResults,
  goldenTests,
  invariantResults,
  invariants,
  oracleRuns,
  procedureCalls,
  procedureColumns,
  procedures,
} from '../db/schema.js';
import type { Config } from '../env.js';
import type { OracleState } from '../estate/blocker.js';
import { connectRunner } from '../ingest/mssql.js';
import { canonicalise, fingerprint, stableKey, type CanonicalOutcome } from './canonicalise.js';
import { executeRolledBack, readIdentityColumns, readParameters, readPrimaryKeys, type AmbientContext } from './execute.js';
import { evaluate, invariantSpec, isConfirmedRule, loadReferenceValues, type InvariantSpec } from './invariants.js';

/**
 * Running a procedure's oracle: every golden case, then every invariant over what those
 * cases wrote.
 *
 * Two kinds of run. A **baseline** records what the current procedure does and stores it as
 * the expectation. A **verify** run does exactly the same work and compares. That is not a
 * tautology as long as something can make it fail, which is why `probe-oracle` exists and
 * why `verify-m4` refuses to pass without it — M1 and M2 both shipped an assertion that
 * compared a constant to itself, and both times it was found by asking "what would make
 * this red?" rather than by reading the code.
 */

export interface SuiteOutcome {
  oracleRunId: number;
  goldenPassed: number;
  goldenFailed: number;
  invariantsChecked: number;
  invariantsViolated: number;
  /** Violations of rules that actually describe this procedure. The findings. */
  violations: string[];
  /** Rules the procedure breaks nearly everywhere — mis-stated, kept as leads. */
  unconfirmed: string[];
  durationMs: number;
}

/**
 * Which tables a procedure can write — its own parsed writes plus those of everything it
 * EXECs. `sp_PlaceOrder` orchestrates three other procedures, and without the call graph its
 * write set would be missing most of what it does.
 */
export async function writeTablesFor(db: Db, procedureId: number): Promise<string[]> {
  const callees = await db
    .select({ id: procedureCalls.calleeId })
    .from(procedureCalls)
    .where(eq(procedureCalls.callerId, procedureId));

  const ids = [procedureId, ...callees.map((c) => c.id)];
  const rows = await db
    .select({ tableName: procedureColumns.tableName })
    .from(procedureColumns)
    .where(and(inArray(procedureColumns.procedureId, ids), eq(procedureColumns.access, 'write')));

  return [...new Set(rows.map((r) => r.tableName))].sort();
}

interface CaseRun {
  goldenTestId: number;
  name: string;
  canonical: CanonicalOutcome;
  /**
   * What the clock said while this expectation was being recorded.
   *
   * Kept because M6 pins the replacement service to it. `GETDATE()` cannot be overridden
   * inside T-SQL, so a procedure always reads the wall clock; a service can be handed one,
   * and handing it *this* one is what makes "the same case, against a different
   * implementation" a fair comparison rather than a comparison of two different Tuesdays.
   */
  context: AmbientContext;
  clockWindow: { from: number; to: number };
  durationMs: number;
}

/**
 * Execute every golden case for one procedure and canonicalise the outcome.
 *
 * One connection, one metadata read, N rolled-back transactions. Nothing is committed and
 * nothing is left behind — `verify-m4` fingerprints the estate either side of this and
 * asserts it did not move.
 */
async function executeCases(
  db: Db,
  config: Config,
  procedureName: string,
  procedureId: number,
): Promise<{ runs: CaseRun[]; referenceValues: Map<string, number[]>; specs: { id: number; name: string; spec: InvariantSpec }[] }> {
  const cases = await db
    .select()
    .from(goldenTests)
    .where(eq(goldenTests.procedureId, procedureId))
    .orderBy(asc(goldenTests.name));

  const stored = await db.select().from(invariants).where(eq(invariants.procedureId, procedureId));
  const specs = stored.flatMap((row) => {
    const parsed = invariantSpec.safeParse(row.spec);
    return parsed.success ? [{ id: row.id, name: row.name, spec: parsed.data }] : [];
  });

  const pool = await connectRunner(config);
  try {
    const parameters = await readParameters(pool, procedureName);
    const primaryKeys = await readPrimaryKeys(pool);
    const identityColumns = await readIdentityColumns(pool);
    const writeTables = await writeTablesFor(db, procedureId);
    const referenceValues = await loadReferenceValues(pool, specs.map((s) => s.spec));

    const runs: CaseRun[] = [];
    for (const test of cases) {
      const started = Date.now();
      const outcome = await executeRolledBack(pool, {
        procedureName,
        params: test.inputParams as Record<string, unknown>,
        writeTables,
        parameters,
        primaryKeys,
      });
      runs.push({
        goldenTestId: test.id,
        name: test.name,
        canonical: canonicalise(outcome, { clockWindow: outcome.clockWindow, identityColumns }),
        context: outcome.context,
        clockWindow: outcome.clockWindow,
        durationMs: Date.now() - started,
      });
    }
    return { runs, referenceValues, specs };
  } finally {
    await pool.close();
  }
}

/**
 * Record what the current procedure does, as the thing every later run is measured against.
 *
 * The expectation is deliberately not the captured result. Ninety days of later traffic
 * touched the same rows, so a captured value and a value produced today differ for reasons
 * that have nothing to do with the code — `docs/DECISIONS.md` records M1 discovering exactly
 * this. Inputs come from the capture; the expectation comes from a run against today's state,
 * which is the only comparison where both sides saw the same database.
 */
export async function recordBaseline(db: Db, config: Config, procedureName: string): Promise<number> {
  const [procedure] = await db.select().from(procedures).where(eq(procedures.name, procedureName));
  if (procedure === undefined) throw new Error(`no procedure named ${procedureName}`);

  const { runs } = await executeCases(db, config, procedureName, procedure.id);
  for (const run of runs) {
    await db
      .update(goldenTests)
      .set({
        expectedResult: run.canonical.resultSets,
        expectedWriteSet: run.canonical.writeSet,
        normalisations: run.canonical.normalisations,
        // Declared since M4 and written here for the first time. Without it M6 has no instant
        // to pin the service to, and a promo whose validity window closed between the baseline
        // and the replay would take a different branch on one side only.
        baselineContext: { ...run.context, clockWindow: run.clockWindow },
      })
      .where(eq(goldenTests.id, run.goldenTestId));
  }
  return runs.length;
}

/** Run the oracle and write down what happened. */
export async function runSuite(
  db: Db,
  config: Config,
  procedureName: string,
  kind: 'baseline' | 'verify' | 'probe' = 'verify',
): Promise<SuiteOutcome> {
  const [procedure] = await db.select().from(procedures).where(eq(procedures.name, procedureName));
  if (procedure === undefined) throw new Error(`no procedure named ${procedureName}`);

  const started = Date.now();
  const [run] = await db
    .insert(oracleRuns)
    .values({ procedureId: procedure.id, kind })
    .returning({ id: oracleRuns.id });

  const { runs, referenceValues, specs } = await executeCases(db, config, procedureName, procedure.id);
  const expectations = await db.select().from(goldenTests).where(eq(goldenTests.procedureId, procedure.id));
  const byId = new Map(expectations.map((e) => [e.id, e]));

  let goldenPassed = 0;
  let goldenFailed = 0;

  for (const caseRun of runs) {
    const expected = byId.get(caseRun.goldenTestId)!;
    const actual = fingerprint(caseRun.canonical);
    const wanted = stableKey({ resultSets: expected.expectedResult, writeSet: expected.expectedWriteSet });
    const pass = actual === wanted;
    pass ? (goldenPassed += 1) : (goldenFailed += 1);

    await db
      .insert(goldenResults)
      .values({
        oracleRunId: run.id,
        goldenTestId: caseRun.goldenTestId,
        status: pass ? 'pass' : 'fail',
        detail: pass ? null : firstDifference(wanted, actual),
        durationMs: caseRun.durationMs,
      })
      .onConflictDoNothing();
  }

  let invariantsChecked = 0;
  let invariantsViolated = 0;
  const violations: string[] = [];
  const unconfirmed: string[] = [];

  for (const { id, name, spec } of specs) {
    let checked = 0;
    let violated = 0;
    let firstViolation: string | null = null;

    for (const caseRun of runs) {
      const outcome = evaluate(spec, caseRun.canonical.writeSet, referenceValues, caseRun.name);
      checked += outcome.checked;
      violated += outcome.violated;
      firstViolation ??= outcome.firstViolation;
    }

    invariantsChecked += checked;
    invariantsViolated += violated;
    if (violated > 0 && firstViolation !== null) {
      // Same derivation the API and the UI use: a rule the procedure breaks nearly everywhere
      // is describing something else, and reporting it beside a real finding buries the one
      // that matters.
      const confirmed = isConfirmedRule(spec.kind !== 'advisory', checked, violated);
      (confirmed ? violations : unconfirmed).push(`${name} — ${firstViolation}`);
    }

    await db
      .insert(invariantResults)
      .values({ oracleRunId: run.id, invariantId: id, casesChecked: checked, casesViolated: violated, firstViolation })
      .onConflictDoNothing();
  }

  const durationMs = Date.now() - started;
  await db
    .update(oracleRuns)
    .set({ goldenPassed, goldenFailed, invariantsChecked, invariantsViolated, durationMs, finishedAt: new Date() })
    .where(eq(oracleRuns.id, run.id));

  // A probe run is a deliberate sabotage and must never move the estate's state.
  //
  // Only rules that are actually evaluated count towards the `invariants` state. A procedure
  // carrying nothing but advisory notes has golden tests and a list of things somebody
  // intends to check, which is not the same claim.
  const evaluated = specs.filter((s) => s.spec.kind !== 'advisory').length;
  if (kind !== 'probe') await promote(db, procedure.id, goldenPassed, goldenFailed, evaluated);

  return {
    oracleRunId: run.id,
    goldenPassed,
    goldenFailed,
    invariantsChecked,
    invariantsViolated,
    violations,
    unconfirmed,
    durationMs,
  };
}

/**
 * The oracle-state ladder, in order. `promote` only ever moves forward along it.
 *
 * Mirrors `estate/blocker.ts`'s `OracleState`; kept here as an ordered array because order is
 * the whole point and a union type has none.
 */
const LADDER: OracleState[] = ['none', 'golden', 'invariants', 'shadow', 'proven'];

/**
 * Move `oracle_state`, which is the only thing that moves coverage.
 *
 * A suite with a failing case does not promote at all. Coverage answers "how much of what
 * actually runs is now provable", and a procedure whose own golden tests disagree with it is
 * not proved — counting it would make the headline number on the Estate screen a lie in the
 * flattering direction, which is the one that matters.
 *
 * A *violated invariant* does not block promotion. It is a finding about the estate, not an
 * absence of an oracle: the oracle worked, and what it found is that the procedure breaks a
 * rule the spec says it should keep.
 */
async function promote(db: Db, procedureId: number, passed: number, failed: number, invariantCount: number): Promise<void> {
  if (passed === 0 || failed > 0) return;

  const earned: OracleState = invariantCount > 0 ? 'invariants' : 'golden';
  const [current] = await db.select().from(procedures).where(eq(procedures.id, procedureId));
  if (current === undefined) return;

  // Promote, never demote.
  //
  // A passing oracle suite is evidence that the golden tests still hold; it is not evidence
  // that the shadow run which came after them has been undone. Re-running the suite on a
  // procedure already at `shadow` used to write `invariants` straight back over it, so the
  // Estate screen quietly regressed — the blocker went from `čeká na rozhodnutí` back to
  // `chybí shadow run` and the roadmap told the room something that was no longer true.
  //
  // Found by `verify-m5`, whose promotion checks failed after `verify-m4` had re-run the
  // suites. The gate order is documented and would have avoided it, but a state ladder that
  // only holds while commands are run in the right order is not a ladder. Same reasoning as
  // `blocker` being derived: the screen must not be able to drift from what happened.
  if (LADDER.indexOf(current.oracleState as OracleState) >= LADDER.indexOf(earned)) return;

  await db
    .update(procedures)
    .set({ oracleState: earned, campaignStatus: 'oracled' })
    .where(eq(procedures.id, procedureId));
}

/** Where two canonical forms first diverge, trimmed to something readable on a screen. */
function firstDifference(expected: string, actual: string): string {
  let i = 0;
  while (i < expected.length && i < actual.length && expected[i] === actual[i]) i += 1;
  const from = Math.max(0, i - 60);
  return `at ${i}: expected …${expected.slice(from, i + 80)}… got …${actual.slice(from, i + 80)}…`;
}
