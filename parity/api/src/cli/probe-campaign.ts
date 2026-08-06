// What `verify-m7` shells out to for the campaign section.
//
// The deletion campaign, because it is the only one of the three that makes no model call: its
// whole argument is a column of zeros, so a gate can run it end to end for nothing. Everything
// the section needs to know falls out of running it twice.
//
//   1. a start returns immediately — the row, not the result;
//   2. a second start, issued before the first has a row, is refused 409;
//   3. the items are exactly the zero-invocation procedures, plus the PR;
//   4. it writes `campaign_status = 'deleted'`, the value nothing else has ever written;
//   5. the PR is assembled with a tree of pure removals, and is NOT opened;
//   6. run again, it skips what it already did — which is what makes it rehearsable.
//
// Idempotent by construction, so the gate can run on a stack where beat 2 has already happened.

import { desc, eq, inArray } from 'drizzle-orm';
import { openStore, waitForPostgres } from '../db/client.js';
import { campaignRuns, procedures, pullRequests, type CampaignRun } from '../db/schema.js';
import { loadConfig } from '../env.js';
import { startCampaign } from '../campaign/run.js';
import type { CampaignItem } from '../campaign/definitions.js';

const config = loadConfig();
const store = openStore(config.pgUrl);
await waitForPostgres(store.pool);

const settle = async (id: number, timeoutMs = 120_000): Promise<CampaignRun> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await store.db.select().from(campaignRuns).where(eq(campaignRuns.id, id));
    if (row.status !== 'running') return row;
    if (Date.now() > deadline) throw new Error(`campaign ${id} did not finish within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

// --- 1 and 2 · start, and the refusal ------------------------------------------------------
//
// Both started in the same tick, deliberately. Over HTTP the second POST would arrive some
// milliseconds later and might legitimately find the first campaign finished — which would make
// this a test of how fast the machine is. Issued together, the answer is a property of the code.
const started = Date.now();
const firstPromise = startCampaign(store.db, config, { campaign: 'delete-dead' });
const second = await startCampaign(store.db, config, { campaign: 'delete-dead' });
const first = await firstPromise;
const startMs = Date.now() - started;

const runId = (first.body as { run?: { id: number } }).run?.id ?? -1;
const finished = await settle(runId);

// --- 3, 4 and 5 · what it did --------------------------------------------------------------
const dead = await store.db.select().from(procedures).where(eq(procedures.invocations90d, 0));
const deleted = await store.db.select().from(procedures).where(eq(procedures.campaignStatus, 'deleted'));

const [pr] = await store.db
  .select()
  .from(pullRequests)
  .where(eq(pullRequests.kind, 'deletion'))
  .orderBy(desc(pullRequests.id))
  .limit(1);

const prFiles = (pr?.files ?? []) as { path: string; contents: string | null }[];

// --- 6 · again ------------------------------------------------------------------------------
const again = await startCampaign(store.db, config, { campaign: 'delete-dead' });
const againId = (again.body as { run?: { id: number } }).run?.id ?? -1;
const rerun = await settle(againId);

// A campaign that needs a procedure, started without one.
const noTarget = await startCampaign(store.db, config, { campaign: 'migrate-procedure' });
const unknown = await startCampaign(store.db, config, { campaign: 'no-such-campaign' });

// The two runs this probe created go again, once they have been measured.
//
// What they DID is left alone — the three procedures stay `deleted` and the PR stays assembled,
// because that is estate state the campaign is supposed to produce and re-running is a no-op on
// it. What goes is the two `campaign_runs` rows, so that a gate run does not push gate noise onto
// the Kampaně screen or invalidate the committed snapshot it checks two sections later.
await store.db.delete(campaignRuns).where(inArray(campaignRuns.id, [runId, againId]));
const leftBehind = await store.db.select({ id: campaignRuns.id }).from(campaignRuns).where(inArray(campaignRuns.id, [runId, againId]));

console.log(
  JSON.stringify(
    {
      start: { status: first.status, elapsedMs: startMs, runId },
      concurrent: { status: second.status, error: (second.body as { error?: string }).error ?? null },
      run: {
        campaign: finished.campaign,
        status: finished.status,
        total: finished.total,
        done: finished.done,
        skipped: finished.skipped,
        failed: finished.failed,
        costUsd: Number(finished.costUsd ?? 0),
        items: (finished.items as CampaignItem[]).map((i) => ({ key: i.key, step: i.step, status: i.status, detail: i.detail })),
      },
      estate: {
        zeroInvocation: dead.map((p) => p.name).sort(),
        markedDeleted: deleted.map((p) => p.name).sort(),
      },
      pr: {
        exists: pr !== undefined,
        kind: pr?.kind ?? null,
        procedureId: pr?.procedureId ?? null,
        status: pr?.status ?? null,
        branch: pr?.branch ?? null,
        number: pr?.number ?? null,
        url: pr?.url ?? null,
        files: prFiles.map((f) => f.path),
        removals: prFiles.filter((f) => f.contents === null).length,
        additions: prFiles.filter((f) => f.contents !== null).length,
        bodyLength: pr?.body.length ?? 0,
      },
      rerun: { status: rerun.status, done: rerun.done, skipped: rerun.skipped, failed: rerun.failed, total: rerun.total },
      cleanedUp: leftBehind.length === 0,
      refusals: {
        missingTarget: { status: noTarget.status, error: (noTarget.body as { error?: string }).error ?? null },
        unknownCampaign: { status: unknown.status, error: (unknown.body as { error?: string }).error ?? null },
      },
    },
    null,
    2,
  ),
);

await store.pool.end();
