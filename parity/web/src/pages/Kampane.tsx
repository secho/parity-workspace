import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { cs, formatInt } from '../copy';
import {
  fetchCampaigns,
  fetchCampaignRun,
  fetchEstate,
  startCampaign,
  type CampaignDefinitionInfo,
  type CampaignItemInfo,
  type CampaignRunInfo,
} from '../lib/api';
import { usePoll } from '../lib/poll';

/**
 * Kampaně — hromadná práce nad estate.
 *
 * Polls at 1 Hz while something is running, and not at all when nothing is. Each item is one
 * agent run of twenty to sixty seconds, so a poll is visually indistinguishable from a stream
 * on stage — and it is fifteen lines against forty for making the procedure page's SSE topic
 * carry a second kind of event.
 *
 * Nothing here is simulated. An item that has not started says `čeká`, and an item that was
 * already done before the campaign began says `přeskočeno` and stays that way — the honest
 * answer on a second run, and the one that lets `Zmapovat estate` be started in front of an
 * audience without spending seven dollars to show it working.
 */

/** The second procedure — the one with a generated service, so its lane can finish. */
const MIGRATION_DEFAULT = 'sp_GetCartSummary';

const ITEM_TONE: Record<string, string> = {
  pending: 'none',
  running: 'warn',
  done: 'good',
  skipped: 'none',
  failed: 'bad',
};

const duration = (ms: number | null): string => {
  if (ms === null) return cs.common.none;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
};

function Items({ run }: { run: CampaignRunInfo }): JSX.Element {
  return (
    <table>
      <thead>
        <tr>
          <th>{cs.campaigns.columns.item}</th>
          <th>{cs.campaigns.columns.status}</th>
          <th>{cs.campaigns.columns.detail}</th>
          <th className="num">{cs.campaigns.columns.duration}</th>
        </tr>
      </thead>
      <tbody>
        {run.items.map((item: CampaignItemInfo) => (
          <tr key={item.key}>
            <td className="name">
              {item.procedure === null ? (
                item.label
              ) : (
                <Link className="mono linkish" to={`/procedura/${encodeURIComponent(item.procedure)}`}>
                  {item.label}
                </Link>
              )}
            </td>
            <td>
              <span className={`chip ${ITEM_TONE[item.status] ?? ''}`}>
                {cs.campaigns.itemStatus[item.status] ?? item.status}
              </span>
            </td>
            <td className="subtle audit-detail">{item.detail ?? cs.common.none}</td>
            <td className="num subtle">{duration(item.durationMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Kampane(): JSX.Element {
  const [definitions, setDefinitions] = useState<CampaignDefinitionInfo[] | null>(null);
  const [runs, setRuns] = useState<CampaignRunInfo[]>([]);
  const [agentReady, setAgentReady] = useState(true);
  const [procedureNames, setProcedureNames] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [watching, setWatching] = useState<number | null>(null);
  const busy = useRef(false);

  const load = (): void => {
    void fetchCampaigns().then((data) => {
      setDefinitions(data.campaigns);
      setRuns(data.runs);
      setAgentReady(data.agentReady.ready);
      const active = data.runs.find((run) => run.status === 'running');
      setWatching(active?.id ?? null);
    }, (err: Error) => setError(err.message));
  };

  useEffect(load, []);

  // Campaigns are fire-and-forget and can be started from `/rezie` as well as from here, so this
  // screen has to keep asking rather than assume it started everything it shows.
  usePoll(() => void load());

  useEffect(() => {
    void fetchEstate().then((estate) => {
      const names = estate.procedures.map((p) => p.name).sort();
      setProcedureNames(names);
      // Defaults to the procedure that has a service to replay against, not to whichever name
      // sorts first. The migration campaign ends in a shadow run, and a shadow run against a
      // procedure the generated service does not serve is refused — correctly, and loudly, but
      // it is not a thing to discover by clicking `Spustit` in front of a room.
      setTarget((current) => (current === '' ? (names.find((n) => n === MIGRATION_DEFAULT) ?? names[0] ?? '') : current));
    }, () => undefined);
  }, []);

  // Only while something is running. A screen that polls an idle API once a second for the whole
  // of a nine-minute demo is a screen that is doing something for no reason.
  useEffect(() => {
    if (watching === null) return undefined;
    const timer = setInterval(() => {
      void fetchCampaignRun(watching).then(({ run }) => {
        setRuns((current) => [run, ...current.filter((r) => r.id !== run.id)]);
        if (run.status !== 'running') {
          setWatching(null);
          load();
        }
      }, () => undefined);
    }, 1000);
    return () => clearInterval(timer);
  }, [watching]);

  const start = (definition: CampaignDefinitionInfo): void => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    startCampaign(definition.key, definition.needsTarget ? target : undefined).then(
      ({ run }) => {
        busy.current = false;
        setRuns((current) => [run, ...current]);
        setWatching(run.id);
      },
      (err: Error) => {
        busy.current = false;
        setError(err.message.startsWith('409') ? cs.campaigns.concurrent : err.message);
      },
    );
  };

  if (error !== null && definitions === null)
    return (
      <p className="empty">
        {cs.common.error}: {error}
      </p>
    );
  if (definitions === null) return <p className="empty">{cs.common.loading}</p>;

  const latest = runs[0] ?? null;
  const running = runs.find((run) => run.status === 'running') ?? null;

  return (
    <>
      <div className="topline">
        <h1>{cs.campaigns.title}</h1>
        <span className="subtle">{cs.campaigns.subtitle}</span>
      </div>

      {!agentReady && <p className="notice">{cs.campaigns.agentBlocked}</p>}
      {error !== null && <p className="notice">{error}</p>}

      <div className="campaign-cards">
        {definitions.map((definition) => (
          <div className="campaign-card" key={definition.key}>
            <h3>{definition.title}</h3>
            <p className="subtle">{definition.description}</p>
            <div className="campaign-actions">
              {definition.needsTarget && (
                <select className="mono" value={target} onChange={(e) => setTarget(e.target.value)}>
                  {procedureNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="btn btn-primary"
                disabled={running !== null}
                onClick={() => start(definition)}
              >
                {running?.campaign === definition.key ? cs.campaigns.running : cs.campaigns.start}
              </button>
            </div>
          </div>
        ))}
      </div>

      {latest === null ? (
        <p className="empty">{cs.campaigns.empty}</p>
      ) : (
        <>
          <h2>
            {cs.campaigns.lastRun} · {definitions.find((d) => d.key === latest.campaign)?.title ?? latest.campaign}
            {latest.target === null ? '' : ` · ${latest.target}`}
          </h2>
          <p className="subtle">
            <span className={`chip ${latest.status === 'failed' ? 'bad' : latest.status === 'running' ? 'warn' : 'good'}`}>
              {cs.campaigns.runStatus[latest.status] ?? latest.status}
            </span>
            {' · '}
            {cs.campaigns.progress(latest.done + latest.skipped, latest.total)}
            {latest.skipped > 0 && ` · ${cs.campaigns.skipped(latest.skipped)}`}
            {latest.failed > 0 && ` · ${cs.campaigns.failed(latest.failed)}`}
            {Number(latest.costUsd ?? 0) > 0 && ` · ${cs.campaigns.cost} $${Number(latest.costUsd).toFixed(2)}`}
          </p>
          <Items run={latest} />
        </>
      )}

      {runs.length > 1 && (
        <>
          <h2>{cs.campaigns.history}</h2>
          <table>
            <thead>
              <tr>
                <th>{cs.campaigns.historyColumns.campaign}</th>
                <th>{cs.campaigns.historyColumns.status}</th>
                <th className="num">{cs.campaigns.historyColumns.items}</th>
                <th className="num">{cs.campaigns.historyColumns.cost}</th>
              </tr>
            </thead>
            <tbody>
              {runs.slice(1).map((run) => (
                <tr key={run.id}>
                  <td className="name">
                    {definitions.find((d) => d.key === run.campaign)?.title ?? run.campaign}
                    {run.target === null ? '' : ` · ${run.target}`}
                  </td>
                  <td>
                    <span className={`chip ${run.status === 'failed' ? 'bad' : 'good'}`}>
                      {cs.campaigns.runStatus[run.status] ?? run.status}
                    </span>
                  </td>
                  <td className="num subtle">
                    {formatInt(run.done + run.skipped)} / {formatInt(run.total)}
                  </td>
                  <td className="num subtle">${Number(run.costUsd ?? 0).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
