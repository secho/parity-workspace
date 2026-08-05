import type { Bucket } from '../lib/api';
import { formatInt } from '../copy';

/** Portfolio status across the top of Estate, weighted by invocations rather than by
 *  procedure count — the same reason coverage is weighted. */
const COLORS: Record<string, string> = {
  untouched: '#333a48',
  specced: '#4c6a9e',
  oracled: '#5b8fb9',
  shadow: '#6ea8fe',
  migrated: '#6bbf82',
  deleted: '#4a5261',
};

export function StatusBar({ buckets }: { buckets: Bucket[] }): JSX.Element {
  const total = buckets.reduce((sum, b) => sum + b.invocations90d, 0);
  const present = buckets.filter((b) => b.procedures > 0);

  return (
    <>
      <div className="statusbar">
        {present.map((bucket) => (
          <span
            key={bucket.status}
            title={`${bucket.label}: ${bucket.procedures}`}
            style={{
              width: total === 0 ? `${100 / present.length}%` : `${(bucket.invocations90d / total) * 100}%`,
              background: COLORS[bucket.status ?? ''] ?? '#333a48',
            }}
          />
        ))}
      </div>
      <div className="statusbar-legend">
        {present.map((bucket) => (
          <span key={bucket.status}>
            <i style={{ background: COLORS[bucket.status ?? ''] ?? '#333a48' }} />
            {bucket.label} · {bucket.procedures} · {formatInt(bucket.invocations90d)}
          </span>
        ))}
      </div>
    </>
  );
}
