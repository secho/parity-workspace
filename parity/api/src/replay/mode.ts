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
 * 2. **It does not persist.** Restart the container and it is `PARITY_MODE` again. The environment
 *    stays the source of truth for how the stack is *configured*; this is a deliberate override
 *    for the length of one session, and it announces itself as one.
 * 3. **CLI processes never touch it.** They construct their own `Config` — `probe-replay` forces
 *    replay, `probe-decision` forces live — and since nothing calls `setMode` in those processes,
 *    `isReplay` falls through to the config they built. The gate is unaffected by whatever the
 *    running API happens to be set to, which is the property that matters most.
 */

let override: string | null = null;

export function activeMode(config: Config): string {
  return override ?? config.mode;
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
