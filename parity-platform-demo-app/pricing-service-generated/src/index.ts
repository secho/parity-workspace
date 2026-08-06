import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { databaseName, disconnect, getPool } from './db.js';

/**
 * The migration target, as the agent wrote it — behind the same HTTP interface the
 * hand-written reference exposes, because the shadow harness must not be able to tell them
 * apart by anything except behaviour.
 *
 * **This file and `db.ts` are the harness's contract and belong to the platform.** The route
 * shape, the `/health` probe and the `/_admin/disconnect` handshake are all things the harness
 * depends on and no specification describes; asking a model to re-derive them buys nothing and
 * fails in the worst way available — four hundred replay cases returning 404, which the diff
 * engine would faithfully report as four hundred behavioural differences. `pricing.ts` and
 * `persist.ts` are the agent's, and they are where all the business rules live.
 *
 * Before `make adopt-service` has run there is no implementation here at all, and this service
 * says so: `/health` reports `awaiting_artifact` and `/replay` returns 503. It does not serve a
 * placeholder. A stubbed price is exactly the kind of thing that would sail through a shadow
 * run looking like a result.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

interface Pricing {
  netSubtotal: number;
  vatRate: number;
  promoCode: string | null;
  promoDiscount: number;
  loyaltyDiscount: number;
  totalNet: number;
  totalVat: number;
  totalWithVat: number;
  stackedWithLoyalty: boolean;
}

interface PricingInput {
  orderNumber: string;
  promoCode: string | null;
  modifiedBy: string;
}

interface Implementation {
  price: (pool: unknown, input: PricingInput, now: Date) => Promise<Pricing>;
  persist: (pool: unknown, input: PricingInput, pricing: Pricing, now: Date) => Promise<void>;
  OrderNotFound: new (...args: never[]) => Error;
}

/**
 * The artefact hash the platform stamped when it materialised this source.
 *
 * `/health` echoes it so that "the service that was replayed is the source the agent wrote" is
 * a query a gate can run across two systems, rather than an assumption. M5 lost a day to a
 * container serving a stale copy of a file that had already been edited on the host; a hash
 * either side of the mount is the cheap version of that lesson.
 */
async function artifactHash(): Promise<string | null> {
  try {
    return (await readFile(join(HERE, '.artifact'), 'utf8')).trim();
  } catch {
    return null;
  }
}

async function implementation(): Promise<Implementation | null> {
  try {
    const pricing = (await import('./pricing.js')) as unknown as Pick<Implementation, 'price' | 'OrderNotFound'>;
    const persist = (await import('./persist.js')) as unknown as Pick<Implementation, 'persist'>;
    if (typeof pricing.price !== 'function' || typeof persist.persist !== 'function') return null;
    return { price: pricing.price, persist: persist.persist, OrderNotFound: pricing.OrderNotFound };
  } catch {
    return null;
  }
}

const app = Fastify({ logger: false });

app.get('/health', async () => {
  const [hash, impl] = await Promise.all([artifactHash(), implementation()]);
  return {
    // `ok` only when there is something to run. A health check that goes green on an empty
    // service would let the harness replay four hundred cases against nothing.
    status: impl === null ? 'awaiting_artifact' : 'ok',
    database: databaseName(),
    implementation: 'generated',
    artifact: hash,
  };
});

app.post('/_admin/disconnect', async () => {
  await disconnect();
  return { disconnected: true };
});

interface ReplayBody {
  OrderNumber?: string;
  PromoCode?: string | null;
  ModifiedBy?: string | null;
  RecalcShippingOnly?: unknown;
}

app.post('/replay/sp_CalculateOrderTotal', async (request, reply) => {
  const impl = await implementation();
  if (impl === null) {
    return reply.code(503).send({ error: 'no generated implementation adopted — run `make implement-service && make adopt-service`' });
  }

  const body = request.body as ReplayBody;
  if (typeof body?.OrderNumber !== 'string') return reply.code(400).send({ error: 'OrderNumber is required' });

  const pool = await getPool();

  /**
   * The clock, and the one place M6 extends the interface.
   *
   * By default it comes from the database, exactly as the reference does and for the same
   * reason: five of the fourteen procedures branch on `GETDATE()`, and a replacement reading a
   * different clock than the thing it replaces produces differences that are about the network
   * rather than about the code.
   *
   * `x-parity-now` overrides it, and is used by ONE caller: the golden suite, which replays
   * cases whose expectations were recorded at a known instant (`golden_tests.baseline_context`).
   * It is deliberately NOT used by the shadow harness. `GETDATE()` cannot be overridden inside
   * T-SQL, so pass A cannot be pinned — pinning pass B alone would flip every clock-dependent
   * branch on one side only and manufacture divergence across the whole run.
   */
  const pinned = request.headers['x-parity-now'];
  const now =
    typeof pinned === 'string' && !Number.isNaN(new Date(pinned).getTime())
      ? new Date(pinned)
      : ((await pool.request().query('SELECT GETDATE() AS now')).recordset[0].now as Date);

  const input: PricingInput = {
    orderNumber: body.OrderNumber,
    promoCode: typeof body.PromoCode === 'string' ? body.PromoCode : null,
    modifiedBy: typeof body.ModifiedBy === 'string' ? body.ModifiedBy : 'system',
  };

  try {
    const pricing = await impl.price(pool, input, now);
    await impl.persist(pool, { ...input, promoCode: pricing.promoCode }, pricing, now);
    // Empty on purpose: sp_CalculateOrderTotal reads into variables and updates OrderLedger,
    // so its result set is empty on every call and its write set IS its output.
    return { resultSets: [], summary: pricing };
  } catch (err) {
    if (impl.OrderNotFound !== undefined && err instanceof impl.OrderNotFound) {
      return reply.code(409).send({ error: err.message });
    }
    throw err;
  }
});

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
console.log(`pricing-service-generated on ${port}, pricing against ${databaseName()}`);
