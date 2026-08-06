import { asc, eq } from 'drizzle-orm';
import sql from 'mssql';
import type { Db } from '../db/client.js';
import { goldenResults, goldenTests, oracleRuns, procedures } from '../db/schema.js';
import type { Config } from '../env.js';
import { canonicalise, fingerprint, stableKey } from '../oracle/canonicalise.js';
import { readIdentityColumns, readPrimaryKeys, watchWrites, type ExecutionOutcome } from '../oracle/execute.js';
import { writeTablesFor } from '../oracle/suite.js';
import { revertShadow } from '../shadow/database.js';
import { releaseService } from '../shadow/replay.js';

/**
 * The golden suite, run against a replacement instead of against the procedure.
 *
 * "The service passes all golden tests" is M6's first acceptance line, and it only means
 * something if it is the *same* measurement M4 made. So: the same cases, the same
 * expectations, the same canonicaliser, and — after M6's refactor of `watchWrites` — literally
 * the same instrument for observing what the call wrote. The only thing that changes is who is
 * asked to do the work.
 *
 * Three things had to be got right for that to be true.
 *
 * **The clock is pinned.** Expectations were recorded at a known instant, stored in
 * `golden_tests.baseline_context`. A promo whose validity window closed between then and now
 * would take a different branch, and the suite would report a behaviour change that is really
 * a change of date. The procedure cannot be pinned — `GETDATE()` is not overridable inside
 * T-SQL — but a service can be handed a clock, and this hands it that one. The pin lives here
 * and NOWHERE ELSE: the shadow harness must never use it, because pass A cannot be pinned and
 * pinning pass B alone would flip every clock-dependent branch on one side only.
 *
 * **Canonicalisation uses the baseline's clock window, not today's.** Having pinned the
 * service to the baseline instant, the timestamps it writes belong to that window. Handing the
 * canonicaliser the current window instead would leave them looking like literal dates rather
 * than clock reads, and every case would fail on a field that is normalised away on both sides.
 *
 * **Each case starts from the same state the baseline started from.** The procedure's
 * expectations were recorded inside a transaction that rolled back, so every case saw pristine
 * data. A service commits, so case two would otherwise see what case one left behind. The
 * shadow database is reverted before each case — ~530 ms each, which for ten cases is five
 * seconds and buys an apples-to-apples comparison.
 */

export type SuiteTarget = 'service' | 'reference' | 'procedure_on_shadow';

export interface ServiceSuiteOutcome {
  oracleRunId: number;
  target: SuiteTarget;
  passed: number;
  failed: number;
  failures: { name: string; detail: string }[];
  durationMs: number;
}

interface BaselineContext {
  getdate?: string;
  clockWindow?: { from: number; to: number };
}

export async function runServiceSuite(
  db: Db,
  config: Config,
  procedureName: string,
  target: SuiteTarget = 'service',
): Promise<ServiceSuiteOutcome> {
  const started = Date.now();
  const [procedure] = await db.select().from(procedures).where(eq(procedures.name, procedureName));
  if (procedure === undefined) throw new Error(`no procedure named ${procedureName}`);

  const cases = await db
    .select()
    .from(goldenTests)
    .where(eq(goldenTests.procedureId, procedure.id))
    .orderBy(asc(goldenTests.name));
  if (cases.length === 0) throw new Error(`${procedureName} has no golden tests — run \`make generate-oracles\` first`);

  const baseUrl = target === 'reference' ? config.pricingServiceUrl : config.generatedServiceUrl;

  // Only the generated service accepts an injected clock. The procedure cannot be pinned at all
  // — `GETDATE()` is not overridable inside T-SQL — and M5's reference reads the database clock
  // by design, because a replacement reading a different clock than the thing it replaces
  // produces differences that are about the network rather than about the code.
  const pinned = target === 'service';
  const writeTables = await writeTablesFor(db, procedure.id);

  // `probe` so the gate can tell a control apart from the real thing, and so a deliberately
  // red run never looks like a regression on the procedure screen.
  const kind = target === 'service' ? 'verify' : 'probe';
  const [run] = await db
    .insert(oracleRuns)
    .values({ procedureId: procedure.id, kind, target: target === 'procedure_on_shadow' ? 'procedure' : 'service' })
    .returning({ id: oracleRuns.id });

  let passed = 0;
  let failed = 0;
  const failures: { name: string; detail: string }[] = [];

  for (const test of cases) {
    const baseline = (test.baselineContext ?? {}) as BaselineContext;

    // Before every case, and before any pool is open: RESTORE needs exclusive access and does
    // not fail without it, it waits.
    await releaseService(config.pricingServiceUrl);
    await releaseService(config.generatedServiceUrl);
    await revertShadow(config);

    // max 1, min 1: every statement must land on the same session, because the before/after
    // fingerprints live in temp tables and a pool would scatter them across connections.
    const pool = await new sql.ConnectionPool({
      server: config.mssql.server,
      port: config.mssql.port,
      database: config.mssql.shadowDatabase,
      user: config.mssql.runnerUser,
      password: config.mssql.runnerPassword,
      options: { encrypt: true, trustServerCertificate: true, requestTimeout: 120_000 },
      pool: { max: 1, min: 1, idleTimeoutMillis: 30_000 },
    }).connect();

    const caseStarted = Date.now();
    let outcome: ExecutionOutcome | null = null;
    let error: string | null = null;

    try {
      const primaryKeys = await readPrimaryKeys(pool);
      const identityColumns = await readIdentityColumns(pool);

      outcome = await watchWrites({
        newRequest: () => pool.request(),
        writeTables,
        primaryKeys,
        invoke: async () => {
          if (target === 'procedure_on_shadow') {
            const call = pool.request();
            const { readParameters, bindParameters } = await import('../oracle/execute.js');
            bindParameters(call, await readParameters(pool, procedureName), test.inputParams as Record<string, unknown>);
            return ((await call.execute(`dbo.${procedureName}`)).recordsets ?? []) as unknown as unknown[][];
          }

          const response = await fetch(`${baseUrl}/replay/${procedureName}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              // The pin. Only here, never in the shadow harness.
              ...(pinned && baseline.getdate !== undefined ? { 'x-parity-now': baseline.getdate } : {}),
            },
            body: JSON.stringify(test.inputParams),
          });
          const body = (await response.json()) as { resultSets?: unknown[][]; error?: string };
          if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
          return body.resultSets ?? [];
        },
      });

      // Canonicalise against the window whose clock the target actually read.
      //
      // Only the generated service honours `x-parity-now`, so only it wrote the baseline's
      // instant and only it may be normalised against the baseline's window. The procedure
      // reads `GETDATE()` and the M5 reference reads the database clock, so both wrote *now*
      // and must be normalised against now — handed the baseline's window they produce
      // `<clock+970s>` where the expectation says `<clock>`, and every case fails on a field
      // that is normalised away on both sides.
      //
      // This was invisible until `baseline_context` was populated: with the column empty the
      // code fell through to `outcome.clockWindow` and was accidentally right for two of the
      // three targets.
      const canonical = canonicalise(outcome, {
        clockWindow: pinned ? (baseline.clockWindow ?? outcome.clockWindow) : outcome.clockWindow,
        identityColumns,
      });

      const actual = fingerprint(canonical);
      const wanted = stableKey({ resultSets: test.expectedResult, writeSet: test.expectedWriteSet });

      if (actual === wanted) passed += 1;
      else {
        failed += 1;
        failures.push({ name: test.name, detail: firstDifference(wanted, actual) });
      }

      await db
        .insert(goldenResults)
        .values({
          oracleRunId: run.id,
          goldenTestId: test.id,
          status: actual === wanted ? 'pass' : 'fail',
          detail: actual === wanted ? null : firstDifference(wanted, actual),
          durationMs: Date.now() - caseStarted,
        })
        .onConflictDoNothing();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      failed += 1;
      failures.push({ name: test.name, detail: error });
      await db
        .insert(goldenResults)
        .values({
          oracleRunId: run.id,
          goldenTestId: test.id,
          status: 'error',
          detail: error,
          durationMs: Date.now() - caseStarted,
        })
        .onConflictDoNothing();
    } finally {
      await pool.close();
    }
  }

  // The shadow database is left as it was found, so the state a human inspects afterwards is
  // the state the run started from rather than whatever the last case happened to leave.
  await releaseService(config.pricingServiceUrl);
  await releaseService(config.generatedServiceUrl);
  await revertShadow(config);

  const durationMs = Date.now() - started;
  await db
    .update(oracleRuns)
    .set({ goldenPassed: passed, goldenFailed: failed, durationMs, finishedAt: new Date() })
    .where(eq(oracleRuns.id, run.id));

  return { oracleRunId: run.id, target, passed, failed, failures, durationMs };
}

/** The first field that differs, so a failure names a column rather than a hash. */
function firstDifference(expected: string, actual: string): string {
  const limit = Math.min(expected.length, actual.length);
  let at = 0;
  while (at < limit && expected[at] === actual[at]) at += 1;
  const from = Math.max(0, at - 60);
  return `at ${at}: expected …${expected.slice(from, at + 60)}… got …${actual.slice(from, at + 60)}…`;
}
