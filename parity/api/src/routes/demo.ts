import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { agentReadiness, prReadiness, type Config } from '../env.js';
import { beats, DEMO_SECOND, DEMO_TARGET } from '../demo/beats.js';
import { replaySpeed } from '../replay/stream.js';

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
  app.get('/api/demo', async () => {
    const replay = config.mode === 'replay';
    return {
      mode: config.mode,
      replaySpeed: replay ? replaySpeed() : null,
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
          : 'Stack běží naživo. `Zmapovat estate` je 28 běhů modelu, hodina a ~$9 — pro demo přepni na `PARITY_MODE=replay`.',
        agentReadiness().ready ? null : 'Agent není nakonfigurovaný: v .env chybí API klíč.',
        prReadiness(config).ready ? null : 'GitHub token chybí — PR nepůjde otevřít. Spusť `make github-token`.',
      ].filter((w): w is string => w !== null),
      beats: await beats(db),
    };
  });
}
