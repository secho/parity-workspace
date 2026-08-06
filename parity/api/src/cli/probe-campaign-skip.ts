// The other half of the campaign section: `Zmapovat estate` on an estate that is already mapped.
//
// This is the change that gives beat 2 an honest answer to its timing problem. The campaign is
// twenty-eight live model runs and about seven dollars; that does not fit in a two-minute beat
// and never will. Skipping what is already done means the same button, pressed in the room,
// finishes in seconds and reports *14 přeskočeno* — which is true, rather than a progress bar
// pretending to have re-run work it did not.
//
// **It refuses to run if the estate is not fully mapped.** A gate that could accidentally spend
// $7.12 is a gate that eventually does. The refusal is the finding in that case, and the check
// that reads this output fails on it rather than passing quietly.

import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { openStore, waitForPostgres } from '../db/client.js';
import { agentRuns, campaignRuns, procedures, specs, type CampaignRun } from '../db/schema.js';
import { loadConfig } from '../env.js';
import { startCampaign } from '../campaign/run.js';
import type { CampaignItem } from '../campaign/definitions.js';

const config = loadConfig();
const store = openStore(config.pgUrl);
await waitForPostgres(store.pool);

const [{ n: total }] = await store.db.select({ n: sql<number>`count(*)::int` }).from(procedures);
const [{ n: mapped }] = await store.db
  .select({ n: sql<number>`count(*)::int` })
  .from(procedures)
  .innerJoin(specs, eq(specs.procedureId, procedures.id))
  .where(isNotNull(procedures.oracleClass));

const [{ total: spendBefore }] = await store.db
  .select({ total: sql<string>`coalesce(sum(${agentRuns.costUsd}), 0)` })
  .from(agentRuns);

if (mapped < total) {
  console.log(
    JSON.stringify(
      {
        ran: false,
        refused: `${total - mapped} of ${total} procedures are not mapped — running this would be ${
          (total - mapped) * 2
        } live model runs`,
        total,
        mapped,
      },
      null,
      2,
    ),
  );
  await store.pool.end();
  process.exit(0);
}

const started = Date.now();
const outcome = await startCampaign(store.db, config, { campaign: 'map-estate' });
const runId = (outcome.body as { run?: { id: number } }).run?.id ?? -1;

const settle = async (id: number, timeoutMs = 120_000): Promise<CampaignRun> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await store.db.select().from(campaignRuns).where(and(eq(campaignRuns.id, id)));
    if (row.status !== 'running') return row;
    if (Date.now() > deadline) throw new Error(`campaign ${id} did not finish within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

const run = await settle(runId);
const elapsedMs = Date.now() - started;

const [{ total: spendAfter }] = await store.db
  .select({ total: sql<string>`coalesce(sum(${agentRuns.costUsd}), 0)` })
  .from(agentRuns);

// Removed once measured, like every other row this gate creates. Nothing was done, so nothing is
// lost — every item was skipped by definition, which is the whole point of the check.
await store.db.delete(campaignRuns).where(eq(campaignRuns.id, runId));
const leftBehind = await store.db.select({ id: campaignRuns.id }).from(campaignRuns).where(eq(campaignRuns.id, runId));

console.log(
  JSON.stringify(
    {
      ran: true,
      status: run.status,
      total: run.total,
      done: run.done,
      skipped: run.skipped,
      failed: run.failed,
      elapsedMs,
      // The number this whole change is for: nothing was spent, because nothing was re-run.
      spendMoved: Number(spendAfter) !== Number(spendBefore),
      costUsd: Number(run.costUsd ?? 0),
      cleanedUp: leftBehind.length === 0,
      items: (run.items as CampaignItem[]).map((i) => ({ key: i.key, status: i.status })),
    },
    null,
    2,
  ),
);

await store.pool.end();
