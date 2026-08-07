// What `verify-m7` shells out to for the section about the service shell serving two procedures
// without knowing either of them.
//
// Three claims, and the middle one is the one that used to be expensive to be wrong about:
//
//   1. `write_service_file` refuses what is not part of THIS procedure's service. The refusal is
//      per procedure from M7 — `sp_CalculateOrderTotal` has `pricing.ts` and `persist.ts`,
//      `sp_GetCartSummary` has `summary.ts` and no persist at all — so `pricing.ts` is allowed
//      for one and refused for the other. Exercised through the same function the tool calls,
//      not through a live model run.
//   2. A shadow run against a procedure the service does not serve refuses **before it writes
//      anything**. Without the pre-flight, every case returns 503 and the diff engine records
//      four hundred behavioural differences on a run whose status still reads `succeeded`.
//   3. An unserved name gets **503, not 404**, from the service itself: 404 means wrong URL and
//      503 means nothing to replay against, and a harness cannot tell a story about the second
//      if it is told the first.

import { sql } from 'drizzle-orm';
import { openStore, waitForPostgres } from '../db/client.js';
import { shadowCases, shadowRuns } from '../db/schema.js';
import { loadConfig } from '../env.js';
import { allowedPathsFor, serviceFileRefusal } from '../service/artifacts.js';
import { runShadow } from '../shadow/run.js';

const config = loadConfig();
const store = openStore(config.pgUrl);
await waitForPostgres(store.pool);

const counts = async (): Promise<{ runs: number; cases: number }> => {
  const [runs] = await store.db.select({ n: sql<number>`count(*)::int` }).from(shadowRuns);
  const [cases] = await store.db.select({ n: sql<number>`count(*)::int` }).from(shadowCases);
  return { runs: runs.n, cases: cases.n };
};

// --- 1 · the write allowlist, per procedure -------------------------------------------------
const trivial = 'export const x = 1;\n';
const paths = {
  calculateOrderTotal: [...allowedPathsFor('sp_CalculateOrderTotal')],
  getCartSummary: [...allowedPathsFor('sp_GetCartSummary')],
  refusals: {
    // The shell, for either procedure. Never writable — it is the harness's contract.
    indexForCalculate: serviceFileRefusal('sp_CalculateOrderTotal', 'index.ts', trivial),
    dbForSummary: serviceFileRefusal('sp_GetCartSummary', 'db.ts', trivial),
    // The one that only a per-procedure allowlist can get right: `pricing.ts` belongs to one
    // procedure's service and not to the other's.
    pricingForSummary: serviceFileRefusal('sp_GetCartSummary', 'pricing.ts', trivial),
    summaryForCalculate: serviceFileRefusal('sp_CalculateOrderTotal', 'summary.ts', trivial),
    foreignImport: serviceFileRefusal('sp_GetCartSummary', 'summary.ts', "import Decimal from 'decimal.js';\n"),
  },
  allowed: {
    pricingForCalculate: serviceFileRefusal('sp_CalculateOrderTotal', 'pricing.ts', trivial),
    persistForCalculate: serviceFileRefusal('sp_CalculateOrderTotal', 'persist.ts', trivial),
    summaryForSummary: serviceFileRefusal('sp_GetCartSummary', 'summary.ts', trivial),
  },
};

// --- 2 · a shadow run against something the service does not serve ---------------------------
const unserved = process.argv[2] ?? 'sp_ReserveStock';
const before = await counts();
let refusal: string | null = null;
try {
  await runShadow(store.db, config, { procedureName: unserved, implementation: 'generated', limit: 5 });
} catch (err) {
  refusal = err instanceof Error ? err.message : String(err);
}
const after = await counts();

// --- 3 · the service's own answers ----------------------------------------------------------
const ask = async (path: string): Promise<{ status: number; body: unknown }> => {
  const response = await fetch(`${config.generatedServiceUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ params: {} }),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

const health = (await fetch(`${config.generatedServiceUrl}/health`, { signal: AbortSignal.timeout(20_000) }).then((r) =>
  r.json(),
)) as { status: string; database: string; procedures: string[]; artifacts: Record<string, string> };

const nonsense = await ask('/replay/sp_Nonsense');

console.log(
  JSON.stringify(
    {
      health,
      unknownProcedure: { status: nonsense.status, body: nonsense.body },
      paths,
      unservedShadowRun: {
        procedure: unserved,
        refused: refusal !== null,
        message: refusal,
        // Nothing written: the membership pre-flight runs before the `shadow_runs` insert, so a
        // refused run leaves no row at all — not a failed one, and certainly not cases.
        runsBefore: before.runs,
        runsAfter: after.runs,
        casesBefore: before.cases,
        casesAfter: after.cases,
      },
    },
    null,
    2,
  ),
);

await store.pool.end();
