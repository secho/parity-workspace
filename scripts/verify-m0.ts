// M0 acceptance. `make verify-m0` is the definition of done.
//
// Runs against a fresh `make up && make seed`. Every check is printed; the process
// exits non-zero if any failed.

import sql from 'mssql';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 127.0.0.1, not localhost: localhost resolves to ::1 first on macOS, and any other
// process bound to the IPv6 loopback would silently answer instead of our container.
const SHOP_API = `http://127.0.0.1:${process.env.SHOP_API_PORT ?? 3100}`;
const SHOP_WEB = `http://127.0.0.1:${process.env.SHOP_WEB_PORT ?? 5180}`;
const MAILPIT = `http://127.0.0.1:${process.env.MAILPIT_UI_PORT ?? 8025}`;

const EXPECTED_PROCEDURES = [
  'sp_ApplyPromoCode',
  'sp_CalculateOrderTotal',
  'sp_ExportCatalogXml_OLD',
  'sp_GetCartSummary',
  'sp_GetProductAvailability',
  'sp_GetProductDetail',
  'sp_LegacyPriceImport_v2',
  'sp_MigrateCustomerAddresses',
  'sp_PlaceOrder',
  'sp_RecalculateCustomerScore',
  'sp_RecomputeLoyaltyTier_deprecated',
  'sp_ReserveStock',
  'sp_SearchProducts',
  'sp_SyncWarehouseDispatch',
];

/** SCHEDULE.md: only these six must be genuinely nasty. */
const NASTY = [
  'sp_CalculateOrderTotal',
  'sp_ReserveStock',
  'sp_PlaceOrder',
  'sp_ApplyPromoCode',
  'sp_RecalculateCustomerScore',
  'sp_SearchProducts',
];

const DEAD = ['sp_ExportCatalogXml_OLD', 'sp_MigrateCustomerAddresses', 'sp_RecomputeLoyaltyTier_deprecated'];

const SATELLITES = ['Category', 'Warehouse', 'Customer', 'CustomerScore', 'StockMovement', 'PromoCode', 'AuditTrail', 'VatRate', 'StockReservation', 'PromoRedemption'];

let failures = 0;
let checks = 0;

function check(ok: boolean, label: string, detail = ''): void {
  checks++;
  if (!ok) failures++;
  const mark = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${mark}  ${label}${detail ? ` — ${detail}` : ''}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

async function containerState(name: string): Promise<string> {
  try {
    const { stdout } = await exec('docker', [
      'inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', name,
    ]);
    return stdout.trim();
  } catch {
    return 'missing';
  }
}

async function httpStatus(url: string): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    return { status: res.status, body: await res.text() };
  } catch (err) {
    return { status: 0, body: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The write-overlap assertion, established by RUNNING each procedure and observing
 * what actually changed.
 *
 * Static analysis is not good enough here. `sys.dm_sql_referenced_entities` silently
 * drops any statement it cannot bind, which includes every `UPDATE ... FROM #temp`
 * — and the gnarliest procedures in this estate are exactly the ones that use temp
 * tables. Trusting the DMV would have under-reported Catalog's writers as 4 when the
 * T-SQL genuinely has 6. Observed behaviour cannot lie in that direction.
 *
 * This mutates the database, so it runs last and reseeds afterwards; the determinism
 * fingerprint above has already been checked against the pristine seed.
 */
const WATCHED: Record<string, string[]> = {
  Catalog: ['StockQty', 'ReservedQty', 'PriceNet', 'PriceWithDiscount', 'DiscountPct', 'LastQuotedPrice', 'LastQuotedAt', 'LastStockSyncAt', 'SoldCount'],
  OrderLedger: ['TotalWithVat', 'TotalNet', 'DiscountAmount', 'PromoCodeUsed', 'ShipStreet', 'CustomerEmailSnapshot', 'Status1', 'DispatchRef', 'ReservationID'],
  Customer: ['LoyaltyTier', 'LoyaltyPoints', 'Street', 'OldAddressLine'],
  CustomerScore: ['Score'],
};

async function probeWriteSets(): Promise<void> {
  section('Write overlap, observed by running the procedures');

  const pool = await new sql.ConnectionPool({
    server: process.env.MSSQL_HOST ?? 'localhost',
    port: Number(process.env.MSSQL_PORT ?? 1433),
    database: 'ParityShop',
    user: 'sa',
    password: process.env.MSSQL_SA_PASSWORD ?? 'ParityShop_Dev_2026!',
    options: { encrypt: true, trustServerCertificate: true, requestTimeout: 120_000 },
  }).connect();

  const changedBy = new Map<string, Set<string>>(); // proc -> Table.Column touched

  try {
    // SUM of per-row checksums, not CHECKSUM_AGG. CHECKSUM_AGG is XOR-based, so the
    // 16 000 identical values in a freshly seeded OrderLedger cancel to zero and a
    // three-row update leaves the fingerprint bit-identical. Measured, not assumed.
    const fpSelect = Object.entries(WATCHED)
      .flatMap(([table, cols]) =>
        cols.map((c) => `(SELECT SUM(CAST(ISNULL(CHECKSUM(${c}), 0) AS BIGINT)) FROM dbo.${table}) AS [${table}.${c}]`),
      )
      .join(',\n  ');
    const fingerprint = async (): Promise<Record<string, unknown>> =>
      (await pool.request().query(`SELECT\n  ${fpSelect}`)).recordset[0] as Record<string, unknown>;

    // A CZ order with a tier-3+ customer, so the promo and loyalty paths are live.
    const fixture = (
      await pool.request().query(`
        SELECT TOP 1 o.OrderNumber, o.CustomerID
        FROM dbo.OrderLedger o JOIN dbo.Customer c ON c.CustomerID = o.CustomerID
        WHERE c.LoyaltyTier >= 3 AND o.CustomerCountryCode = 'CZ' AND o.TotalNet > 2500
        GROUP BY o.OrderNumber, o.CustomerID ORDER BY o.OrderNumber`)
    ).recordset[0] as { OrderNumber: string; CustomerID: number };

    const oldAddrCustomer = (
      await pool.request().query(`SELECT TOP 1 CustomerID FROM dbo.Customer WHERE OldAddressLine IS NOT NULL ORDER BY CustomerID`)
    ).recordset[0] as { CustomerID: number };

    const probes: { proc: string; statement: string }[] = [
      { proc: 'sp_CalculateOrderTotal', statement: `EXEC dbo.sp_CalculateOrderTotal @OrderNumber = '${fixture.OrderNumber}', @ModifiedBy = 'verify'` },
      // GEEK200 runs 2026-01-01..2026-12-31 with a 1500 minimum. sp_ApplyPromoCode
      // checks validity against GETDATE(), not the order date, so a seasonal code
      // like JARO10 would silently no-op outside its window and prove nothing.
      { proc: 'sp_ApplyPromoCode', statement: `EXEC dbo.sp_ApplyPromoCode @p_OrderNumber = '${fixture.OrderNumber}', @p_Code = 'GEEK200', @p_CustomerID = ${fixture.CustomerID}, @p_ModifiedBy = 'verify'` },
      { proc: 'sp_ReserveStock', statement: `EXEC dbo.sp_ReserveStock @orderNo = '${fixture.OrderNumber}', @modifiedBy = 'verify'` },
      { proc: 'sp_LegacyPriceImport_v2', statement: `EXEC dbo.sp_LegacyPriceImport_v2 @PriceData = 'PS-10001:1234.00;PS-10002:2345.00', @BatchID = 'VERIFY', @ModifiedBy = 'verify'` },
      { proc: 'sp_PlaceOrder', statement: `EXEC dbo.sp_PlaceOrder @CustomerID = ${fixture.CustomerID}, @LinesRaw = '1:1|2:2', @PaymentMethod = 'Karta online', @CreatedBy = 'verify'` },
      { proc: 'sp_SyncWarehouseDispatch', statement: `EXEC dbo.sp_SyncWarehouseDispatch @orderNumber = '${fixture.OrderNumber}', @modifiedBy = 'verify'` },
      { proc: 'sp_MigrateCustomerAddresses', statement: `EXEC dbo.sp_MigrateCustomerAddresses @CustomerID = ${oldAddrCustomer.CustomerID}, @ModifiedBy = 'verify'` },
      { proc: 'sp_RecalculateCustomerScore', statement: `EXEC dbo.sp_RecalculateCustomerScore @iCustomerId = ${fixture.CustomerID}, @sCalculatedBy = 'verify'` },
      { proc: 'sp_RecomputeLoyaltyTier_deprecated', statement: `EXEC dbo.sp_RecomputeLoyaltyTier_deprecated @CustomerID = ${fixture.CustomerID}, @ModifiedBy = 'verify'` },
    ];

    const mailBefore = await httpStatus(`${MAILPIT}/api/v1/messages`);
    const mailCountBefore = mailBefore.status === 200 ? (JSON.parse(mailBefore.body) as { total: number }).total : -1;

    for (const probe of probes) {
      const before = await fingerprint();
      try {
        await pool.request().batch(probe.statement);
      } catch (err) {
        check(false, `${probe.proc} runs`, err instanceof Error ? err.message.slice(0, 120) : String(err));
        continue;
      }
      const after = await fingerprint();
      const touched = new Set(Object.keys(before).filter((k) => String(before[k]) !== String(after[k])));
      changedBy.set(probe.proc, touched);
    }

    const writersOf = (table: string): string[] =>
      [...changedBy.entries()]
        .filter(([, cols]) => [...cols].some((c) => c.startsWith(`${table}.`)))
        .map(([proc]) => proc)
        .sort();

    const catalogWriters = writersOf('Catalog');
    const ledgerWriters = writersOf('OrderLedger');
    check(catalogWriters.length >= 6, 'Catalog is written by 6+ procedures (SPEC §3)', `${catalogWriters.length}: ${catalogWriters.join(', ')}`);
    check(ledgerWriters.length >= 5, 'OrderLedger is written by 5+ procedures (SPEC §3)', `${ledgerWriters.length}: ${ledgerWriters.join(', ')}`);

    const byColumn = new Map<string, string[]>();
    for (const [proc, cols] of changedBy) {
      for (const col of cols) byColumn.set(col, [...(byColumn.get(col) ?? []), proc]);
    }
    const sharedCols = [...byColumn.entries()].filter(([, ps]) => ps.length >= 2);
    check(sharedCols.length >= 8, 'at least 8 columns are written by 2+ procedures', `${sharedCols.length} shared`);

    // The sharpest coupling in the estate: a quarterly import procedure and a live
    // promo procedure fighting over the same Catalog columns, neither calling the other.
    const priceCols = ['Catalog.PriceWithDiscount', 'Catalog.DiscountPct'];
    const promoImport = priceCols.some((c) => {
      const ps = byColumn.get(c) ?? [];
      return ps.includes('sp_ApplyPromoCode') && ps.includes('sp_LegacyPriceImport_v2');
    });
    check(promoImport, 'sp_ApplyPromoCode and sp_LegacyPriceImport_v2 fight over Catalog price columns');

    // A dead procedure still writing columns a hot one owns — what makes the phase-0
    // deletion campaign worth watching rather than trivial.
    const snapshotCols = ['OrderLedger.ShipStreet', 'OrderLedger.CustomerEmailSnapshot'];
    const deadLive = snapshotCols.some((c) => {
      const ps = byColumn.get(c) ?? [];
      return ps.includes('sp_PlaceOrder') && ps.includes('sp_MigrateCustomerAddresses');
    });
    check(deadLive, 'dead sp_MigrateCustomerAddresses overlaps hot sp_PlaceOrder on OrderLedger');

    const tierCols = byColumn.get('Customer.LoyaltyTier') ?? [];
    check(
      tierCols.includes('sp_RecalculateCustomerScore') && tierCols.includes('sp_RecomputeLoyaltyTier_deprecated'),
      'live and deprecated scoring procedures both write Customer.LoyaltyTier',
    );

    // The external call is real: running the dispatch procedure put a message on SMTP.
    // Database Mail is asynchronous — sp_send_dbmail queues through Service Broker in
    // msdb and a separate process does the send, so poll rather than checking once.
    // On a cold container the first send can take ~20s while the mail queue spins up.
    let mailCountAfter = mailCountBefore;
    for (let attempt = 0; attempt < 30 && mailCountAfter <= mailCountBefore; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const res = await httpStatus(`${MAILPIT}/api/v1/messages`);
      if (res.status === 200) mailCountAfter = (JSON.parse(res.body) as { total: number }).total;
    }
    const queued = (
      await pool.request().query(`SELECT TOP 1 sent_status FROM msdb.dbo.sysmail_allitems ORDER BY mailitem_id DESC`)
    ).recordset[0] as { sent_status: string } | undefined;
    check(
      mailCountAfter > mailCountBefore,
      'sp_SyncWarehouseDispatch actually sent mail — a side effect no rollback can undo',
      `mailpit ${mailCountBefore} → ${mailCountAfter}, queue status ${queued?.sent_status ?? 'none'}`,
    );
  } finally {
    await pool.close();
  }

  // Restore the pristine seed so verify stays idempotent.
  section('Restoring pristine seed');
  try {
    await exec('npm', ['--prefix', join(ROOT, 'parity-platform-demo-app', 'seed'), 'run', 'seed'], { cwd: ROOT });
    check(true, 'database reseeded to pristine state after write probes');
  } catch (err) {
    check(false, 'database reseeded to pristine state after write probes', err instanceof Error ? err.message.slice(0, 160) : String(err));
  }
}

async function main(): Promise<void> {
  console.log('M0 acceptance — ParityShop stands up');

  // --- containers ------------------------------------------------------------
  section('Containers');
  for (const name of ['parityshop-mssql', 'parityshop-mailpit', 'parityshop-api', 'parityshop-web']) {
    const state = await containerState(name);
    check(state === 'healthy' || state === 'running', `${name} is up`, state);
  }

  const health = await httpStatus(`${SHOP_API}/health`);
  check(health.status === 200, 'GET /health returns 200', `status ${health.status}`);

  // --- database --------------------------------------------------------------
  const pool = await new sql.ConnectionPool({
    server: process.env.MSSQL_HOST ?? 'localhost',
    port: Number(process.env.MSSQL_PORT ?? 1433),
    database: 'ParityShop',
    user: 'sa',
    password: process.env.MSSQL_SA_PASSWORD ?? 'ParityShop_Dev_2026!',
    options: { encrypt: true, trustServerCertificate: true, requestTimeout: 60_000 },
  }).connect();

  try {
    const q = async <T = Record<string, unknown>>(text: string): Promise<T[]> =>
      (await pool.request().query(text)).recordset as T[];

    // --- schema --------------------------------------------------------------
    section('Schema (SPEC §3)');
    const [cols] = await q<{ CatalogCols: number; OrderLedgerCols: number }>(`
      SELECT
        (SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Catalog'))     AS CatalogCols,
        (SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID('dbo.OrderLedger')) AS OrderLedgerCols`);
    check(cols.CatalogCols >= 58, 'Catalog is ~60 columns wide', `${cols.CatalogCols} columns`);
    check(cols.OrderLedgerCols >= 68, 'OrderLedger is ~70 columns wide', `${cols.OrderLedgerCols} columns`);

    const tables = (await q<{ name: string }>(`SELECT name FROM sys.tables`)).map((r) => r.name);
    const missingTables = SATELLITES.filter((t) => !tables.includes(t));
    check(missingTables.length === 0, 'all satellite tables exist', missingTables.length ? `missing ${missingTables.join(', ')}` : `${SATELLITES.length} present`);

    // --- procedures ----------------------------------------------------------
    section('Procedures');
    const procs = await q<{ name: string; Lines: number }>(`
      SELECT p.name, LEN(m.definition) - LEN(REPLACE(m.definition, CHAR(10), '')) + 1 AS Lines
      FROM sys.procedures p JOIN sys.sql_modules m ON m.object_id = p.object_id`);
    const procNames = procs.map((p) => p.name).sort();
    const missingProcs = EXPECTED_PROCEDURES.filter((n) => !procNames.includes(n));
    const extraProcs = procNames.filter((n) => !EXPECTED_PROCEDURES.includes(n));
    check(
      missingProcs.length === 0 && extraProcs.length === 0 && procNames.length === 14,
      'exactly the 14 expected procedures exist',
      `${procNames.length} found${missingProcs.length ? `, missing ${missingProcs.join(', ')}` : ''}${extraProcs.length ? `, unexpected ${extraProcs.join(', ')}` : ''}`,
    );

    const tooShort = procs.filter((p) => p.Lines < 40).map((p) => `${p.name}=${p.Lines}`);
    check(tooShort.length === 0, 'every procedure is at least 40 lines', tooShort.length ? tooShort.join(', ') : 'ok');

    const notNasty = procs.filter((p) => NASTY.includes(p.name) && p.Lines < 80).map((p) => `${p.name}=${p.Lines}`);
    check(notNasty.length === 0, 'the six load-bearing procedures are 80+ lines', notNasty.length ? notNasty.join(', ') : 'ok');

    // --- oracle classes are properties of the code, not labels ---------------
    section('Oracle classes are genuine');
    const src = new Map(
      (await q<{ name: string; definition: string }>(`
        SELECT p.name, m.definition FROM sys.procedures p JOIN sys.sql_modules m ON m.object_id = p.object_id`))
        .map((r) => [r.name, r.definition]),
    );

    const placeOrder = src.get('sp_PlaceOrder') ?? '';
    check(/NEWID\s*\(/i.test(placeOrder) && /(GETDATE|SYSDATETIME)\s*\(/i.test(placeOrder), 'sp_PlaceOrder is genuinely nondet (NEWID + GETDATE)');

    const dispatch = src.get('sp_SyncWarehouseDispatch') ?? '';
    check(/sp_send_dbmail/i.test(dispatch), 'sp_SyncWarehouseDispatch is genuinely external (sp_send_dbmail)');

    const search = src.get('sp_SearchProducts') ?? '';
    check(/ORDER\s+BY/i.test(search) && !/ORDER\s+BY[^)]*ProductID/i.test(search), 'sp_SearchProducts sorts with no unique tiebreaker');

    // --- seed data -----------------------------------------------------------
    section('Seed data (exact)');
    const [counts] = await q<Record<string, number>>(`
      SELECT
        (SELECT COUNT(*) FROM dbo.Category)  AS Categories,
        (SELECT COUNT(*) FROM dbo.Warehouse) AS Warehouses,
        (SELECT COUNT(*) FROM dbo.Catalog)   AS Products,
        (SELECT COUNT(*) FROM dbo.Customer)  AS Customers,
        (SELECT COUNT(DISTINCT OrderNumber) FROM dbo.OrderLedger) AS Orders`);
    check(counts.Categories === 8, 'exactly 8 categories', String(counts.Categories));
    check(counts.Warehouses === 3, 'exactly 3 warehouses', String(counts.Warehouses));
    check(counts.Products === 300, 'exactly 300 products', String(counts.Products));
    check(counts.Customers === 500, 'exactly 500 customers', String(counts.Customers));
    check(counts.Orders === 5000, 'exactly 5000 orders', String(counts.Orders));

    // --- determinism ---------------------------------------------------------
    section('Determinism (hard rule 5)');
    const expected = JSON.parse(await readFile(join(ROOT, 'scripts', 'seed-checksum.json'), 'utf8')) as Record<string, unknown>;
    const [actual] = await q<Record<string, unknown>>(await readFile(join(ROOT, 'scripts', 'seed-checksum.sql'), 'utf8'));
    const drifted = Object.keys(expected).filter((k) => String(expected[k]) !== String(actual[k]));
    check(
      drifted.length === 0,
      'seeded data matches the committed checksum',
      drifted.length ? `drifted: ${drifted.map((k) => `${k} ${expected[k]}→${actual[k]}`).join(', ')}` : `${Object.keys(expected).length} fingerprints match`,
    );
  } finally {
    await pool.close();
  }

  // --- application -----------------------------------------------------------
  section('Application');
  const products = await httpStatus(`${SHOP_API}/api/products?pageSize=500`);
  let productCount = 0;
  let firstId: number | null = null;
  if (products.status === 200) {
    try {
      const parsed = JSON.parse(products.body) as { products?: { ProductID: number }[] };
      productCount = parsed.products?.length ?? 0;
      firstId = parsed.products?.[0]?.ProductID ?? null;
    } catch { /* handled by the checks below */ }
  }
  check(products.status === 200, 'GET /api/products returns 200', `status ${products.status}`);
  check(productCount > 0, 'GET /api/products returns data', `${productCount} products`);

  const detail = await httpStatus(`${SHOP_API}/api/products/${firstId ?? 1}`);
  check(detail.status === 200, 'GET /api/products/:id returns 200', `status ${detail.status}`);

  const cart = await fetch(`${SHOP_API}/api/cart/summary`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ productId: firstId ?? 1, qty: 2 }] }),
  }).then((r) => r.status).catch(() => 0);
  check(cart === 200, 'POST /api/cart/summary returns 200', `status ${cart}`);

  const web = await httpStatus(SHOP_WEB);
  check(web.status === 200 && /<div id="root">/.test(web.body), 'shop frontend serves HTML', `status ${web.status}`);

  // --- dead procedures are structurally unreachable ---------------------------
  section('Dead procedures are unreachable');
  const monolithDir = join(ROOT, 'parity-platform-demo-app', 'monolith', 'src');
  const sources: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.ts')) sources.push(await readFile(full, 'utf8'));
    }
  };
  await walk(monolithDir);
  // Strip comments first: procs.ts documents *why* the dead procedures are absent, and
  // naming them in a comment is not a reference. Only executable code counts.
  const joined = sources
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const dead of DEAD) {
    check(!joined.includes(dead), `${dead} is not invoked by the monolith`);
  }

  await probeWriteSets();

  // --- result -----------------------------------------------------------------
  console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}${checks - failures}/${checks} checks passed\x1b[0m`);
  if (failures > 0) {
    console.log('M0 is NOT done.');
    process.exit(1);
  }
  console.log('M0 acceptance green.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
