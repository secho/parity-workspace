import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { cs } from '../copy';
import { fetchDemo, runBeat, setDemoMode, type DemoBeat, type DemoState } from '../lib/api';
import { usePoll } from '../lib/poll';

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

function Beat({
  beat,
  busy,
  justRan,
  onRun,
}: {
  beat: DemoBeat;
  busy: string | null;
  justRan: { key: string; ms: number } | null;
  onRun: (b: DemoBeat) => void;
}): JSX.Element {
  const running = busy === beat.key;
  const flash = justRan?.key === beat.key;

  return (
    <tr className={`${beat.done ? 'beat-done' : ''}${flash ? ' beat-flash' : ''}${running ? ' beat-running' : ''}`}>
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
        {/* What just happened, for a few seconds. The `note` beside it is the durable answer —
            this is the acknowledgement that the click landed, which the state chip alone does not
            give when a beat was already `hotovo` before it ran. */}
        {flash ? (
          <span className="chip good beat-just-ran">{cs.rezie.justRan((justRan?.ms ?? 0) / 1000)}</span>
        ) : running ? (
          <span className="chip warn">{cs.rezie.running}</span>
        ) : (
          <span className={`chip ${beat.done ? 'good' : 'none'}`}>{beat.done ? cs.rezie.done : cs.rezie.pending}</span>
        )}
      </td>
    </tr>
  );
}

export function Rezie(): JSX.Element {
  const [state, setState] = useState<DemoState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justRan, setJustRan] = useState<{ key: string; ms: number } | null>(null);

  const load = (): Promise<void> => fetchDemo().then(setState, (err: Error) => setError(err.message));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Always, not only while this page started something. A beat's effects can arrive from a
  // campaign running in the background, and the state can move because someone clicked in another
  // window — so the page keeps asking rather than assuming it is the only thing driving. Faster
  // while a beat is in flight, because that is when the notes fill in one by one.
  usePoll(load, busy === null ? 2000 : 1000, [busy]);

  const onRun = (beat: DemoBeat): void => {
    if (beat.path === null) return;
    setBusy(beat.key);
    setError(null);
    const started = Date.now();
    runBeat(beat.path, beat.body).then(
      () => {
        setBusy(null);
        setJustRan({ key: beat.key, ms: Date.now() - started });
        // Long enough to read while talking, short enough that it is gone before the next beat.
        window.setTimeout(() => setJustRan((current) => (current?.key === beat.key ? null : current)), 8000);
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
  const replay = state.mode === 'replay';

  const switchTo = (mode: 'live' | 'replay', speed?: number): void => {
    setSwitching(true);
    setError(null);
    setDemoMode(mode, speed).then(
      () => {
        setSwitching(false);
        void load();
      },
      (err: Error) => {
        setSwitching(false);
        // A 503 here means the replay source is not loaded, which has one fix and it is worth
        // printing rather than making someone read a status code.
        setError(err.message.startsWith('503') ? cs.rezie.sourceMissing : err.message);
      },
    );
  };

  return (
    <>
      <div className="topline">
        <h1>{cs.rezie.title}</h1>
        <span className="subtle">{cs.rezie.subtitle(doneCount, state.beats.length)}</span>
      </div>

      {/* The switch. Live, `Zmapovat estate` is an hour and about $9; replayed it is 94 seconds
          and nothing — and until now that difference was an environment variable and a container
          restart. It takes effect immediately and does not survive one. */}
      <div className="mode-switch">
        <span className="mode-label">{cs.rezie.mode}</span>
        <div className="mode-toggle">
          <button
            type="button"
            className={replay ? '' : 'active'}
            disabled={switching || busy !== null}
            onClick={() => switchTo('live')}
            title={cs.runtime.modeLiveTooltip}
          >
            {cs.rezie.modeLive}
          </button>
          <button
            type="button"
            className={replay ? 'active replay' : ''}
            disabled={switching || busy !== null}
            onClick={() => switchTo('replay')}
            title={cs.runtime.modeReplayTooltip}
          >
            {cs.rezie.modeReplay}
          </button>
        </div>

        {replay && (
          <>
            <span className="mode-label">{cs.rezie.speed}</span>
            <div className="mode-toggle" title={cs.rezie.speedHint}>
              {[1, 8, 40].map((speed) => (
                <button
                  key={speed}
                  type="button"
                  className={state.replaySpeed === speed ? 'active' : ''}
                  disabled={switching || busy !== null}
                  onClick={() => switchTo('replay', speed)}
                >
                  ×{speed}
                </button>
              ))}
            </div>
          </>
        )}

        <span className="subtle mode-hint">
          {state.mode === state.configuredMode ? cs.rezie.modeHint : cs.rezie.modeOverridden(state.configuredMode)}
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
            <Beat key={beat.key} beat={beat} busy={busy} justRan={justRan} onRun={onRun} />
          ))}
        </tbody>
      </table>

      <p className="subtle beat-footnote">{cs.rezie.footnote}</p>
    </>
  );
}
