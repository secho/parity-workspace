import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { databaseName, disconnect, getPool } from './db.js';

/**
 * The migration target, as the agent wrote it — behind the same HTTP interface for every
 * procedure, because the shadow harness must not be able to tell two implementations apart by
 * anything except behaviour.
 *
 * **This file and `db.ts` are the harness's contract and belong to the platform.** The route
 * shape, the `/health` probe and the `/_admin/disconnect` handshake are all things the harness
 * depends on and no specification describes; asking a model to re-derive them buys nothing and
 * fails in the worst way available — every replay case returning 404, which the diff engine
 * would faithfully report as hundreds of behavioural differences. The agent writes the business
 * logic, one directory per procedure.
 *
 * The **adapter table** below is the only place a procedure is named. It says which modules to
 * import and how to turn their answer into the `{ resultSets }` the harness diffs. Three lines
 * per procedure, and deliberately not a generic super-interface: `sp_CalculateOrderTotal`
 * computes then writes and returns nothing, while `sp_GetCartSummary` writes nothing and
 * returns two result sets. Forcing both through one shape would mean rewriting a committed
 * artefact, which would falsify "what ran is what the agent wrote".
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** What every adapter returns. The write set is observed from the database, never reported. */
interface Outcome {
  resultSets: unknown[][];
  /** Not part of the diff. Shown so a human reading one case can see what the service thought. */
  summary?: unknown;
}

interface Adapter {
  /** Modules under `src/<procedure>/`, in the order the agent is told to write them. */
  modules: string[];
  run: (pool: unknown, params: Record<string, unknown>, now: Date, loaded: Record<string, never>) => Promise<Outcome>;
  /** Maps a domain error onto an HTTP status, so an error on one side is still a difference. */
  status?: (error: unknown, loaded: Record<string, never>) => number | null;
}

const ADAPTERS: Record<string, Adapter> = {
  /**
   * Computes, then writes, and has no result set — `sp_CalculateOrderTotal` reads into variables
   * and updates `OrderLedger`, so its **write set is its output**. Moved verbatim from the
   * single-procedure shell; the artefact behind it is unchanged and so is its hash.
   */
  sp_CalculateOrderTotal: {
    modules: ['pricing', 'persist'],
    run: async (pool, params, now, loaded) => {
      const { price } = loaded.pricing as never as { price: Function };
      const { persist } = loaded.persist as never as { persist: Function };
      const input = {
        orderNumber: params.OrderNumber as string,
        promoCode: typeof params.PromoCode === 'string' ? params.PromoCode : null,
        modifiedBy: typeof params.ModifiedBy === 'string' ? params.ModifiedBy : 'system',
      };
      const pricing = await price(pool, input, now);
      await persist(pool, { ...input, promoCode: pricing.promoCode }, pricing, now);
      return { resultSets: [], summary: pricing };
    },
    status: (error, loaded) => {
      const { OrderNotFound } = loaded.pricing as never as { OrderNotFound?: new () => Error };
      return OrderNotFound !== undefined && error instanceof OrderNotFound ? 409 : null;
    },
  },

  /**
   * Writes nothing and returns two result sets — the cart lines and a one-row summary. There is
   * no persist step and no error class: the procedure has no RAISERROR, and an unknown customer
   * falls through to the CZ default rather than failing.
   */
  sp_GetCartSummary: {
    modules: ['summary'],
    run: async (pool, params, now, loaded) => {
      const { summarise } = loaded.summary as never as { summarise: Function };
      return await summarise(pool, params, now);
    },
  },
};

/**
 * The artefact hash the platform stamped when it materialised each procedure's source.
 *
 * `/health` echoes them so that "the service that was replayed is the source the agent wrote" is
 * a query a gate can run across two systems, rather than an assumption. M5 lost a day to a
 * container serving a stale copy of a file that had already been edited on the host; a hash
 * either side of the mount is the cheap version of that lesson.
 */
async function artifactHash(procedure: string): Promise<string | null> {
  try {
    return (await readFile(join(HERE, procedure, '.artifact'), 'utf8')).trim();
  } catch {
    return null;
  }
}

/** Load a procedure's modules, or null if it has not been adopted. */
async function load(procedure: string): Promise<{ adapter: Adapter; loaded: Record<string, never> } | null> {
  const adapter = ADAPTERS[procedure];
  if (adapter === undefined) return null;
  try {
    const loaded: Record<string, unknown> = {};
    for (const name of adapter.modules) loaded[name] = await import(`./${procedure}/${name}.js`);
    return { adapter, loaded: loaded as Record<string, never> };
  } catch {
    return null;
  }
}

const app = Fastify({ logger: false });

app.get('/health', async () => {
  const names = Object.keys(ADAPTERS);
  const adopted: string[] = [];
  const artifacts: Record<string, string | null> = {};

  for (const name of names) {
    artifacts[name] = await artifactHash(name);
    if ((await load(name)) !== null) adopted.push(name);
  }

  return {
    // `ok` only when there is something to run. A health check that goes green on an empty
    // service would let the harness replay hundreds of cases against nothing.
    status: adopted.length > 0 ? 'ok' : 'awaiting_artifact',
    database: databaseName(),
    implementation: 'generated',
    procedures: adopted,
    artifacts,
  };
});

app.post('/_admin/disconnect', async () => {
  await disconnect();
  return { disconnected: true };
});

/**
 * One route for every procedure, taking the captured `InputParams` **verbatim**.
 *
 * The harness posts what the estate recorded, and each procedure's parameter names differ —
 * `OrderNumber` here, `p_OrderNumber` there — so the shell passes the body through untouched
 * and the adapter names the fields. Translating in the shell is how a second procedure ends up
 * 400-ing on every case.
 *
 * An unadopted or unknown name returns **503, not 404**. Throughout this codebase 503 means
 * "nothing to replay against" and 404 means "wrong URL"; a shadow run that got 404s would
 * record them as hundreds of behavioural differences on a run whose status still said
 * succeeded.
 */
app.post<{ Params: { procedure: string } }>('/replay/:procedure', async (request, reply) => {
  const procedure = request.params.procedure;
  const resolved = await load(procedure);
  if (resolved === null) {
    return reply.code(503).send({
      error:
        ADAPTERS[procedure] === undefined
          ? `no adapter for ${procedure} — this service does not implement it`
          : `no generated implementation adopted for ${procedure} — run \`make implement-service PROC=${procedure} && make adopt-service PROC=${procedure}\``,
    });
  }

  const params = (request.body ?? {}) as Record<string, unknown>;
  const pool = await getPool();

  /**
   * The clock, and the one place M6 extended the interface.
   *
   * By default it comes from the database, exactly as the procedure's own `GETDATE()` does: a
   * replacement reading a different clock than the thing it replaces produces differences that
   * are about the network rather than about the code.
   *
   * `x-parity-now` overrides it, and is used by ONE caller: the golden suite, which replays
   * cases whose expectations were recorded at a known instant. It is deliberately NOT used by
   * the shadow harness — `GETDATE()` cannot be overridden inside T-SQL, so pass A cannot be
   * pinned, and pinning pass B alone would flip every clock-dependent branch on one side only.
   */
  const pinned = request.headers['x-parity-now'];
  const now =
    typeof pinned === 'string' && !Number.isNaN(new Date(pinned).getTime())
      ? new Date(pinned)
      : ((await pool.request().query('SELECT GETDATE() AS now')).recordset[0].now as Date);

  try {
    const outcome = await resolved.adapter.run(pool, params, now, resolved.loaded);
    return { resultSets: outcome.resultSets, summary: outcome.summary };
  } catch (err) {
    const status = resolved.adapter.status?.(err, resolved.loaded) ?? null;
    if (status !== null) return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
});

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
console.log(`pricing-service-generated on ${port}, pricing against ${databaseName()}`);
