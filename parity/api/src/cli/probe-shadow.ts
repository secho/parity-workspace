/**
 * The negative control for the shadow harness.
 *
 * `verify-m4` refuses a green golden suite without `probe-oracle`, and the reason applies
 * here with more force: a diff engine that reports nothing is indistinguishable from a diff
 * engine that cannot see anything. Both halves have to be demonstrated.
 *
 * 1. **A/A.** Replay the procedure against *itself*, both passes, from the same restored
 *    state. Every difference must be resolved by canonicalisation; **nothing may survive**.
 *    A harness that invents findings fails here — and so does one whose canonicalisation is
 *    too weak, because the clock moves between the two passes and nothing else does.
 *
 *    This doubles as the determinism check. Two independent executions of the same procedure
 *    producing identical canonical fingerprints is exactly the property that makes comparing
 *    two *different* implementations meaningful.
 *
 * 2. **One-unit perturbation.** Take an outcome the A/A run just proved identical, add one to
 *    a single money value, and diff again. Exactly that column must surface, as a surviving
 *    difference rather than noise. Then confirm the unperturbed pair is still clean.
 *
 * 3. **Case selection is stable.** Select twice, compare. The replay set is the first place
 *    hard rule 5 can quietly stop being true.
 *
 * No model calls, so the gate can afford to run it every time.
 */

import { loadConfig } from '../env.js';
import { connect } from '../ingest/mssql.js';
import { readIdentityColumns, readParameters, type RowImage } from '../oracle/execute.js';
import { selectCases } from '../shadow/cases.js';
import { readColumns, readTrackedTables } from '../shadow/changetracking.js';
import { connectShadowRunner, revertShadow, shadowReadiness } from '../shadow/database.js';
import { diffCase, findings } from '../shadow/diff.js';
import { releaseService, replayProcedure, replayService, serviceHealth, type ReplayOutcome } from '../shadow/replay.js';

const PROC = process.argv[2] ?? 'sp_CalculateOrderTotal';
const LIMIT = Number(process.argv[3] ?? 120);

/** Columns worth perturbing: the ones a wrong answer would actually be wrong about. */
const MONEY = ['TotalWithVat', 'TotalNet', 'TotalVat', 'DiscountAmount'];

const config = loadConfig();

const readiness = await shadowReadiness(config);
if (!readiness.ready) {
  console.log(JSON.stringify({ error: readiness.reason }));
  process.exit(1);
}

const estate = await connect(config);
const first = await selectCases(estate, PROC, LIMIT);
const second = await selectCases(estate, PROC, LIMIT);
await estate.close();

const ids = (selection: typeof first): string => selection.cases.map((c) => c.invocationId).join(',');
const selectionStable = ids(first) === ids(second);

let pool = await connectShadowRunner(config);
const parameters = await readParameters(pool, PROC);
const identityColumns = await readIdentityColumns(pool);
const context = { tracked: await readTrackedTables(pool), columns: await readColumns(pool) };
await pool.close();

const reset = async (): Promise<void> => {
  // Both, not just the reference. Once the generated container has served this procedure it
  // holds a pool, and RESTORE waits on an open connection rather than failing — so missing one
  // does not produce an error, it produces a probe that hangs forever.
  await releaseService(config.pricingServiceUrl);
  await releaseService(config.generatedServiceUrl);
  await revertShadow(config);
};

await reset();
pool = await connectShadowRunner(config);
const passA = await replayProcedure(pool, PROC, parameters, first.cases, context);
await pool.close();

await reset();
pool = await connectShadowRunner(config);
const passB = await replayProcedure(pool, PROC, parameters, first.cases, context);
await pool.close();
await reset();

// --- 1. A/A -----------------------------------------------------------------
const aa = first.cases.map((c, index) => ({
  seq: index,
  sourceInvocationId: c.invocationId,
  diff: diffCase(passA[index], passB[index], { identityColumns }),
}));

const rawDiffs = aa.reduce((n, entry) => n + entry.diff.diffs.length, 0);
const surviving = aa.flatMap((entry) => entry.diff.diffs).filter((d) => !d.canonicalEqual);
const aaFindings = findings(aa);

// --- 2. one-unit perturbation ------------------------------------------------
// Find a case whose write set carries a money column, and add one to it. `structuredClone`
// so the untouched original is still available to prove the harness goes green again.
let perturbation: Record<string, unknown> = { attempted: false };

for (const [index, entry] of aa.entries()) {
  if (perturbation.attempted === true) break;
  for (const [table, images] of Object.entries(passB[index].writeSet)) {
    const rowIndex = images.findIndex(
      (image) => image.row !== null && MONEY.some((c) => typeof image.row?.[c] === 'number'),
    );
    if (rowIndex === -1) continue;

    const column = MONEY.find((c) => typeof images[rowIndex].row?.[c] === 'number')!;
    const before = images[rowIndex].row?.[column] as number;

    const corrupted: ReplayOutcome = {
      ...passB[index],
      writeSet: Object.fromEntries(
        Object.entries(passB[index].writeSet).map(([t, rows]) => [
          t,
          rows.map((image, i): RowImage =>
            t === table && i === rowIndex && image.row !== null
              ? { ...image, row: { ...image.row, [column]: before + 1 } }
              : image,
          ),
        ]),
      ),
    };

    const corruptedDiff = diffCase(passA[index], corrupted, { identityColumns });
    const detected = corruptedDiff.diffs.filter((d) => !d.canonicalEqual);

    perturbation = {
      attempted: true,
      scope: 'write_set',
      seq: entry.seq,
      sourceInvocationId: entry.sourceInvocationId,
      table,
      column,
      before,
      after: before + 1,
      detected: detected.length,
      signatures: detected.map((d) => d.signature),
      // The unperturbed pair, re-diffed, must still be clean. Without this the probe would
      // pass on a diff engine that reports everything.
      cleanAgain: diffCase(passA[index], passB[index], { identityColumns }).diffs.every((d) => d.canonicalEqual),
    };
    break;
  }
}

/**
 * The same control, for a procedure that writes nothing.
 *
 * `sp_GetCartSummary` produces its answer entirely in result sets, so the write-set loop above
 * finds nothing to corrupt and reports `attempted: false` — which reads exactly like a pass and
 * is the failure this whole probe exists to prevent. The output is in a different place, so the
 * perturbation goes in a different place; the claim being tested is unchanged.
 */
if (perturbation.attempted !== true) {
  for (const [index, entry] of aa.entries()) {
    if (perturbation.attempted === true) break;
    const sets = passB[index].resultSets;

    for (const [setIndex, rows] of sets.entries()) {
      const rowIndex = rows.findIndex(
        (row) => row !== null && typeof row === 'object' && Object.values(row as object).some((v) => typeof v === 'number'),
      );
      if (rowIndex === -1) continue;

      const row = rows[rowIndex] as Record<string, unknown>;
      const column = Object.keys(row).find((k) => typeof row[k] === 'number')!;
      const before = row[column] as number;

      const corrupted: ReplayOutcome = {
        ...passB[index],
        resultSets: sets.map((set, i) =>
          i !== setIndex ? set : set.map((r, j) => (j === rowIndex ? { ...(r as object), [column]: before + 1 } : r)),
        ),
      };

      const corruptedDiff = diffCase(passA[index], corrupted, { identityColumns });
      const detected = corruptedDiff.diffs.filter((d) => !d.canonicalEqual);

      perturbation = {
        attempted: true,
        scope: 'result_set',
        seq: entry.seq,
        sourceInvocationId: entry.sourceInvocationId,
        table: `rs${setIndex}`,
        column,
        before,
        after: before + 1,
        detected: detected.length,
        signatures: detected.map((d) => d.signature),
        cleanAgain: diffCase(passA[index], passB[index], { identityColumns }).diffs.every((d) => d.canonicalEqual),
      };
      break;
    }
  }
}

// --- 3. the result-set path -------------------------------------------------
//
// `SPEC.md` §4 asks for result-set **and** write-set diffing. The migration target has no
// result set — it reads into variables and updates `OrderLedger`, so its recordsets are empty
// on every call and the write set is its whole output. That leaves the result-set half of the
// engine exercised only trivially by everything above, which is the same as not exercised.
//
// So it is driven directly, the way `probe-oracle` corrupts a stored expectation: two real
// outcomes, one given a recordset the other does not have. Nothing here reaches the UI or the
// estate — it is a probe proving a code path can fail, not data pretending to be a result.
const withRows = (outcome: ReplayOutcome, rows: unknown[][]): ReplayOutcome => ({ ...outcome, resultSets: rows });
const resultSetProbe = {
  differingRows: diffCase(
    withRows(passA[0], [[{ ProductID: 1, Name: 'a' }]]),
    withRows(passB[0], [[{ ProductID: 1, Name: 'b' }]]),
    { identityColumns },
  ).diffs.filter((d) => d.scope === 'result_set' && !d.canonicalEqual).length,
  // Same rows in a different sequence must NOT differ: the canonicaliser sorts, because this
  // estate is deliberately full of ORDER BY branches with no secondary key.
  reorderedIsQuiet:
    diffCase(
      withRows(passA[0], [[{ ProductID: 1 }, { ProductID: 2 }]]),
      withRows(passB[0], [[{ ProductID: 2 }, { ProductID: 1 }]]),
      { identityColumns },
    ).diffs.filter((d) => d.scope === 'result_set' && !d.canonicalEqual).length === 0,
  identicalIsQuiet:
    diffCase(withRows(passA[0], [[{ ProductID: 1 }]]), withRows(passB[0], [[{ ProductID: 1 }]]), { identityColumns })
      .diffs.filter((d) => d.scope === 'result_set').length === 0,
};

// --- 4. the shape of what came back, on both implementations ------------------
//
// `sp_GetCartSummary` is claimed to be a pure read that answers in two result sets. Both halves
// of that are measurable rather than assertable, and neither can be read back out of
// `shadow_cases`: outcomes are stored only for cases that DIFFER, so an all-green run keeps
// nothing but fingerprints. So the shapes are counted here, where the outcomes are in hand.
//
// The service pass is what makes "on both sides" true. Without it this measures the procedure
// twice and says nothing at all about the replacement — which is the half that matters, because
// a replacement that quietly wrote something would be the finding of the whole milestone.
const shapeOf = (outcomes: ReplayOutcome[]): Record<string, number> => ({
  cases: outcomes.length,
  minResultSets: Math.min(...outcomes.map((o) => o.resultSets.length)),
  maxResultSets: Math.max(...outcomes.map((o) => o.resultSets.length)),
  writtenRows: outcomes.reduce(
    (sum, o) => sum + Object.values(o.writeSet).reduce((n, images) => n + images.length, 0),
    0,
  ),
  errors: outcomes.filter((o) => o.error !== null).length,
});

const health = await serviceHealth(config.generatedServiceUrl);
const served = health?.procedures?.includes(PROC) === true && health.database === config.mssql.shadowDatabase;

let servicePass: Record<string, number> | null = null;
if (served) {
  await reset();
  pool = await connectShadowRunner(config);
  const passC = await replayService(pool, config.generatedServiceUrl, PROC, first.cases, context);
  await pool.close();
  await reset();
  servicePass = shapeOf(passC);
}

console.log(
  JSON.stringify(
    {
      procedure: PROC,
      cases: first.cases.length,
      strata: first.strata,
      selectionStable,
      resultSetProbe,
      shape: { procedure: shapeOf(passA), procedureAgain: shapeOf(passB), service: servicePass, serviceServes: served },
      aa: {
        rawDiffs,
        surviving: surviving.length,
        findings: aaFindings.length,
        // Every case's canonical fingerprints matching is the determinism property itself.
        identicalCases: aa.filter((entry) => entry.diff.equal).length,
      },
      perturbation,
    },
    null,
    2,
  ),
);
