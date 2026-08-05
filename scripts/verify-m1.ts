// M1 acceptance. `make verify-m1` is the definition of done.
//
// Runs against a database that has had `make seed && make traffic`.
//
// The determinism check reseeds and regenerates traffic a second time, so a full run
// takes several minutes. VERIFY_FAST=1 skips that second cycle and compares only against
// the committed fingerprint.

import sql from 'mssql';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FINGERPRINT_PATH = join(ROOT, 'scripts', 'traffic-checksum.json');

const DEMO_EPOCH = new Date('2026-08-05T00:00:00.000Z');
const HISTORY_DAYS = 90;

/**
 * verify-m1 issues one live probe call of its own for the replay check. That row has a
 * real timestamp (outside the 90-day simulated window) and would otherwise bump the
 * fingerprint on every run, so the script would not be idempotent and would fail its own
 * determinism assertion. A gate must not perturb what it measures.
 */
const NOT_VERIFY = "WHERE (CallerContext IS NULL OR CallerContext NOT LIKE 'verify:%')";

const LIVE_PROCEDURES = [
  'sp_SearchProducts', 'sp_GetProductDetail', 'sp_GetProductAvailability', 'sp_GetCartSummary',
  'sp_CalculateOrderTotal', 'sp_ApplyPromoCode', 'sp_ReserveStock', 'sp_PlaceOrder',
  'sp_SyncWarehouseDispatch', 'sp_RecalculateCustomerScore', 'sp_LegacyPriceImport_v2',
];
const DEAD_PROCEDURES = ['sp_ExportCatalogXml_OLD', 'sp_MigrateCustomerAddresses', 'sp_RecomputeLoyaltyTier_deprecated'];
const WRITE_CAPABLE = [
  'sp_CalculateOrderTotal', 'sp_ApplyPromoCode', 'sp_ReserveStock', 'sp_PlaceOrder',
  'sp_SyncWarehouseDispatch', 'sp_RecalculateCustomerScore', 'sp_LegacyPriceImport_v2',
];
const READ_ONLY = ['sp_SearchProducts', 'sp_GetProductDetail', 'sp_GetProductAvailability', 'sp_GetCartSummary'];
const RARE_BRANCHES = ['leap-day', 'negative-stock', 'slovak-vat', 'stacked-promo', 'forty-lines'];

let failures = 0;
let checks = 0;

function check(ok: boolean, label: string, detail = ''): void {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
}
const section = (t: string): void => console.log(`\n${t}`);

/** Must match monolith/src/capture/index.ts exactly, or the replay hash can never agree. */
function canonicalise(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v instanceof Date) return v.toISOString();
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
}

const connect = (): Promise<sql.ConnectionPool> =>
  new sql.ConnectionPool({
    server: process.env.MSSQL_HOST ?? 'localhost',
    port: Number(process.env.MSSQL_PORT ?? 1433),
    database: 'ParityShop',
    user: 'sa',
    password: process.env.MSSQL_SA_PASSWORD ?? 'ParityShop_Dev_2026!',
    options: { encrypt: true, trustServerCertificate: true, requestTimeout: 120_000 },
  }).connect();

/** Everything the determinism check compares. Deliberately excludes durations, GUIDs and
 *  identity values, which legitimately differ between runs. */
export interface Fingerprint {
  totalInvocations: number;
  perProcedure: Record<string, number>;
  branchKeys: number;
  rareBranches: Record<string, number>;
  distinctDays: number;
}

async function fingerprint(pool: sql.ConnectionPool): Promise<Fingerprint> {
  const q = async <T>(text: string): Promise<T[]> => (await pool.request().query(text)).recordset as T[];

  const perProc = await q<{ ProcName: string; n: number }>(
    `SELECT ProcName, COUNT(*) AS n FROM parity_capture.Invocation ${NOT_VERIFY} GROUP BY ProcName`,
  );
  const rare = await q<{ CallerContext: string; n: number }>(
    `SELECT CallerContext, COUNT(*) AS n FROM parity_capture.Invocation
     WHERE CallerContext LIKE 'traffic:%' GROUP BY CallerContext`,
  );
  const [totals] = await q<{ total: number; branches: number; days: number }>(`
    SELECT COUNT(*) AS total,
           COUNT(DISTINCT BranchKey) AS branches,
           COUNT(DISTINCT CAST(CalledAt AS DATE)) AS days
    FROM parity_capture.Invocation ${NOT_VERIFY}`);

  return {
    totalInvocations: Number(totals.total),
    perProcedure: Object.fromEntries(perProc.map((r) => [r.ProcName, Number(r.n)]).sort(([a], [b]) => String(a).localeCompare(String(b)))),
    branchKeys: Number(totals.branches),
    rareBranches: Object.fromEntries(rare.map((r) => [r.CallerContext.replace('traffic:', ''), Number(r.n)]).sort(([a], [b]) => String(a).localeCompare(String(b)))),
    distinctDays: Number(totals.days),
  };
}

async function main(): Promise<void> {
  console.log('M1 acceptance — capture and traffic');

  // The recorder batches rows in the monolith's memory. Counting before it has drained
  // reads a moving target — an earlier run of this script undercounted
  // sp_CalculateOrderTotal by 390 rows for exactly that reason.
  const apiPort = process.env.SHOP_API_PORT ?? 3100;
  try {
    await fetch(`http://127.0.0.1:${apiPort}/api/_capture/flush`, { method: 'POST', signal: AbortSignal.timeout(30_000) });
  } catch {
    console.log('  (capture flush endpoint unreachable — counting what is already persisted)');
  }

  const pool = await connect();

  try {
    const q = async <T>(text: string): Promise<T[]> => (await pool.request().query(text)).recordset as T[];
    const scalar = async (text: string): Promise<number> => Number((await q<{ n: number }>(text))[0].n);

    // --- infrastructure ------------------------------------------------------
    section('Change Tracking and temporal history');
    // CAST to INT deliberately: is_track_columns_updated_on is a BIT, which the driver
    // hands back as a JS boolean, and `=== 1` silently fails on it.
    const tracked = await q<{ name: string; ct: number; cols: number; temporal: number }>(`
      SELECT t.name,
             CASE WHEN ct.object_id IS NULL THEN 0 ELSE 1 END AS ct,
             CAST(ISNULL(ct.is_track_columns_updated_on, 0) AS INT) AS cols,
             CASE WHEN t.temporal_type = 2 THEN 1 ELSE 0 END AS temporal
      FROM sys.tables t
      LEFT JOIN sys.change_tracking_tables ct ON ct.object_id = t.object_id
      WHERE SCHEMA_NAME(t.schema_id) = 'dbo'
        AND t.temporal_type <> 1
        -- SQL Server creates MSchange_tracking_history in dbo the first time change
        -- tracking auto-cleanup runs, so it only appears once traffic has been generated.
        AND t.name NOT LIKE 'MSchange_tracking%'`);
    check(tracked.length === 12, 'twelve tracked tables', `${tracked.length}`);
    check(tracked.every((t) => Number(t.ct) === 1), 'change tracking on every table',
      tracked.filter((t) => !Number(t.ct)).map((t) => t.name).join(', ') || 'all');
    check(tracked.every((t) => Number(t.cols) === 1), 'TRACK_COLUMNS_UPDATED on every table',
      tracked.filter((t) => !Number(t.cols)).map((t) => t.name).join(', ') || 'all');
    check(tracked.every((t) => Number(t.temporal) === 1), 'system versioning on every table',
      tracked.filter((t) => !Number(t.temporal)).map((t) => t.name).join(', ') || 'all');

    // --- capture completeness ------------------------------------------------
    section('Capture');
    const perProc = new Map(
      (await q<{ ProcName: string; n: number; sampled: number; writes: number; ctx: number; hash: number }>(`
        SELECT ProcName, COUNT(*) AS n,
               SUM(CAST(Sampled AS INT)) AS sampled,
               SUM(CASE WHEN WriteSet IS NOT NULL AND WriteSet <> '{}' THEN 1 ELSE 0 END) AS writes,
               SUM(CASE WHEN Context IS NOT NULL THEN 1 ELSE 0 END) AS ctx,
               SUM(CASE WHEN ResultSetHash IS NOT NULL THEN 1 ELSE 0 END) AS hash
        FROM parity_capture.Invocation GROUP BY ProcName`)).map((r) => [r.ProcName, r]),
    );

    const missing = LIVE_PROCEDURES.filter((p) => !perProc.has(p));
    check(missing.length === 0, 'every live procedure has capture rows', missing.length ? `missing ${missing.join(', ')}` : `${perProc.size} procedures`);

    const noWrites = WRITE_CAPABLE.filter((p) => (perProc.get(p)?.writes ?? 0) === 0);
    check(noWrites.length === 0, 'every write-capable procedure produced a write set', noWrites.join(', ') || 'all');

    const readWrote = READ_ONLY.filter((p) => (perProc.get(p)?.writes ?? 0) > 0);
    check(readWrote.length === 0, 'no pure_read procedure produced a write set', readWrote.join(', ') || 'none');

    const noHash = LIVE_PROCEDURES.filter((p) => { const r = perProc.get(p); return r && r.hash < r.n; });
    check(noHash.length === 0, 'every captured call has a result-set hash', noHash.join(', ') || 'all');

    const noCtx = LIVE_PROCEDURES.filter((p) => { const r = perProc.get(p); return r && r.ctx < r.sampled; });
    check(noCtx.length === 0, 'every sampled call recorded the ambient clock', noCtx.join(', ') || 'all');

    // SPEC §8's named acceptance for this milestone.
    const [reserve] = await q<{ tables: number; withValues: number }>(`
      SELECT TOP 1
        (SELECT COUNT(*) FROM OPENJSON(WriteSet)) AS tables,
        (SELECT COUNT(*) FROM OPENJSON(WriteSet)) AS withValues
      FROM parity_capture.Invocation
      WHERE ProcName = 'sp_ReserveStock' AND WriteSet IS NOT NULL
      ORDER BY (SELECT COUNT(*) FROM OPENJSON(WriteSet)) DESC`);
    check((reserve?.tables ?? 0) >= 4, 'sp_ReserveStock write set spans 4+ tables', `${reserve?.tables ?? 0} tables`);

    const beforeAfter = await q<{ WriteSet: string }>(`
      SELECT TOP 1 WriteSet FROM parity_capture.Invocation
      WHERE ProcName = 'sp_ReserveStock' AND WriteSet LIKE '%Catalog%' ORDER BY InvocationID`);
    let hasBoth = false;
    if (beforeAfter[0]) {
      const ws = JSON.parse(beforeAfter[0].WriteSet) as Record<string, { columns: { before: unknown; after: unknown }[] }[]>;
      hasBoth = Object.values(ws).flat().some((row) => row.columns.some((c) => c.before !== null && c.after !== null));
    }
    check(hasBoth, 'sp_ReserveStock write set carries non-null before AND after values');

    // --- dead procedures -----------------------------------------------------
    section('Dead procedures');
    for (const dead of DEAD_PROCEDURES) {
      const n = await scalar(`SELECT COUNT(*) AS n FROM parity_capture.Invocation WHERE ProcName = '${dead}'`);
      check(n === 0, `${dead} has exactly zero invocations`, `${n}`);
    }

    // --- sampling ------------------------------------------------------------
    section('Sampling policy');
    const calc = perProc.get('sp_CalculateOrderTotal');
    check((calc?.writes ?? 0) >= 2000, 'sp_CalculateOrderTotal has 2000+ captured write sets (M5 precondition)', `${calc?.writes ?? 0}`);

    const overSampled = LIVE_PROCEDURES.filter((p) => {
      const r = perProc.get(p);
      if (!r || p === 'sp_CalculateOrderTotal') return false;
      // first 200 in full, then 1-in-50, plus new-branch captures
      return r.sampled > 200 + Math.ceil(r.n / 50) + 200;
    });
    check(overSampled.length === 0, 'sampling honours the per-procedure policy', overSampled.join(', ') || 'within policy');

    const branchKeys = await scalar('SELECT COUNT(DISTINCT BranchKey) AS n FROM parity_capture.Invocation');
    const unsampledBranches = await scalar(`
      SELECT COUNT(*) AS n FROM (
        SELECT BranchKey FROM parity_capture.Invocation
        GROUP BY BranchKey HAVING SUM(CAST(Sampled AS INT)) = 0) x`);
    check(unsampledBranches === 0, 'every distinct branch was sampled at least once', `${branchKeys} branches, ${unsampledBranches} unsampled`);

    // --- distribution --------------------------------------------------------
    section('Distribution (SPEC §3)');
    const total = await scalar('SELECT COUNT(*) AS n FROM parity_capture.Invocation');
    const hot = (perProc.get('sp_GetProductAvailability')?.n ?? 0) + (perProc.get('sp_SearchProducts')?.n ?? 0);
    const share = hot / total;
    check(share >= 0.65 && share <= 0.75, 'availability + search take ~70% of calls', `${(share * 100).toFixed(1)}%`);

    const tailTooBig = WRITE_CAPABLE.filter((p) => (perProc.get(p)?.n ?? 0) > 10_000);
    check(tailTooBig.length === 0, 'tail procedures are in the hundreds/thousands, not millions', tailTooBig.join(', ') || 'ok');

    const priceImport = perProc.get('sp_LegacyPriceImport_v2')?.n ?? 0;
    check(priceImport === 4, 'sp_LegacyPriceImport_v2 called exactly 4 times — cold, not dead', `${priceImport}`);

    // --- window --------------------------------------------------------------
    section('90-day window');
    const [window] = await q<{ minAt: Date; maxAt: Date; days: number }>(
      `SELECT MIN(CalledAt) AS minAt, MAX(CalledAt) AS maxAt, COUNT(DISTINCT CAST(CalledAt AS DATE)) AS days FROM parity_capture.Invocation ${NOT_VERIFY}`,
    );
    const lowerBound = new Date(DEMO_EPOCH.getTime() - (HISTORY_DAYS + 1) * 86_400_000);
    check(window.minAt >= lowerBound && window.maxAt <= DEMO_EPOCH,
      'all invocations fall inside the 90-day window',
      `${window.minAt.toISOString().slice(0, 10)} .. ${window.maxAt.toISOString().slice(0, 10)}`);
    check(Number(window.days) >= 85, 'history spans ~90 distinct days', `${window.days} days`);

    // --- store bounded -------------------------------------------------------
    // SPEC §3: "Store bounded — the whole capture table stays under ~200 MB."
    section('Store bounded (SPEC §3)');
    const [size] = await q<{ mb: number }>(`
      SELECT CAST(SUM(a.total_pages) * 8.0 / 1024 AS DECIMAL(10,1)) AS mb
      FROM sys.tables t
      JOIN sys.indexes i      ON i.object_id = t.object_id
      JOIN sys.partitions p   ON p.object_id = t.object_id AND p.index_id = i.index_id
      JOIN sys.allocation_units a ON a.container_id = p.partition_id
      WHERE SCHEMA_NAME(t.schema_id) = 'parity_capture'`);
    check(Number(size.mb) < 200, 'capture table stays under 200 MB', `${size.mb} MB`);

    // --- rare branches -------------------------------------------------------
    // Presence is not enough: a rare branch that exists but was never SAMPLED has no
    // result set and no write set, so M4 and M5 cannot use it. Assert it was captured.
    section('Rare branches');
    for (const branch of RARE_BRANCHES) {
      const [row] = await q<{ n: number; sampled: number }>(
        `SELECT COUNT(*) AS n, SUM(CAST(Sampled AS INT)) AS sampled
         FROM parity_capture.Invocation WHERE CallerContext = 'traffic:${branch}'`,
      );
      check(Number(row.n) > 0 && Number(row.sampled) > 0, `rare branch captured: ${branch}`,
        `${row.n} invocations, ${row.sampled ?? 0} sampled`);
    }

    // --- pinned-clock replay -------------------------------------------------
    // Four procedures branch on wall-clock time. Replaying a captured invocation with
    // the recorded clock must reproduce the captured result, or the oracle is worthless.
    section('Pinned-clock replay');
    await replayCheck(pool, apiPort);

    // --- determinism ---------------------------------------------------------
    section('Determinism (hard rule 5)');
    const current = await fingerprint(pool);
    let committed: Fingerprint | null = null;
    try {
      committed = JSON.parse(await readFile(FINGERPRINT_PATH, 'utf8')) as Fingerprint;
    } catch {
      await writeFile(FINGERPRINT_PATH, `${JSON.stringify(current, null, 2)}\n`);
      console.log(`  (no committed fingerprint — wrote ${FINGERPRINT_PATH})`);
    }
    if (committed) {
      const same = JSON.stringify(committed) === JSON.stringify(current);
      check(same, 'traffic matches the committed fingerprint',
        same ? `${current.totalInvocations} invocations` : 'run `make traffic-checksum` if the change was intended');
    }

    if (process.env.VERIFY_FAST === '1') {
      console.log('  (VERIFY_FAST=1 — skipping the second seed+traffic cycle)');
    } else {
      console.log('  regenerating from scratch to compare two consecutive runs...');
      await pool.close();
      await exec('make', ['seed'], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
      await exec('make', ['traffic'], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
      const second = await connect();
      const again = await fingerprint(second);
      await second.close();
      const identical = JSON.stringify(current) === JSON.stringify(again);
      check(identical, 'two consecutive seed+traffic runs produce identical counts',
        identical ? `${again.totalInvocations} invocations both times` : firstDifference(current, again));
    }
  } finally {
    if (pool.connected) await pool.close();
  }

  console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}${checks - failures}/${checks} checks passed\x1b[0m`);
  if (failures > 0) {
    console.log('M1 is NOT done.');
    process.exit(1);
  }
  console.log('M1 acceptance green.');
}

function firstDifference(a: Fingerprint, b: Fingerprint): string {
  if (a.totalInvocations !== b.totalInvocations) return `total ${a.totalInvocations} vs ${b.totalInvocations}`;
  for (const key of Object.keys(a.perProcedure)) {
    if (a.perProcedure[key] !== b.perProcedure[key]) return `${key} ${a.perProcedure[key]} vs ${b.perProcedure[key]}`;
  }
  if (a.branchKeys !== b.branchKeys) return `branch keys ${a.branchKeys} vs ${b.branchKeys}`;
  if (a.distinctDays !== b.distinctDays) return `days ${a.distinctDays} vs ${b.distinctDays}`;
  return 'rare-branch counts differ';
}

/**
 * Replay a captured sp_CalculateOrderTotal invocation and check that it reproduces the
 * captured result exactly.
 *
 * The result being compared is the MONEY THE PROCEDURE WROTE, not its result set.
 * sp_CalculateOrderTotal contains no SELECT — it reads into variables and updates
 * OrderLedger — so its result set is always empty and its ResultSetHash is one constant
 * across every invocation (measured: 1 distinct hash across 2 363 rows). An assertion
 * against that hash is true by construction and cannot fail, which is worse than no
 * assertion at all. The written TotalNet / TotalVat / TotalWithVat / DiscountAmount are
 * the actual output, and they are what M5 will diff.
 *
 * GETDATE() cannot be overridden inside T-SQL without editing the estate, so "pinned
 * clock" here means: the recorded ambient clock is asserted to select the same side of
 * every time-dependent branch as the replay clock does — promo windows are days wide —
 * and under that condition the captured money is reproduced to the cent. The pin becomes
 * literal at M6, where the replacement service takes an injected clock.
 */
async function replayCheck(pool: sql.ConnectionPool, apiPort: string | number): Promise<void> {
  const MONEY = ['TotalNet', 'TotalVat', 'TotalWithVat', 'DiscountAmount'];

  // Capture and replay back to back against identical state. Reusing an older captured
  // invocation would be unsound: later traffic may have applied a promo to the same
  // order, so a difference would mean nothing.
  const fixture = (await pool.request().query(`
    SELECT TOP 1 o.OrderNumber
    FROM dbo.OrderLedger o JOIN dbo.Customer c ON c.CustomerID = o.CustomerID
    WHERE c.LoyaltyTier >= 3 AND o.CustomerCountryCode = 'CZ' AND o.TotalNet > 2500
    GROUP BY o.OrderNumber ORDER BY o.OrderNumber`)).recordset[0] as { OrderNumber: string } | undefined;

  if (!fixture) {
    check(false, 'a fixture order exists for the replay check');
    return;
  }

  // VERNY20 stacks with loyalty — the branch that carries the planted promo/VAT defect,
  // and the one whose behaviour depends on the clock.
  await fetch(`http://127.0.0.1:${apiPort}/api/orders/${fixture.OrderNumber}/total`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-parity-caller': 'verify:replay' },
    body: JSON.stringify({ promoCode: 'VERNY20' }),
    signal: AbortSignal.timeout(30_000),
  });
  await fetch(`http://127.0.0.1:${apiPort}/api/_capture/flush`, { method: 'POST', signal: AbortSignal.timeout(30_000) });

  const captured = (await pool.request().query(`
    SELECT TOP 1 InvocationID, InputParams, WriteSet, Context
    FROM parity_capture.Invocation
    WHERE ProcName = 'sp_CalculateOrderTotal' AND CallerContext = 'verify:replay' AND WriteSet IS NOT NULL
    ORDER BY InvocationID DESC`)).recordset[0] as
    { InvocationID: number; InputParams: string; WriteSet: string; Context: string } | undefined;

  if (!captured) {
    check(false, 'the replay probe was captured with a write set');
    return;
  }

  const context = JSON.parse(captured.Context) as { getdate: string };
  const writeSet = JSON.parse(captured.WriteSet) as Record<string, { pk: Record<string, unknown>; columns: { column: string; after: unknown }[] }[]>;

  const capturedMoney = new Map<string, Record<string, string>>();
  for (const row of writeSet.OrderLedger ?? []) {
    const money: Record<string, string> = {};
    for (const c of row.columns) if (MONEY.includes(c.column)) money[c.column] = String(c.after);
    if (Object.keys(money).length > 0) capturedMoney.set(String(row.pk.OrderLineID), money);
  }
  check(capturedMoney.size > 0, 'the captured write set contains the order totals it computed',
    `${capturedMoney.size} line rows`);

  const tx = pool.transaction();
  await tx.begin();
  try {
    // Same time-dependent regime? This is the precondition the pin rests on, and it is
    // exactly what stops holding if the demo runs after VERNY20 expires (2026-12-31).
    const regime = (await tx.request()
      .input('pinned', sql.DateTime2, new Date(context.getdate))
      .query(`SELECT
                SUM(CASE WHEN @pinned  BETWEEN ValidFrom AND ValidTo THEN 1 ELSE 0 END) AS atPinned,
                SUM(CASE WHEN GETDATE() BETWEEN ValidFrom AND ValidTo THEN 1 ELSE 0 END) AS atNow
              FROM dbo.PromoCode WHERE Code = 'VERNY20'`)).recordset[0] as { atPinned: number; atNow: number };
    check(Number(regime.atPinned) === Number(regime.atNow),
      'replay lands in the same promo-validity regime as the capture',
      `recorded clock ${context.getdate.slice(0, 10)}, VERNY20 valid=${Number(regime.atNow) > 0}`);

    const request = tx.request();
    request.input('OrderNumber', sql.NVarChar(20), fixture.OrderNumber);
    request.input('PromoCode', sql.NVarChar(40), 'VERNY20');
    request.input('ModifiedBy', sql.NVarChar(60), 'replay');
    await request.execute('sp_CalculateOrderTotal');

    const replayed = (await tx.request()
      .input('o', sql.NVarChar(20), fixture.OrderNumber)
      .query(`SELECT OrderLineID, ${MONEY.join(', ')} FROM dbo.OrderLedger WHERE OrderNumber = @o`))
      .recordset as Record<string, unknown>[];

    const mismatches: string[] = [];
    for (const row of replayed) {
      const expected = capturedMoney.get(String(row.OrderLineID));
      if (!expected) continue;
      for (const col of MONEY) {
        if (expected[col] === undefined) continue;
        if (String(row[col]) !== expected[col]) {
          mismatches.push(`line ${String(row.OrderLineID)} ${col}: captured ${expected[col]} vs replay ${String(row[col])}`);
        }
      }
    }

    check(
      mismatches.length === 0,
      'pinned-clock replay reproduces the captured money exactly',
      mismatches.length === 0
        ? `invocation #${captured.InvocationID}, ${capturedMoney.size} line rows compared to the cent`
        : mismatches.slice(0, 2).join('; '),
    );
  } finally {
    await tx.rollback();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
