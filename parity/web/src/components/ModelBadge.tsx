import { useEffect, useState } from 'react';
import { cs } from '../copy';
import { fetchRuntime, type Runtime } from '../lib/api';

/**
 * Provider and model actually in use — read from the last successful run's init message,
 * not from configuration. A badge that showed what was configured would keep saying the
 * right thing after the routing broke, which is the one situation it exists for.
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
      {runtime.mode !== 'live' && <span className="badge-mode">{runtime.mode}</span>}
    </div>
  );
}
