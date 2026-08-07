import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { cs, formatInt } from '../copy';
import { decide, fetchQueue, fetchQueueSummary, undecide, type QueueItem, type QueueSummary } from '../lib/api';
import { usePoll } from '../lib/poll';

/**
 * Fronta rozhodnutí — the only screen in Parity where a human is asked for something.
 *
 * What reaches it is deliberately narrow. A shadow run produces well over a thousand raw
 * differences; canonicalisation resolves almost all of them in code, the classifier sorts what
 * is left, and only `behaviour_change` arrives here. The header says both numbers on purpose:
 * the value of the machine is the gap between them.
 */

const value = (input: unknown): string => {
  if (input === null || input === undefined) return cs.common.none;
  if (typeof input === 'object') return JSON.stringify(input);
  return String(input);
};

function Sides({ item }: { item: QueueItem }): JSX.Element {
  return (
    <div className="two-col diff-sides">
      <div className="diff-side diff-old">
        <h4>{cs.queue.old}</h4>
        <pre className="mono">{value(item.sample?.oldValue)}</pre>
      </div>
      <div className="diff-side diff-new">
        <h4>{cs.queue.new}</h4>
        <pre className="mono">{value(item.sample?.newValue)}</pre>
      </div>
    </div>
  );
}

function Item({ item, onChange }: { item: QueueItem; onChange: () => Promise<unknown> }): JSX.Element {
  const [busy, setBusy] = useState(false);

  const act = (action: string): void => {
    setBusy(true);
    decide(item.signature, action, item.shadowRunId).then(
      () => {
        setBusy(false);
        void onChange();
      },
      () => setBusy(false),
    );
  };

  const revert = (): void => {
    setBusy(true);
    undecide(item.signature).then(
      () => {
        setBusy(false);
        void onChange();
      },
      () => setBusy(false),
    );
  };

  const where =
    item.tableName === null
      ? (item.columnName ?? item.scope)
      : `${item.tableName}${item.columnName === null ? '' : `.${item.columnName}`}`;

  return (
    <article className="queue-item">
      <header className="queue-head">
        <div>
          <span className="mono queue-where">{where}</span>
          <Link className="linkish mono queue-proc" to={`/procedura/${encodeURIComponent(item.procedure)}`}>
            {item.procedure}
          </Link>
        </div>
        <div className="subtle">
          {cs.queue.affected(item.cases, item.rowsAffected)}
          {' · '}
          {item.ownerTeam ?? cs.queue.unassigned}
          {item.riskClass === null ? '' : ` · ${item.riskClass}`}
        </div>
      </header>

      <Sides item={item} />

      {item.sample !== null && (
        <p className="subtle queue-sample">
          {cs.queue.sample}: <span className="mono">{JSON.stringify(item.sample.inputParams)}</span>
          {' · '}
          <span className="mono">#{item.sample.sourceInvocationId}</span>
        </p>
      )}

      {item.explanationCs !== null && (
        <div className="queue-reasoning">
          <h4>{cs.queue.reasoning}</h4>
          <p>{item.explanationCs}</p>
        </div>
      )}

      {item.decision === null ? (
        <div className="queue-actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('preserve')}>
            {cs.queue.actions.preserve}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => act('accept')}>
            {cs.queue.actions.accept}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => act('escalate')}>
            {cs.queue.actions.escalate}
          </button>
          <span className="subtle queue-hint">{cs.queue.preserveHint}</span>
        </div>
      ) : (
        <div className="queue-actions">
          <span className="chip good">{cs.queue.decided[item.decision.action] ?? item.decision.action}</span>
          <button type="button" className="btn btn-quiet" disabled={busy} onClick={revert}>
            {cs.queue.undo}
          </button>
        </div>
      )}
    </article>
  );
}

export default function Fronta(): JSX.Element {
  const [queue, setQueue] = useState<{ open: QueueItem[]; decided: QueueItem[] } | null>(null);
  const [summary, setSummary] = useState<QueueSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (): Promise<unknown> =>
    Promise.all([
      fetchQueue().then(setQueue, (err: Error) => setError(err.message)),
      fetchQueueSummary().then(setSummary, () => undefined),
    ]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A shadow run fired from `/rezie` fills this screen. Without the poll it stayed empty until
  // someone reloaded, which is the worst possible moment for a reload — beat 4 opens on it.
  usePoll(load);

  if (error !== null)
    return (
      <p className="empty">
        {cs.common.error}: {error}
      </p>
    );
  if (queue === null || summary === null) return <p className="empty">{cs.common.loading}</p>;

  return (
    <section>
      {/* Stacked rather than spread across the topline: the runtime badge is pinned top-right
          and a third inline element runs underneath it. */}
      <div className="topline queue-topline">
        <h1>{cs.queue.title}</h1>
        {/* No run means no counter. A row of zeros beside "nothing has run yet" reads as a
            result rather than as an absence, and this is the state beat 1 opens on. */}
        {summary.latestRun !== null && (
          <>
            <p className="subtle">{cs.queue.counter(formatInt(summary.rawDiffs), summary.reachedHuman)}</p>
            {summary.resolvedInCode > 0 && (
              <p className="subtle">{cs.queue.resolvedInCode(formatInt(summary.resolvedInCode))}</p>
            )}
          </>
        )}
      </div>

      {queue.open.length === 0 && queue.decided.length === 0 ? (
        <p className="empty">{summary.latestRun === null ? cs.queue.emptyNoRun : cs.queue.empty}</p>
      ) : null}

      {queue.open.length > 0 && (
        <>
          <h2 className="section-head">{cs.queue.openTitle}</h2>
          {queue.open.map((item) => (
            <Item key={`${item.shadowRunId}:${item.signature}`} item={item} onChange={load} />
          ))}
        </>
      )}

      {queue.decided.length > 0 && (
        <>
          <h2 className="section-head">{cs.queue.decidedTitle}</h2>
          {queue.decided.map((item) => (
            <Item key={`${item.shadowRunId}:${item.signature}`} item={item} onChange={load} />
          ))}
        </>
      )}
    </section>
  );
}
