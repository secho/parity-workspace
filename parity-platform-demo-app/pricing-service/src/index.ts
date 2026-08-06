import Fastify from 'fastify';
import { databaseName, disconnect, getPool } from './db.js';
import { OrderNotFound, price } from './pricing.js';
import { persist } from './persist.js';

/**
 * The migration target, behind an HTTP interface the shadow harness can drive.
 *
 * One endpoint per procedure being replaced, taking the **captured input parameters
 * verbatim** — the same JSON the estate recorded when the procedure really ran. That shape is
 * what keeps the harness procedure-agnostic and what will let M6 swap this hand-written
 * implementation for the agent's without the harness noticing.
 *
 * The response carries `resultSets` because that is the other half of what a shadow run
 * diffs. `sp_CalculateOrderTotal` has none — it reads into variables and updates
 * `OrderLedger`, so its result set is empty on every call and its **write set is its output**.
 * M1 recorded the same fact the hard way, when an acceptance check compared that empty
 * result's constant hash to itself and could not fail.
 */

const app = Fastify({ logger: false });

app.get('/health', async () => ({ status: 'ok', database: databaseName() }));

/**
 * Let go of the connection pool.
 *
 * The harness resets the shadow database between passes with a RESTORE, and RESTORE waits on
 * any open connection rather than failing. This is the handshake that keeps a 530 ms reset
 * from becoming an unbounded wait.
 */
app.post('/_admin/disconnect', async () => {
  await disconnect();
  return { disconnected: true };
});

interface ReplayBody {
  OrderNumber?: string;
  PromoCode?: string | null;
  ModifiedBy?: string | null;
  /** Present in the capture, unused by the procedure since the v1 e-shop was retired. */
  RecalcShippingOnly?: unknown;
}

app.post('/replay/sp_CalculateOrderTotal', async (request, reply) => {
  const body = request.body as ReplayBody;
  if (typeof body?.OrderNumber !== 'string') {
    return reply.code(400).send({ error: 'OrderNumber is required' });
  }

  const pool = await getPool();
  // The database's clock, not this process's. Five of the fourteen procedures branch on
  // GETDATE(), and a replacement that reads a different clock than the thing it replaces
  // produces differences that are about the network rather than about the code.
  const now = (await pool.request().query('SELECT GETDATE() AS now')).recordset[0].now as Date;

  try {
    const pricing = await price(
      pool,
      {
        orderNumber: body.OrderNumber,
        promoCode: typeof body.PromoCode === 'string' ? body.PromoCode : null,
        modifiedBy: typeof body.ModifiedBy === 'string' ? body.ModifiedBy : 'system',
      },
      now,
    );
    await persist(pool, { orderNumber: body.OrderNumber, promoCode: pricing.promoCode, modifiedBy: typeof body.ModifiedBy === 'string' ? body.ModifiedBy : 'system' }, pricing, now);

    return {
      resultSets: [],
      // Not part of the diff — the diff is the result set and the write set. Returned so a
      // human reading one case in the queue can see what the service thought it was doing.
      summary: {
        netSubtotal: pricing.netSubtotal,
        vatRate: pricing.vatRate,
        promoDiscount: pricing.promoDiscount,
        loyaltyDiscount: pricing.loyaltyDiscount,
        totalNet: pricing.totalNet,
        totalVat: pricing.totalVat,
        totalWithVat: pricing.totalWithVat,
        stackedWithLoyalty: pricing.stackedWithLoyalty,
      },
    };
  } catch (err) {
    // The procedure RAISERRORs on an unknown order. An error on one side and not the other is
    // itself a difference, so it is reported rather than swallowed.
    if (err instanceof OrderNotFound) return reply.code(409).send({ error: err.message });
    throw err;
  }
});

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
console.log(`pricing-service on ${port}, pricing against ${databaseName()}`);
