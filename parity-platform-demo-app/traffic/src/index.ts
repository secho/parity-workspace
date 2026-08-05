import sql from 'mssql';
import { buildPlan, type PlannedCall, type PlanInput } from './plan.js';

/**
 * Traffic generator. Produces 90 days of invocation history in one run, from a fixed
 * seed, by driving the monolith's real HTTP API — the procedures really execute and the
 * write sets really come from Change Tracking. Only the clock is simulated.
 */

const API = `http://127.0.0.1:${process.env.SHOP_API_PORT ?? 3100}`;
const TOTAL_CALLS = Number(process.env.TRAFFIC_CALLS ?? 40_000);
const READ_CONCURRENCY = Number(process.env.TRAFFIC_CONCURRENCY ?? 24);

async function loadFixtures(): Promise<PlanInput> {
  const pool = await new sql.ConnectionPool({
    server: process.env.MSSQL_HOST ?? 'localhost',
    port: Number(process.env.MSSQL_PORT ?? 1433),
    database: 'ParityShop',
    user: 'sa',
    password: process.env.MSSQL_SA_PASSWORD ?? 'ParityShop_Dev_2026!',
    options: { encrypt: true, trustServerCertificate: true, requestTimeout: 60_000 },
  }).connect();

  try {
    const q = async <T>(text: string): Promise<T[]> => (await pool.request().query(text)).recordset as T[];
    const one = async (text: string): Promise<number> => Number((await q<{ n: number }>(text))[0].n);

    return {
      totalCalls: TOTAL_CALLS,
      productCount: await one('SELECT COUNT(*) AS n FROM dbo.Catalog'),
      customerCount: await one('SELECT COUNT(*) AS n FROM dbo.Customer'),
      orderCount: await one('SELECT COUNT(DISTINCT OrderNumber) AS n FROM dbo.OrderLedger'),
      slovakCustomerIds: (await q<{ CustomerID: number }>(
        `SELECT CustomerID FROM dbo.Customer WHERE CountryCode = 'SK' ORDER BY CustomerID`,
      )).map((c) => c.CustomerID),
      loyalCustomerIds: (await q<{ CustomerID: number }>(
        `SELECT CustomerID FROM dbo.Customer WHERE LoyaltyTier >= 3 ORDER BY CustomerID`,
      )).map((c) => c.CustomerID),
      backorderProductIds: (await q<{ ProductID: number }>(
        `SELECT ProductID FROM dbo.Catalog WHERE AllowBackorder = 1 ORDER BY ProductID`,
      )).map((p) => p.ProductID),
      leapDayOrders: (await q<{ OrderNumber: string }>(
        `SELECT DISTINCT OrderNumber FROM dbo.OrderLedger WHERE CAST(OrderedAt AS DATE) = '2024-02-29' ORDER BY OrderNumber`,
      )).map((o) => o.OrderNumber),
    };
  } finally {
    await pool.close();
  }
}

async function issue(call: PlannedCall): Promise<boolean> {
  const headers: Record<string, string> = {
    'x-parity-simulated-at': call.at.toISOString(),
    'x-parity-session': call.sessionId,
    'x-parity-caller': call.rare ? `traffic:${call.rare}` : 'traffic',
  };
  if (call.body !== undefined) headers['content-type'] = 'application/json';

  try {
    const res = await fetch(`${API}${call.path}`, {
      method: call.method,
      headers,
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
      signal: AbortSignal.timeout(30_000),
    });
    // 4xx is a legitimate outcome for a lot of this traffic — an expired promo, a
    // product that has sold out. The procedure still ran and was still captured.
    return res.status < 500;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  process.stdout.write('loading fixtures... ');
  const fixtures = await loadFixtures();
  console.log(
    `${fixtures.productCount} products, ${fixtures.customerCount} customers, ${fixtures.orderCount} orders, ` +
    `${fixtures.slovakCustomerIds.length} SK, ${fixtures.backorderProductIds.length} backorder, ` +
    `${fixtures.leapDayOrders.length} leap-day orders`,
  );

  // The sampler's counters and the capture metadata cache live in the monolith's memory
  // and outlive `make seed`. Without this reset a second run inherits the first run's
  // sampling state and the two runs stop matching.
  await fetch(`${API}/api/_capture/reset`, { method: 'POST' });

  const plan = buildPlan(fixtures);
  const reads = plan.filter((c) => c.lane === 'read');
  const writes = plan.filter((c) => c.lane === 'write');
  console.log(`plan: ${plan.length} calls (${reads.length} read, ${writes.length} write) across 90 days`);

  let done = 0;
  let failed = 0;
  const tick = (ok: boolean): void => {
    done++;
    if (!ok) failed++;
    if (done % 10_000 === 0) process.stdout.write(`  ${done}/${plan.length}\n`);
  };

  // Reads run concurrently. Writes run in a single lane: a captured write owns the
  // Change Tracking version window, and a concurrent write from another call would land
  // in its write set. See monolith/src/capture/lock.ts.
  const readQueue = [...reads];
  const workers = Array.from({ length: READ_CONCURRENCY }, async () => {
    for (;;) {
      const next = readQueue.pop();
      if (!next) return;
      tick(await issue(next));
    }
  });

  const writeLane = (async () => {
    for (const call of writes) tick(await issue(call));
  })();

  await Promise.all([...workers, writeLane]);

  process.stdout.write('flushing capture buffer... ');
  const flushed = await fetch(`${API}/api/_capture/flush`, { method: 'POST' }).then((r) => r.json());
  console.log(JSON.stringify(flushed));

  const elapsed = (Date.now() - started) / 1000;
  console.log(`traffic complete: ${done} calls in ${elapsed.toFixed(1)}s (${failed} failed)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
