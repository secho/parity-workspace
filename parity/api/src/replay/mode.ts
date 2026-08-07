import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { runtimeSettings } from '../db/schema.js';
import type { Config } from '../env.js';

/**
 * Which mode this process is actually in — `PARITY_MODE` unless someone has switched it since.
 *
 * The flag starts as an environment variable, and for a long time that was the whole story: to go
 * from live to replay you restarted the container. That is fine for a gate and wrong for a stage.
 * The demo is entirely replayed — live, mapping the estate is an hour and about $9 — so the one
 * setting that decides whether the next click costs nothing or costs an hour was the one thing a
 * presenter could not change without a terminal.
 *
 * So it is switchable at runtime, and three things keep that honest:
 *
 * 1. **Everything reads the effective value.** `isReplay()` is what the runner, the shadow harness
 *    and the classifier ask, and `/api/runtime` reports the same thing — so the badge in the
 *    corner cannot say `LIVE` while runs are being replayed. A flag that could be overridden
 *    without the display following would be worse than no switch at all.
 * 2. **It persists**, in `runtime_settings`. It did not, at first, and that was wrong twice in one
 *    afternoon: the container runs `tsx watch`, so any source edit restarts the process, and the
 *    mode silently reverted to `PARITY_MODE`. The next campaign then ran live — five minutes and
 *    $0,65 per procedure, on a stack whose badge had read REPLAY a moment earlier. A setting worth
 *    a switch is a setting worth surviving a restart.
 * 3. **A probe that forces a mode still wins.** `probe-replay` builds a config with `replay` and
 *    `probe-decision` one with `live`, and neither calls `loadMode`, so `activeMode` falls through
 *    to the config they built. The gates are immune to whatever the running app is set to, which
 *    is the property that matters most — and the commands that DO call `loadMode`, the ones that
 *    can spend, follow the switch. Before that, `make shadow-run` read the environment while the
 *    UI said replay, and the difference was $0,71 of `classify-diff` nobody asked for.
 */

const MODE_KEY = 'parity_mode';
const SPEED_KEY = 'parity_replay_speed';

let override: string | null = null;

export function activeMode(config: Config): string {
  return override ?? config.mode;
}

/**
 * Read the stored mode into this process. Called at API boot and by every command that can spend.
 *
 * A missing row means nobody has ever used the switch, so `PARITY_MODE` stands. Failures are
 * swallowed: this runs before migrations in some commands, and a platform that refused to start
 * because it could not read a preference would be worse than one that used the environment.
 */
export async function loadMode(db: Db): Promise<void> {
  try {
    const rows = await db.select().from(runtimeSettings);
    const mode = rows.find((r) => r.key === MODE_KEY)?.value;
    const speed = rows.find((r) => r.key === SPEED_KEY)?.value;
    if (mode === 'live' || mode === 'replay') override = mode;
    if (speed !== undefined) process.env.PARITY_REPLAY_SPEED = speed;
  } catch {
    // No table yet, or no database. The environment is the fallback and it is a good one.
  }
}

/** Write it down, so a restart — or `tsx watch` — cannot quietly undo it. */
export async function persistMode(db: Db, mode: string, speed?: number): Promise<void> {
  const upsert = async (key: string, value: string): Promise<void> => {
    await db
      .insert(runtimeSettings)
      .values({ key, value })
      .onConflictDoUpdate({ target: runtimeSettings.key, set: { value, updatedAt: new Date() } });
  };
  await upsert(MODE_KEY, mode);
  if (speed !== undefined) await upsert(SPEED_KEY, String(speed));
}

export function isReplay(config: Config): boolean {
  return activeMode(config) === 'replay';
}

/** Set by the API only, from `POST /api/demo/mode`. Never called from a CLI. */
export function setMode(mode: string): void {
  override = mode;
}

/**
 * How much the recorded gaps are divided by.
 *
 * Read from the environment on every call, so it is already switchable without a restart — the
 * route just writes `process.env`. 1 is the honest default: the replay takes exactly as long as
 * the run did.
 */
export const replaySpeed = (): number => {
  const raw = Number(process.env.PARITY_REPLAY_SPEED ?? 1);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
};

export function setReplaySpeed(speed: number): void {
  process.env.PARITY_REPLAY_SPEED = String(speed);
}

/**
 * Say which mode this command is about to run in, before it does anything that costs money.
 *
 * The runtime switch on `/rezie` changes the API process and nothing else — deliberately, because
 * the gates must be immune to whatever the running app happens to be set to. The consequence is a
 * genuine trap: the badge can read `REPLAY` while `make shadow-run` in a terminal reads
 * `PARITY_MODE` from the environment and spends real money. Found by doing exactly that — $0.71 of
 * `classify-diff` on a stack whose UI said replay.
 *
 * So every command that can spend announces its mode first. A line of output is not a fix for a
 * design that could surprise someone; it is the thing that turns a surprise into a decision.
 */
export function announceMode(config: Config): void {
  const mode = activeMode(config);
  if (mode === 'replay') {
    console.log(`mode: REPLAY ×${replaySpeed()} — served from the recordings, nothing will be spent\n`);
    return;
  }
  console.log(
    'mode: LIVE — this will call the model and cost real money.\n' +
      '      The switch on /rezie does NOT reach this process; set PARITY_MODE=replay to change it.\n',
  );
}
