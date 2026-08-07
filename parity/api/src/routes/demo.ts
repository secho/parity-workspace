import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { agentReadiness, prReadiness, type Config } from '../env.js';
import { beats, DEMO_SECOND, DEMO_TARGET } from '../demo/beats.js';
import { activeMode, isReplay, persistMode, replaySpeed, setMode, setReplaySpeed } from '../replay/mode.js';
import { replaySource } from '../replay/source.js';

/**
 * The presenter's remote control. One GET, and the buttons post to the endpoints that already
 * existed.
 *
 * It also answers the question the presenter cannot answer by looking: **which mode is this, and
 * what is the next beat going to cost.** Live, `Zmapovat estate` is 28 model runs, an hour and
 * about $9; replayed it is 94 seconds and nothing. That difference is one environment variable and
 * it used to be discoverable only by watching the first item take five minutes.
 */
export async function demoRoutes(app: FastifyInstance, db: Db, config: Config): Promise<void> {
  /**
   * Switch mode without a restart.
   *
   * The one setting that decides whether the next click costs nothing or costs an hour was the
   * one thing a presenter could not change without a terminal. It does not persist — restart the
   * container and `PARITY_MODE` wins again — and everything that decides reads the effective
   * value, so the badge in the corner cannot say `LIVE` while runs are being replayed.
   *
   * Switching TO replay checks the replay source first. A missing source is the most likely way
   * this is misconfigured, and the good moment to find out is when the switch is flipped rather
   * than four beats later in front of a room.
   */
  app.post<{ Body: { mode?: string; speed?: number } }>('/api/demo/mode', async (req, reply) => {
    const wanted = req.body?.mode;
    if (wanted !== 'live' && wanted !== 'replay') {
      return reply.code(400).send({ error: 'mode must be live or replay' });
    }

    if (wanted === 'replay') {
      try {
        await replaySource(config);
      } catch (err) {
        return reply.code(503).send({ error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (req.body?.speed !== undefined) {
      const speed = Number(req.body.speed);
      if (!Number.isFinite(speed) || speed <= 0) return reply.code(400).send({ error: 'speed must be a positive number' });
      setReplaySpeed(speed);
    }

    setMode(wanted);
    // Written down, not just held in memory. The container runs `tsx watch`, so any source edit
    // restarts this process — and a mode that silently reverted to the environment is how a
    // campaign ends up costing $9 on a stack whose badge said REPLAY.
    await persistMode(db, wanted, req.body?.speed === undefined ? undefined : Number(req.body.speed));
    app.log.warn(`PARITY_MODE switched to ${wanted} at runtime (env says ${config.mode})`);
    return { mode: activeMode(config), replaySpeed: replaySpeed(), configured: config.mode };
  });

  app.get('/api/demo', async () => {
    const replay = isReplay(config);
    return {
      mode: activeMode(config),
      /** What the environment says, which the switch above overrides for this process only. */
      configuredMode: config.mode,
      replaySpeed: replaySpeed(),
      target: DEMO_TARGET,
      second: DEMO_SECOND,
      agentReady: agentReadiness().ready,
      prReady: prReadiness(config).ready,
      /**
       * Warnings, in Czech, about the state the stack is in rather than about the estate.
       *
       * Empty is the normal answer and the page shows nothing. Absent is fine; a permanent banner
       * that says everything is fine is a banner nobody reads by the third rehearsal.
       */
      warnings: [
        replay
          ? null
          : 'Režim je LIVE. `Zmapovat estate` je 28 běhů modelu, hodina a ~$9 — pro demo přepni nahoře na replay.',
        agentReadiness().ready ? null : 'Agent není nakonfigurovaný: v .env chybí API klíč.',
        prReadiness(config).ready ? null : 'GitHub token chybí — PR nepůjde otevřít. Spusť `make github-token`.',
      ].filter((w): w is string => w !== null),
      beats: await beats(db),
    };
  });
}
