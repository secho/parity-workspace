import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { cs } from '../copy';
import { fetchDemo, runBeat, type DemoBeat, type DemoState } from '../lib/api';

/**
 * Režie — the presenter's remote control for `docs/DEMO-SCRIPT.md`.
 *
 * **In the sidebar, but below the rule and deliberately quiet.** The four above it are what a
 * customer is meant to look at; this one is stage machinery, and a fifth item in the same weight
 * would tell the room that what they are watching is choreographed before the first beat lands.
 * Set in `--text-faint` at 10px under a divider it is findable by someone looking for it and
 * unreadable from the fifth row — which is the balance between "the presenter can get to it" and
 * "the audience never reads it".
 *
 * Every button posts to an endpoint that already existed and that a `make` target already used.
 * Nothing here is a second implementation of the demo; if this page and the script disagreed,
 * there would be no way to tell which was right.
 *
 * `hotovo` is derived by the API from the same rows the screens read — never a checklist this
 * page ticks off. A stored "beat 2 is done" drifts from the estate and then lies at the worst
 * possible moment.
 */

function Beat({ beat, busy, onRun }: { beat: DemoBeat; busy: string | null; onRun: (b: DemoBeat) => void }): JSX.Element {
  const running = busy === beat.key;

  return (
    <tr className={beat.done ? 'beat-done' : ''}>
      <td className="mono subtle beat-number">{beat.beat}</td>
      <td>
        <div className="beat-title">{beat.title}</div>
        <div className="subtle beat-detail">{beat.detail}</div>
      </td>
      <td className="subtle beat-note">{beat.note ?? cs.common.none}</td>
      <td className="mono subtle beat-expect">{beat.expect}</td>
      <td className="beat-action">
        {beat.path === null ? (
          beat.link === null ? null : (
            <Link className="btn btn-quiet" to={beat.link}>
              {cs.rezie.open}
            </Link>
          )
        ) : (
          <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => onRun(beat)}>
            {running ? cs.rezie.running : cs.rezie.run}
          </button>
        )}
      </td>
      <td className="beat-state">
        <span className={`chip ${beat.done ? 'good' : 'none'}`}>{beat.done ? cs.rezie.done : cs.rezie.pending}</span>
      </td>
    </tr>
  );
}

export function Rezie(): JSX.Element {
  const [state, setState] = useState<DemoState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const polling = useRef<number | null>(null);

  const load = (): Promise<void> => fetchDemo().then(setState, (err: Error) => setError(err.message));

  useEffect(() => {
    void load();
  }, []);

  // While a slow beat runs, the state is refreshed every second so the notes fill in as the work
  // lands — the campaign items, the case counts, the run numbers. Not a spinner: the numbers are
  // what the presenter is talking over.
  useEffect(() => {
    if (busy === null) {
      if (polling.current !== null) window.clearInterval(polling.current);
      polling.current = null;
      return undefined;
    }
    polling.current = window.setInterval(() => void load(), 1000);
    return () => {
      if (polling.current !== null) window.clearInterval(polling.current);
    };
  }, [busy]);

  const onRun = (beat: DemoBeat): void => {
    if (beat.path === null) return;
    setBusy(beat.key);
    setError(null);
    runBeat(beat.path, beat.body).then(
      () => {
        setBusy(null);
        void load();
      },
      (err: Error) => {
        setBusy(null);
        setError(`${beat.title}: ${err.message}`);
        void load();
      },
    );
  };

  if (error !== null && state === null)
    return (
      <p className="empty">
        {cs.common.error}: {error}
      </p>
    );
  if (state === null) return <p className="empty">{cs.common.loading}</p>;

  const doneCount = state.beats.filter((b) => b.done).length;

  return (
    <>
      <div className="topline">
        <h1>{cs.rezie.title}</h1>
        <span className="subtle">
          {cs.rezie.subtitle(doneCount, state.beats.length)}
          {' · '}
          <span className={`mono ${state.mode === 'replay' ? 'beat-replay' : 'beat-live'}`}>
            {state.mode}
            {state.replaySpeed !== null && state.replaySpeed !== 1 ? ` ×${state.replaySpeed}` : ''}
          </span>
        </span>
      </div>

      {state.warnings.map((warning) => (
        <p className="notice" key={warning}>
          {warning}
        </p>
      ))}
      {error !== null && <p className="notice">{error}</p>}

      <table className="beats">
        <thead>
          <tr>
            <th>{cs.rezie.columns.beat}</th>
            <th>{cs.rezie.columns.what}</th>
            <th>{cs.rezie.columns.state}</th>
            <th>{cs.rezie.columns.expect}</th>
            <th />
            <th />
          </tr>
        </thead>
        <tbody>
          {state.beats.map((beat) => (
            <Beat key={beat.key} beat={beat} busy={busy} onRun={onRun} />
          ))}
        </tbody>
      </table>

      <p className="subtle beat-footnote">{cs.rezie.footnote}</p>
    </>
  );
}
