import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { campaignRuns, type CampaignRun } from '../db/schema.js';
import type { Config } from '../env.js';
import { findCampaign, type CampaignDefinition, type CampaignItem } from './definitions.js';

/**
 * Starting a campaign and running one are two different things, and the second must not
 * happen inside the request.
 *
 * `routes/agent.ts:35` awaits `executeRun` in its handler, which is fine for one twenty-second
 * skill run. `Zmapovat estate` is twenty-eight of them — ten minutes — and Vite's dev proxy
 * kills a request long before that, so the browser would report a failure while the sweep
 * carried on invisibly. So: the POST creates the row, returns it, and the work continues in the
 * background. The screen polls.
 *
 * A poll rather than a second SSE topic on purpose. Each item is one run of twenty to sixty
 * seconds, so a 1 Hz poll of `GET /api/campaigns/:id` is visually identical on stage and is
 * about fifteen lines against forty for making `routes/agent.ts`'s single-topic fan-out
 * multi-topic. The per-procedure step stream stays exactly where it is.
 */

/**
 * One campaign at a time, process-wide.
 *
 * Not a lock for correctness — two campaigns would not corrupt anything — but a refusal that
 * makes the failure legible. Two sweeps racing over the same fourteen procedures produce
 * interleaved runs, a doubled bill, and a progress table where nothing lines up. On a stage,
 * the cause of that would be a second click.
 */
let running: number | null = null;

/**
 * Held from the first line of `startCampaign` to the moment the row exists.
 *
 * Without it there is a window: `startCampaign` awaits three times — the running check, the
 * stale-row sweep, the item list — before it sets `running`, and two calls arriving inside that
 * window both find it null and both start. Two clicks a fraction of a second apart is exactly
 * how that happens on a stage. The check and the set are one synchronous statement here, which
 * on a single-threaded runtime is all "atomic" has to mean.
 */
let starting = false;

export interface StartOutcome {
  status: number;
  body: Record<string, unknown>;
}

export async function startCampaign(
  db: Db,
  config: Config,
  input: { campaign: string; target?: string | null },
): Promise<StartOutcome> {
  if (running !== null || starting) {
    const [current] = running === null ? [] : await db.select().from(campaignRuns).where(eq(campaignRuns.id, running));
    if (starting || current === undefined || current.status === 'running') {
      return {
        status: 409,
        body: { error: 'jiná kampaň už běží', runningId: running, campaign: current?.campaign ?? null },
      };
    }
    running = null;
  }

  const definition = findCampaign(input.campaign);
  if (definition === undefined) return { status: 404, body: { error: `no campaign named ${input.campaign}` } };

  const target = input.target ?? null;
  if (definition.needsTarget && (target === null || target === '')) {
    return { status: 400, body: { error: `${definition.key} needs a procedure`, needsTarget: true } };
  }

  starting = true;
  try {
    return await begin(db, config, definition, target);
  } finally {
    starting = false;
  }
}

async function begin(db: Db, config: Config, definition: CampaignDefinition, target: string | null): Promise<StartOutcome> {
  // A row left `running` by a process that died is not a running campaign. Marked rather than
  // ignored, because the screen reads the row and a permanently spinning campaign is worse
  // than a failed one.
  await db
    .update(campaignRuns)
    .set({ status: 'failed', error: 'proces byl restartován během běhu', finishedAt: new Date() })
    .where(eq(campaignRuns.status, 'running'));

  const planned = await definition.items(db, target);
  const items: CampaignItem[] = planned.map((entry) => ({
    ...entry,
    status: 'pending',
    detail: null,
    costUsd: null,
    durationMs: null,
  }));

  const [row] = await db
    .insert(campaignRuns)
    .values({ campaign: definition.key, target, status: 'running', items, total: items.length })
    .returning();

  running = row.id;
  // Deliberately not awaited. `void` rather than a bare call so that the intent is on the page
  // and a linter cannot mistake it for a forgotten await.
  void execute(db, config, definition, row.id).finally(() => {
    if (running === row.id) running = null;
  });

  return { status: 202, body: { run: row } };
}

async function execute(db: Db, config: Config, definition: CampaignDefinition, runId: number): Promise<void> {
  const [row] = await db.select().from(campaignRuns).where(eq(campaignRuns.id, runId));
  const items = row.items as CampaignItem[];
  let costUsd = 0;

  const save = async (): Promise<void> => {
    await db
      .update(campaignRuns)
      .set({
        items,
        done: items.filter((i) => i.status === 'done').length,
        skipped: items.filter((i) => i.status === 'skipped').length,
        failed: items.filter((i) => i.status === 'failed').length,
        costUsd: String(costUsd),
      })
      .where(eq(campaignRuns.id, runId));
  };

  try {
    for (const entry of items) {
      if (await definition.isComplete(db, entry)) {
        entry.status = 'skipped';
        entry.detail = 'už hotové';
        await save();
        continue;
      }

      entry.status = 'running';
      await save();

      const started = Date.now();
      try {
        const result = await definition.run(db, config, entry);
        entry.status = 'done';
        entry.detail = result.detail;
        entry.costUsd = result.costUsd;
        costUsd += result.costUsd;
      } catch (err) {
        // One item's failure does not end the campaign. A sweep that stopped at the first
        // refusal would leave thirteen procedures unmapped because of one, and the item row
        // carries the reason so nothing is lost by continuing.
        entry.status = 'failed';
        entry.detail = err instanceof Error ? err.message : String(err);
      }
      entry.durationMs = Date.now() - started;
      await save();
    }

    const failed = items.filter((i) => i.status === 'failed').length;
    await db
      .update(campaignRuns)
      .set({ status: failed === 0 ? 'succeeded' : 'failed', finishedAt: new Date() })
      .where(eq(campaignRuns.id, runId));
    await save();
  } catch (err) {
    await db
      .update(campaignRuns)
      .set({ status: 'failed', error: err instanceof Error ? err.message : String(err), finishedAt: new Date() })
      .where(eq(campaignRuns.id, runId));
  }
}

export const latestRuns = (db: Db, limit = 20): Promise<CampaignRun[]> =>
  db.select().from(campaignRuns).orderBy(desc(campaignRuns.id)).limit(limit);

export async function campaignRun(db: Db, id: number): Promise<CampaignRun | null> {
  const [row] = await db.select().from(campaignRuns).where(eq(campaignRuns.id, id));
  return row ?? null;
}
