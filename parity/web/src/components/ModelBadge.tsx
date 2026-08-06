import { useEffect, useState } from 'react';
import { cs } from '../copy';
import { fetchRuntime, type Runtime } from '../lib/api';

/**
 * Provider, model and MODE actually in use — read from the last successful run's init message,
 * not from configuration. A badge that showed what was configured would keep saying the
 * right thing after the routing broke, which is the one situation it exists for.
 *
 * The mode is always shown, including when it is `live`. It used to appear only when it was not,
 * which meant the single most likely on-stage failure — running a beat in the wrong mode — was
 * invisible in exactly one of its two directions: a replayed beat announced itself, and a beat
 * that was supposed to be replayed and quietly went live did not.
 */
export function ModelBadge(): JSX.Element | null {
  const [runtime, setRuntime] = useState<Runtime | null>(null);

  useEffect(() => {
    const load = (): void => void fetchRuntime().then(setRuntime, () => undefined);
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, []);

  if (runtime === null) return null;

  return (
    <div className="badge" title={runtime.baseUrl ?? cs.runtime.directTooltip}>
      <span className="badge-provider">{runtime.provider}</span>
      {runtime.lastModelUsed === null ? (
        <span className="badge-model none">
          {runtime.agentReady ? cs.runtime.noRunYet : cs.runtime.notConfigured}
        </span>
      ) : (
        <span className="badge-model">{runtime.lastModelUsed}</span>
      )}
      <span
        className={`badge-mode ${runtime.mode === 'live' ? 'live' : 'replay'}`}
        title={runtime.mode === 'live' ? cs.runtime.modeLiveTooltip : cs.runtime.modeReplayTooltip}
      >
        {runtime.mode === 'live' ? cs.runtime.modeLive : runtime.mode}
      </span>
    </div>
  );
}
