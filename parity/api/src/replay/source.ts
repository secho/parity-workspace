import { eq } from 'drizzle-orm';
import { openStore, type Db, type Store } from '../db/client.js';
import { procedures } from '../db/schema.js';
import type { Config } from '../env.js';

/**
 * The replay source — a second database holding the recorded analysis, which `make demo-reset`
 * cannot reach.
 *
 * This exists because of one thing that is easy to state and easy to miss: **the recordings ARE
 * the analysis.** `resetState()` truncates `agent_runs` and `agent_steps` along with everything
 * else, so a replay that read from the live database could only ever re-show what was already on
 * the screen. Beat 1 of the demo wants an empty estate; beats 2–4 want replay; and those two are
 * compatible only if the recordings live somewhere the reset does not go.
 *
 * So they live in `parity_replay`, built from the committed snapshot by `make load-replay-source`
 * — the same three commands `make replay-check` uses to prove that snapshot round-trips. Nothing
 * in the platform ever writes to it. It is opened lazily, because a stack running `PARITY_MODE=live`
 * should not need it to exist at all, and read through the same drizzle schema as everything else.
 *
 * **Identity across the two databases is by NAME, never by id.** `demo-reset` re-ingests, which
 * means `procedures.id` is assigned fresh; it happens to come out the same today because ingest is
 * deterministic, and relying on that would be a bug waiting for the first estate that changes.
 */

let store: Store | null = null;

export function replaySourceUrl(config: Config): string {
  return config.replayPgUrl;
}

/**
 * Open the source, once per process.
 *
 * Fails with the command that fixes it. A missing source is the single most likely way replay
 * mode is misconfigured, and "database parity_replay does not exist" on its own does not tell
 * anyone what to do about it.
 */
export async function replaySource(config: Config): Promise<Db> {
  if (store !== null) return store.db;

  const opened = openStore(config.replayPgUrl);
  try {
    await opened.pool.query('SELECT 1 FROM procedures LIMIT 1');
  } catch (err) {
    await opened.close().catch(() => undefined);
    throw new Error(
      `replay mode: the replay source at ${config.replayPgUrl} is not readable — ` +
        `${err instanceof Error ? err.message : String(err)}. Run \`make load-replay-source\`.`,
    );
  }

  store = opened;
  return store.db;
}

export async function closeReplaySource(): Promise<void> {
  if (store === null) return;
  const open = store;
  store = null;
  await open.close();
}

/** One procedure's id in whichever database is asked. Null when it is not there. */
export async function procedureIdByName(db: Db, name: string): Promise<number | null> {
  const [row] = await db.select({ id: procedures.id }).from(procedures).where(eq(procedures.name, name));
  return row?.id ?? null;
}
