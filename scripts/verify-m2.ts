// M2 acceptance. `make verify-m2` is the definition of done.
//
// Runs against a stack that has had `make seed && make traffic && make demo-reset`.
//
// The load-bearing check is "parser vs reality": M2's reads/writes are parsed out of
// T-SQL, and a parser that looks plausible and is wrong would poison every number
// downstream — a missing coupling edge looks exactly like an absent one. So the parse is
// graded against what M1 actually observed the estate write, not against itself.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mssql from 'mssql';
import pg from 'pg';

const exec = promisify(execFile);

const API = `http://127.0.0.1:${process.env.PARITY_API_PORT ?? 3200}`;
const PG_URL = process.env.PARITY_PG_URL ?? 'postgres://parity:parity@127.0.0.1:5433/parity';

const LIVE_PROCEDURES = [
  'sp_SearchProducts', 'sp_GetProductDetail', 'sp_GetProductAvailability', 'sp_GetCartSummary',
  'sp_CalculateOrderTotal', 'sp_ApplyPromoCode', 'sp_ReserveStock', 'sp_PlaceOrder',
  'sp_SyncWarehouseDispatch', 'sp_RecalculateCustomerScore', 'sp_LegacyPriceImport_v2',
];
const DEAD_PROCEDURES = ['sp_ExportCatalogXml_OLD', 'sp_MigrateCustomerAddresses', 'sp_RecomputeLoyaltyTier_deprecated'];

let failures = 0;
let checks = 0;

function check(ok: boolean, label: string, detail = ''): void {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
}
const section = (t: string): void => console.log(`\n${t}`);
const note = (t: string): void => console.log(`        \x1b[2m${t}\x1b[0m`);

const connectMssql = (): Promise<mssql.ConnectionPool> =>
  new mssql.ConnectionPool({
    server: process.env.MSSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MSSQL_PORT ?? 1433),
    database: 'ParityShop',
    user: 'sa',
    password: process.env.MSSQL_SA_PASSWORD ?? 'ParityShop_Dev_2026!',
    options: { encrypt: true, trustServerCertificate: true, requestTimeout: 120_000 },
  }).connect();

interface EstateResponse {
  totals: { procedures: number; deadProcedures: number; invocations90d: number; coverage: number; coverageByCount: number };
  blockers: { key: string; label: string; procedures: number }[];
  procedures: {
    name: string;
    lineCount: number;
    invocations90d: number;
    oracleClass: string | null;
    oracleState: string;
    campaignStatus: string;
    blocker: { key: string; label: string } | null;
  }[];
}

const getJson = async <T>(path: string): Promise<T> => {
  const response = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return (await response.json()) as T;
};

/** Everything the determinism check compares. Excludes ids and timestamps, which
 *  legitimately differ; includes every number the Estate screen shows. */
async function fingerprint(client: pg.Client): Promise<string> {
  const { rows } = await client.query(`
    SELECT
      (SELECT jsonb_agg(x ORDER BY x->>'name') FROM (
         SELECT jsonb_build_object('name', name, 'lines', line_count, 'inv', invocations_90d,
                                   'dyn', uses_dynamic_sql) AS x FROM procedures) s) AS procs,
      (SELECT jsonb_agg(x ORDER BY x->>'k') FROM (
         SELECT jsonb_build_object('k', p.name || ' ' || c.table_name || '.' || c.column_name || ' ' || c.access,
                                   'owner', c.is_write_owner, 'inf', c.inferred) AS x
         FROM procedure_columns c JOIN procedures p ON p.id = c.procedure_id) s) AS cols,
      (SELECT jsonb_agg(x ORDER BY x->>'k') FROM (
         SELECT jsonb_build_object('k', e.table_name || '.' || e.column_name || ' ' || a.name || ' ' || b.name) AS x
         FROM coupling_edges e JOIN procedures a ON a.id = e.a_procedure_id
                               JOIN procedures b ON b.id = e.b_procedure_id) s) AS edges,
      (SELECT jsonb_agg(x ORDER BY x->>'k') FROM (
         SELECT jsonb_build_object('k', a.name || ' -> ' || b.name) AS x
         FROM procedure_calls c JOIN procedures a ON a.id = c.caller_id
                                JOIN procedures b ON b.id = c.callee_id) s) AS calls`);
  return JSON.stringify(rows[0]);
}

async function main(): Promise<void> {
  console.log('M2 acceptance — estate ingestion');

  const client = new pg.Client({ connectionString: PG_URL });
  await client.connect();
  const sqlPool = await connectMssql();

  try {
    // --- 1. the stack is up ------------------------------------------------------
    section('Platform is up');
    const health = await getJson<{ status: string; procedures: number }>('/health');
    check(health.status === 'ok', 'parity-api healthy', `${health.procedures} procedures`);

    const estate = await getJson<EstateResponse>('/api/estate');
    check(estate.procedures.length > 0, 'GET /api/estate returns data');

    // --- 2. every procedure ingested with its source ------------------------------
    section('Estate ingested from MS SQL');
    check(estate.totals.procedures === 14, 'exactly 14 procedures ingested', `${estate.totals.procedures}`);

    const modules = (
      await sqlPool.request().query(`
        SELECT o.name AS name, m.definition AS definition
        FROM sys.sql_modules m JOIN sys.objects o ON o.object_id = m.object_id
        WHERE o.type = 'P'`)
    ).recordset as { name: string; definition: string }[];

    const ingested = new Map(estate.procedures.map((p) => [p.name, p]));
    const missing = modules.filter((m) => !ingested.has(m.name)).map((m) => m.name);
    check(missing.length === 0, 'every procedure in the estate is present', missing.join(', '));

    const { rows: sourceRows } = await client.query<{ name: string; len: number; line_count: number }>(
      'SELECT name, length(source_sql) AS len, line_count FROM procedures',
    );
    check(sourceRows.every((r) => r.len > 0), 'every procedure carries its source_sql');

    const lineMismatch = modules.filter((m) => {
      const row = sourceRows.find((r) => r.name === m.name);
      return row === undefined || row.line_count !== m.definition.split('\n').length;
    });
    check(lineMismatch.length === 0, 'line counts match sys.sql_modules', lineMismatch.map((m) => m.name).join(', '));

    // --- 3. invocation counts match the capture -----------------------------------
    section('Invocation counts match parity_capture');
    const live = (
      await sqlPool.request().query(`
        SELECT ProcName AS name, COUNT(*) AS n
        FROM parity_capture.Invocation
        WHERE (CallerContext IS NULL OR CallerContext NOT LIKE 'verify:%')
        GROUP BY ProcName`)
    ).recordset as { name: string; n: number }[];
    const liveCounts = new Map(live.map((r) => [r.name, Number(r.n)]));

    const countMismatch = estate.procedures.filter((p) => p.invocations90d !== (liveCounts.get(p.name) ?? 0));
    check(
      countMismatch.length === 0,
      'per-procedure counts equal a live COUNT(*)',
      countMismatch.map((p) => `${p.name}: ${p.invocations90d} vs ${liveCounts.get(p.name) ?? 0}`).join('; '),
    );

    const deadNonZero = DEAD_PROCEDURES.filter((n) => (ingested.get(n)?.invocations90d ?? -1) !== 0);
    check(deadNonZero.length === 0, 'the 3 dead procedures show exactly zero invocations', deadNonZero.join(', '));

    const liveZero = LIVE_PROCEDURES.filter((n) => (ingested.get(n)?.invocations90d ?? 0) === 0);
    check(liveZero.length === 0, 'all 11 live procedures show traffic', liveZero.join(', '));
    check(estate.totals.invocations90d > 40_000, 'total invocations over 40 000', `${estate.totals.invocations90d}`);

    // --- 4. the parser, graded against what the estate actually did ---------------
    section('Parsed writes vs captured write sets');

    // An IDENTITY value is written by the engine and named nowhere in the source, so the
    // parser cannot see it and should not pretend to. Excluded from the comparison.
    const identity = new Set(
      (
        (
          await sqlPool.request().query(`
            SELECT t.name AS t, c.name AS c FROM sys.identity_columns c
            JOIN sys.tables t ON t.object_id = c.object_id WHERE SCHEMA_NAME(t.schema_id) = 'dbo'`)
        ).recordset as { t: string; c: string }[]
      ).map((r) => `${r.t}.${r.c}`),
    );

    const { rows: writeRows } = await client.query<{ name: string; col: string }>(`
      SELECT p.name, c.table_name || '.' || c.column_name AS col
      FROM procedure_columns c JOIN procedures p ON p.id = c.procedure_id
      WHERE c.access = 'write'`);
    const parsedWrites = new Map<string, Set<string>>();
    for (const row of writeRows) parsedWrites.set(row.name, (parsedWrites.get(row.name) ?? new Set()).add(row.col));

    const { rows: callRows } = await client.query<{ caller: string; callee: string }>(`
      SELECT a.name AS caller, b.name AS callee FROM procedure_calls c
      JOIN procedures a ON a.id = c.caller_id JOIN procedures b ON b.id = c.callee_id`);
    const callees = new Map<string, string[]>();
    for (const row of callRows) callees.set(row.caller, [...(callees.get(row.caller) ?? []), row.callee]);
    check(
      (callees.get('sp_PlaceOrder') ?? []).length === 3,
      'sp_PlaceOrder is recorded as orchestrating three procedures',
      (callees.get('sp_PlaceOrder') ?? []).join(', '),
    );

    /** sp_PlaceOrder EXECs three others, so its captured write set legitimately contains
     *  theirs. Without the call graph that looks like 34 parser gaps. */
    const effectiveWrites = (proc: string, seen = new Set<string>()): Set<string> => {
      if (seen.has(proc)) return new Set();
      seen.add(proc);
      const out = new Set(parsedWrites.get(proc) ?? []);
      for (const callee of callees.get(proc) ?? []) for (const c of effectiveWrites(callee, seen)) out.add(c);
      return out;
    };

    const captured = (
      await sqlPool.request().query(`
        SELECT ProcName AS name, WriteSet AS ws FROM parity_capture.Invocation
        WHERE Sampled = 1 AND WriteSet IS NOT NULL AND WriteSet <> '{}'
          AND (CallerContext IS NULL OR CallerContext NOT LIKE 'verify:%')`)
    ).recordset as { name: string; ws: string }[];
    check(captured.length > 0, 'captured write sets are available to grade against', `${captured.length} sampled calls`);

    const observed = new Map<string, Map<string, number>>();
    for (const row of captured) {
      const parsedWs = JSON.parse(row.ws) as Record<string, { columns: { column: string }[] }[]>;
      const counts = observed.get(row.name) ?? new Map<string, number>();
      for (const [table, rows] of Object.entries(parsedWs)) {
        const shortTable = table.split('.').pop()!;
        for (const r of rows) for (const c of r.columns) {
          const key = `${shortTable}.${c.column}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      observed.set(row.name, counts);
    }

    const everyWriter = new Set([...parsedWrites.values()].flatMap((s) => [...s]));
    const hardGaps: string[] = [];
    const explainable: string[] = [];

    for (const [proc, counts] of observed) {
      const declared = effectiveWrites(proc);
      for (const [column, seenIn] of counts) {
        if (declared.has(column) || identity.has(column)) continue;
        // A column observed once, which some OTHER procedure in the estate writes, is a
        // concurrent write that landed inside this call's Change Tracking version window
        // — M1 documents that the window absorbs one. A column nothing writes, or one
        // observed repeatedly, is a parser gap and must fail.
        if (seenIn === 1 && everyWriter.has(column)) explainable.push(`${proc}: ${column}`);
        else hardGaps.push(`${proc}: ${column} (in ${seenIn} captures)`);
      }
    }

    check(hardGaps.length === 0, 'every observed write is covered by the parse', hardGaps.join('; '));
    if (explainable.length > 0) {
      note(`${explainable.length} single-observation residue, explainable as a concurrent write in the CT window:`);
      for (const entry of explainable) note(`  ${entry}`);
    }
    check(explainable.length <= 3, 'CT-window residue stays negligible', `${explainable.length} of ${captured.length} captures`);

    // --- 5. the coupling graph ---------------------------------------------------
    section('Data-coupling graph');
    const { rows: writerRows } = await client.query<{ table_name: string; writers: number }>(`
      SELECT table_name, COUNT(DISTINCT procedure_id)::int AS writers
      FROM procedure_columns WHERE access = 'write' GROUP BY table_name`);
    const writersOf = new Map(writerRows.map((r) => [r.table_name, r.writers]));
    check((writersOf.get('Catalog') ?? 0) >= 6, 'Catalog is written by 6+ procedures (SPEC §3)', `${writersOf.get('Catalog') ?? 0}`);
    check((writersOf.get('OrderLedger') ?? 0) >= 5, 'OrderLedger is written by 5+ procedures (SPEC §3)', `${writersOf.get('OrderLedger') ?? 0}`);

    const { rows: sharedRows } = await client.query<{ n: number }>(`
      SELECT COUNT(*)::int AS n FROM (
        SELECT table_name, column_name FROM procedure_columns
        WHERE access = 'write' AND column_name <> '*'
        GROUP BY table_name, column_name HAVING COUNT(DISTINCT procedure_id) >= 2) s`);
    check(sharedRows[0].n >= 16, 'at least 16 columns are written by 2+ procedures', `${sharedRows[0].n} shared`);

    const { rows: edgeRows } = await client.query<{ table_name: string; column_name: string; a: string; b: string }>(`
      SELECT e.table_name, e.column_name, a.name AS a, b.name AS b
      FROM coupling_edges e JOIN procedures a ON a.id = e.a_procedure_id
                            JOIN procedures b ON b.id = e.b_procedure_id`);
    const hasEdge = (column: string, x: string, y: string): boolean =>
      edgeRows.some(
        (e) =>
          `${e.table_name}.${e.column_name}` === column &&
          ((e.a === x && e.b === y) || (e.a === y && e.b === x)),
      );

    // The sharpest coupling in the estate: a quarterly import and a live promo procedure
    // fighting over the same Catalog columns, neither calling the other.
    check(
      ['Catalog.PriceWithDiscount', 'Catalog.DiscountPct'].some((c) =>
        hasEdge(c, 'sp_ApplyPromoCode', 'sp_LegacyPriceImport_v2'),
      ),
      'sp_ApplyPromoCode ↔ sp_LegacyPriceImport_v2 on Catalog price columns',
    );
    // A dead procedure still writing columns a hot one owns — what makes the phase-0
    // deletion campaign worth watching rather than trivial.
    check(
      ['OrderLedger.ShipStreet', 'OrderLedger.CustomerEmailSnapshot'].some((c) =>
        hasEdge(c, 'sp_PlaceOrder', 'sp_MigrateCustomerAddresses'),
      ),
      'dead sp_MigrateCustomerAddresses ↔ hot sp_PlaceOrder on OrderLedger',
    );

    const { rows: ownerRows } = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM (
         SELECT table_name, column_name FROM procedure_columns
         WHERE access = 'write' AND is_write_owner GROUP BY table_name, column_name
         HAVING COUNT(*) > 1) s`,
    );
    check(ownerRows[0].n === 0, 'every written column has exactly one write_owner', `${ownerRows[0].n} contested`);

    // sp_SearchProducts is built entirely from dynamic SQL. Reporting it as touching
    // nothing would be a lie about ~29% of all traffic.
    const { rows: dynRows } = await client.query<{ name: string; reads: number }>(`
      SELECT p.name, COUNT(*)::int AS reads FROM procedures p
      JOIN procedure_columns c ON c.procedure_id = p.id AND c.access = 'read'
      WHERE p.uses_dynamic_sql GROUP BY p.name`);
    check(
      dynRows.some((r) => r.name === 'sp_SearchProducts' && r.reads >= 10),
      'dynamic SQL in sp_SearchProducts is parsed, not skipped',
      dynRows.map((r) => `${r.name}: ${r.reads} columns`).join(', '),
    );

    // --- 6. blocker is derived, never stored -------------------------------------
    section('blocker is derived, never stored');
    const { rows: blockerColumns } = await client.query<{ table_name: string; column_name: string }>(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name ILIKE '%blocker%'`);
    check(
      blockerColumns.length === 0,
      'no table in Parity stores a blocker column',
      blockerColumns.map((c) => `${c.table_name}.${c.column_name}`).join(', '),
    );

    // Storage is only half of it: prove the value actually moves when its inputs move.
    const probeName = 'sp_GetProductDetail';
    const before = (await getJson<EstateResponse>('/api/estate')).procedures.find((p) => p.name === probeName);
    await client.query('UPDATE procedures SET oracle_class = $1, oracle_state = $2 WHERE name = $3', [
      'pure_read',
      'golden',
      probeName,
    ]);
    const after = (await getJson<EstateResponse>('/api/estate')).procedures.find((p) => p.name === probeName);
    check(
      before?.blocker?.key === 'untriaged' && after?.blocker?.key === 'no_shadow',
      'changing oracle_state changes the blocker the API returns',
      `${before?.blocker?.key} -> ${after?.blocker?.key}`,
    );

    // --- 7. coverage is invocation-weighted, not counted --------------------------
    section('Coverage is weighted by invocation');
    const weighted = await getJson<EstateResponse>('/api/estate');
    const share = (ingested.get(probeName)?.invocations90d ?? 0) / estate.totals.invocations90d;
    check(
      Math.abs(weighted.totals.coverage - share) < 0.0001,
      'coverage moves by the procedure invocation share',
      `${(weighted.totals.coverage * 100).toFixed(2)}% vs share ${(share * 100).toFixed(2)}%`,
    );
    check(
      Math.abs(weighted.totals.coverageByCount - 1 / 14) < 0.0001 && weighted.totals.coverage !== weighted.totals.coverageByCount,
      'a naive per-procedure count would have said something different',
      `weighted ${(weighted.totals.coverage * 100).toFixed(2)}% vs counted ${(weighted.totals.coverageByCount * 100).toFixed(2)}%`,
    );

    await client.query('UPDATE procedures SET oracle_class = NULL, oracle_state = $1 WHERE name = $2', ['none', probeName]);

    // --- 8. determinism ----------------------------------------------------------
    section('Ingest is deterministic');
    const first = await fingerprint(client);
    await exec('docker', ['compose', 'exec', '-T', 'parity-api', 'npx', 'tsx', 'src/cli/ingest.ts'], {
      cwd: new URL('..', import.meta.url).pathname,
      timeout: 180_000,
    });
    const second = await fingerprint(client);
    check(first === second, 'two consecutive ingests produce identical estate data');

    // --- 9. demo-reset -----------------------------------------------------------
    section('make demo-reset');
    const resetStarted = Date.now();
    await exec('make', ['demo-reset'], { cwd: new URL('..', import.meta.url).pathname, timeout: 180_000 });
    const resetMs = Date.now() - resetStarted;
    check(resetMs < 120_000, 'demo-reset completes in under 120 s', `${(resetMs / 1000).toFixed(1)} s`);

    const afterReset = await getJson<EstateResponse>('/api/estate');
    check(afterReset.totals.procedures === 14, 'reset leaves 14 procedures listed', `${afterReset.totals.procedures}`);
    check(afterReset.totals.coverage === 0, 'reset leaves coverage at zero');
    check(
      afterReset.procedures.every((p) => p.campaignStatus === 'untouched' && p.oracleClass === null),
      'reset leaves every procedure untouched and untriaged',
    );
    check(
      afterReset.blockers.length === 1 && afterReset.blockers[0].key === 'untriaged',
      'the whole estate blocks on the same thing: nothing is analysed',
      afterReset.blockers.map((b) => `${b.label}=${b.procedures}`).join(', '),
    );
  } finally {
    await sqlPool.close();
    await client.end();
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
