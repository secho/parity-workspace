import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { cs, formatDate, formatInt } from '../copy';
import {
  fetchDecisions,
  fetchOracle,
  fetchProcedure,
  fetchPullRequest,
  fetchRuns,
  fetchService,
  fetchShadow,
  fetchSpec,
  type AgentRunInfo,
  type ColumnAccess,
  type DecisionRecord,
  type OracleResponse,
  type ProcedureResponse,
  type PullRequestRecord,
  type ServiceArtifactSet,
  type ShadowResponse,
} from '../lib/api';
import { usePoll } from '../lib/poll';

type Tab = 'source' | 'data' | 'coupling' | 'spec' | 'oracle' | 'shadow' | 'decisions' | 'service' | 'pr' | 'steps';

export function Procedure(): JSX.Element {
  const { name = '' } = useParams();
  const [data, setData] = useState<ProcedureResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('source');
  const [spec, setSpec] = useState<{ markdown: string; createdAt: string } | null>(null);
  const [oracle, setOracle] = useState<OracleResponse | null>(null);
  const [runs, setRuns] = useState<AgentRunInfo[]>([]);
  const [shadow, setShadow] = useState<ShadowResponse | null>(null);
  const [decisions, setDecisions] = useState<DecisionRecord[]>([]);
  const [pr, setPr] = useState<{ latest: PullRequestRecord | null; readiness: { ready: boolean; reason: string | null } } | null>(
    null,
  );
  const [service, setService] = useState<{ artifacts: ServiceArtifactSet | null; complete: boolean } | null>(null);

  /**
   * Everything this screen shows, re-read together.
   *
   * Split out of the mount effect so the poll below can call the same thing. Errors are swallowed
   * per-request on purpose: a poll that fails once should leave the last good data on screen
   * rather than blanking a page someone is presenting from.
   */
  const load = (): Promise<unknown> =>
    Promise.all([
      fetchProcedure(name).then(setData, (err: Error) => setError(err.message)),
      fetchSpec(name).then((r) => setSpec(r.spec), () => undefined),
      fetchOracle(name).then(setOracle, () => undefined),
      fetchRuns(name).then((r) => setRuns(r.runs), () => undefined),
      fetchShadow(name).then(setShadow, () => undefined),
      fetchDecisions(name).then((r) => setDecisions(r.decisions), () => undefined),
      fetchPullRequest(name).then(setPr, () => undefined),
      fetchService(name).then(setService, () => undefined),
    ]);

  useEffect(() => {
    setData(null);
    setSpec(null);
    setOracle(null);
    setRuns([]);
    setShadow(null);
    setDecisions([]);
    setPr(null);
    setService(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  // The beats fire from `/rezie`, the campaigns run in the background, and a decision can be
  // taken in another window. Without this the screen was a snapshot taken at mount and the only
  // way to see any of it was a reload.
  usePoll(load, 2000, [name]);

  // Agent steps arrive live while a run is in flight. They are persisted as they happen,
  // so this stream is a view onto the table rather than the only copy of it.
  useEffect(() => {
    const source = new EventSource(`/api/procedures/${encodeURIComponent(name)}/stream`);
    source.onmessage = () => {
      void fetchRuns(name).then((r) => setRuns(r.runs), () => undefined);
    };
    return () => source.close();
  }, [name]);

  if (error !== null) return <p className="empty">{cs.procedure.notFound}</p>;
  if (data === null) return <p className="empty">{cs.common.loading}</p>;

  const { procedure } = data;

  return (
    <>
      <div className="topline">
        <h1 className="mono">{procedure.name}</h1>
        <Link className="linkish" to="/">
          {cs.procedure.back}
        </Link>
      </div>

      <dl className="facts">
        <div>
          <dt>{cs.procedure.facts.lines}</dt>
          <dd>{procedure.lineCount}</dd>
        </div>
        <div>
          <dt>{cs.procedure.facts.invocations}</dt>
          <dd>{formatInt(procedure.invocations90d)}</dd>
        </div>
        <div>
          <dt>{cs.procedure.facts.lastInvoked}</dt>
          <dd>{formatDate(procedure.lastInvokedAt)}</dd>
        </div>
        <div>
          <dt>{cs.procedure.facts.oracleClass}</dt>
          <dd>{procedure.oracleClass ?? cs.common.none}</dd>
        </div>
        <div>
          <dt>{cs.procedure.facts.blocker}</dt>
          <dd>{procedure.blocker?.label ?? cs.common.none}</dd>
        </div>
        {procedure.usesDynamicSql && (
          <div>
            <dt>{cs.procedure.facts.dynamicSql}</dt>
            <dd>ano</dd>
          </div>
        )}
      </dl>

      {(data.calls.length > 0 || data.calledBy.length > 0) && (
        <p className="subtle" style={{ marginTop: 10 }}>
          {data.calls.length > 0 && (
            <>
              {cs.procedure.calls}:{' '}
              {data.calls.map((c, i) => (
                <span key={c}>
                  {i > 0 && ', '}
                  <Link className="mono linkish" to={`/procedura/${c}`}>
                    {c}
                  </Link>
                </span>
              ))}
              {data.calledBy.length > 0 && ' · '}
            </>
          )}
          {data.calledBy.length > 0 && (
            <>
              {cs.procedure.calledBy}:{' '}
              {data.calledBy.map((c, i) => (
                <span key={c}>
                  {i > 0 && ', '}
                  <Link className="mono linkish" to={`/procedura/${c}`}>
                    {c}
                  </Link>
                </span>
              ))}
            </>
          )}
        </p>
      )}

      <div className="tabs">
        <button className={tab === 'source' ? 'active' : ''} onClick={() => setTab('source')}>
          {cs.procedure.tabs.source}
        </button>
        <button className={tab === 'data' ? 'active' : ''} onClick={() => setTab('data')}>
          {cs.procedure.tabs.data}
        </button>
        <button className={tab === 'coupling' ? 'active' : ''} onClick={() => setTab('coupling')}>
          {cs.procedure.tabs.coupling}
        </button>
        <button className={tab === 'spec' ? 'active' : ''} onClick={() => setTab('spec')}>
          {cs.spec.title}
        </button>
        <button className={tab === 'oracle' ? 'active' : ''} onClick={() => setTab('oracle')}>
          {cs.oracle.title}
          {oracle !== null && oracle.goldenTests.length > 0 && (
            <span
              className={`chip ${oracle.goldenTests.some((g) => g.status === 'fail') ? 'bad' : 'good'}`}
              style={{ marginLeft: 6 }}
            >
              {oracle.goldenTests.length}
            </span>
          )}
        </button>
        <button className={tab === 'shadow' ? 'active' : ''} onClick={() => setTab('shadow')}>
          {cs.procedure.shadowTab}
          {shadow !== null && shadow.latestRun !== null && (
            <span
              className={`chip ${shadow.latestRun.behaviourDiffs > 0 ? 'warn' : 'good'}`}
              style={{ marginLeft: 6 }}
            >
              {shadow.latestRun.behaviourDiffs}
            </span>
          )}
        </button>
        <button className={tab === 'decisions' ? 'active' : ''} onClick={() => setTab('decisions')}>
          {cs.procedure.decisionsTab}
          {decisions.length > 0 && <span className="chip none" style={{ marginLeft: 6 }}>{decisions.length}</span>}
        </button>
        <button className={tab === 'service' ? 'active' : ''} onClick={() => setTab('service')}>
          {cs.service.tab}
          {service?.artifacts != null && <span className="tab-count">{service.artifacts.files.length}</span>}
        </button>
        <button className={tab === 'pr' ? 'active' : ''} onClick={() => setTab('pr')}>
          {cs.pr.title}
          {pr?.latest != null && (
            <span className={`chip ${pr.latest.status === 'open' ? 'good' : 'none'}`} style={{ marginLeft: 6 }}>
              {pr.latest.status === 'open' ? `#${pr.latest.number}` : cs.pr.assembledChip}
            </span>
          )}
        </button>
        <button className={tab === 'steps' ? 'active' : ''} onClick={() => setTab('steps')}>
          {cs.steps.title}
          {runs.length > 0 && <span className="chip none" style={{ marginLeft: 6 }}>{runs.length}</span>}
        </button>
      </div>

      {tab === 'spec' &&
        (spec === null ? (
          <p className="empty">{cs.spec.empty}</p>
        ) : (
          <>
            <p className="subtle">{cs.spec.generatedAt(new Date(spec.createdAt).toLocaleString('cs-CZ'))}</p>
            <div className="spec">{spec.markdown}</div>
          </>
        ))}

      {tab === 'oracle' &&
        (oracle === null || oracle.goldenTests.length === 0 ? (
          <p className="empty">{cs.oracle.empty}</p>
        ) : (
          <>
            <h2>{cs.oracle.goldenTitle}</h2>
            <p className="subtle">
              {cs.oracle.goldenHint}
              {oracle.latestRun !== null && (
                <>
                  {' · '}
                  {cs.oracle.passRate(oracle.latestRun.goldenPassed, oracle.latestRun.goldenPassed + oracle.latestRun.goldenFailed)}
                </>
              )}
            </p>
            <table>
              <thead>
                <tr>
                  <th>{cs.oracle.goldenTitle}</th>
                  <th>{cs.oracle.branch}</th>
                  <th>{cs.oracle.source}</th>
                  <th>{cs.oracle.normalised}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {oracle.goldenTests.map((test) => (
                  <tr key={test.id}>
                    <td className="name">
                      <span className="mono">{test.name}</span>
                      {test.rationale !== null && <div className="subtle">{test.rationale}</div>}
                      {test.status === 'fail' && test.detail !== null && (
                        <div className="subtle mono">{test.detail}</div>
                      )}
                    </td>
                    <td className="mono subtle">{test.branchKey ?? '—'}</td>
                    {/* Provenance, on screen. Every case points at the call it came from. */}
                    <td className="mono subtle">#{test.sourceInvocationId}</td>
                    <td className="mono subtle">{test.normalisations.join(' ') || '—'}</td>
                    <td>
                      <span
                        className={`chip ${test.status === 'pass' ? 'good' : test.status === null ? 'none' : 'bad'}`}
                      >
                        {test.status === 'pass' ? cs.oracle.pass : test.status === null ? cs.oracle.notRun : cs.oracle.fail}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h2>{cs.oracle.invariantsTitle}</h2>
            <p className="subtle">{cs.oracle.invariantsHint}</p>
            <table>
              <thead>
                <tr>
                  <th>{cs.oracle.invariantsTitle}</th>
                  <th className="num">{cs.oracle.checks}</th>
                  <th className="num">{cs.oracle.violations}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {oracle.invariants.map((rule) => (
                  <tr key={rule.id}>
                    <td className="name">
                      <span className="mono">{rule.name}</span>
                      {rule.rationale !== null && <div className="subtle">{rule.rationale}</div>}
                      {rule.firstViolation !== null && <div className="subtle mono">{rule.firstViolation}</div>}
                    </td>
                    <td className="num">{rule.evaluable ? rule.casesChecked : '—'}</td>
                    <td className="num">{rule.evaluable ? rule.casesViolated : '—'}</td>
                    <td>
                      {!rule.evaluable ? (
                        <span className="chip none" title={cs.oracle.advisoryHint}>
                          {cs.oracle.advisory}
                        </span>
                      ) : rule.casesChecked === 0 ? (
                        // Not the same as "broken everywhere". A pure read writes nothing, so
                        // a write-set rule has no rows to walk and has asserted nothing yet.
                        <span className="chip none" title={cs.oracle.notEvaluatedHint}>
                          {cs.oracle.notEvaluated}
                        </span>
                      ) : !rule.confirmed ? (
                        // Broken nearly everywhere: a mis-stated rule, not a finding. Shown
                        // with its counts rather than hidden — it is still a lead.
                        <span className="chip none" title={cs.oracle.unconfirmedHint}>
                          {cs.oracle.unconfirmed}
                        </span>
                      ) : (
                        <span className={`chip ${rule.casesViolated > 0 ? 'warn' : 'good'}`}>{rule.kind}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {oracle.invariants.some((r) => r.confirmed && r.casesViolated > 0) && (
              <p className="subtle" style={{ marginTop: 10 }}>
                {cs.oracle.violationHint}
              </p>
            )}
          </>
        ))}

      {tab === 'shadow' &&
        (shadow === null || shadow.latestRun === null ? (
          <p className="empty">{cs.shadow.empty}</p>
        ) : (
          <>
            <p className="subtle">{cs.shadow.hint}</p>

            <dl className="facts">
              <div>
                <dt>{cs.shadow.replayed}</dt>
                <dd>{formatInt(shadow.latestRun.casesReplayed)}</dd>
              </div>
              <div>
                <dt>{cs.shadow.strata}</dt>
                <dd>
                  {shadow.latestRun.strataCovered}/{shadow.latestRun.strataObserved}
                </dd>
              </div>
              <div>
                <dt>{cs.shadow.replayTime}</dt>
                <dd>{((shadow.latestRun.replayMs ?? 0) / 1000).toFixed(1)} s</dd>
              </div>
              <div>
                <dt>{cs.shadow.perCase}</dt>
                <dd>
                  {((shadow.latestRun.replayMs ?? 0) / Math.max(1, shadow.latestRun.casesReplayed)).toFixed(0)} ms
                </dd>
              </div>
              <div>
                <dt>{cs.shadow.against}</dt>
                <dd>{shadow.latestRun.implementation}</dd>
              </div>
              <div>
                <dt>{cs.shadow.database}</dt>
                <dd>{shadow.latestRun.shadowDatabase}</dd>
              </div>
            </dl>

            {/* The §8 claim, as three numbers: what differed, what code settled, what a human sees. */}
            <div className="shadow-flow">
              <div className="shadow-step">
                <b>{formatInt(shadow.latestRun.rawDiffs)}</b>
                <span>{cs.shadow.raw}</span>
              </div>
              <div className="shadow-step resolved">
                <b>{formatInt(shadow.latestRun.noiseDiffs)}</b>
                <span>{cs.shadow.resolvedInCode}</span>
              </div>
              <div className="shadow-step human">
                <b>{formatInt(shadow.latestRun.rawDiffs - shadow.latestRun.noiseDiffs)}</b>
                <span>{cs.shadow.reachedModel}</span>
              </div>
            </div>
            <p className="subtle">{cs.shadow.resolvedHint}</p>

            <h2 className="section-head">{cs.shadow.breakdownTitle}</h2>
            <table>
              <thead>
                <tr>
                  <th>{cs.shadow.columns.verdict}</th>
                  <th>{cs.shadow.columns.source}</th>
                  <th>{cs.shadow.columns.reason}</th>
                  <th className="num">{cs.shadow.columns.rows}</th>
                </tr>
              </thead>
              <tbody>
                {shadow.breakdown.map((row) => (
                  <tr key={`${row.verdict}-${row.verdictSource}-${row.noiseReason}`}>
                    <td>
                      <span className={`chip ${row.verdict === 'behaviour_change' ? 'warn' : 'good'}`}>
                        {row.verdict === 'behaviour_change'
                          ? cs.shadow.behaviourChange
                          : row.verdict === 'noise'
                            ? cs.shadow.noise
                            : cs.shadow.unclassified}
                      </span>
                    </td>
                    <td className="mono">
                      {row.verdictSource === 'canonicaliser' ? cs.shadow.sourceCanonicaliser : cs.shadow.sourceModel}
                    </td>
                    <td className="mono">{row.noiseReason ?? cs.common.none}</td>
                    <td className="num">{formatInt(row.n)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {shadow.findings.length > 0 && (
              <>
                <h2 className="section-head">{cs.shadow.findingsTitle}</h2>
                <table>
                  <thead>
                    <tr>
                      <th>{cs.shadow.columns.signature}</th>
                      <th className="num">{cs.shadow.columns.cases}</th>
                      <th className="num">{cs.shadow.columns.rows}</th>
                      <th>{cs.queue.reasoning}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shadow.findings.map((finding) => (
                      <tr key={finding.signature}>
                        <td className="mono">{finding.signature}</td>
                        <td className="num">{finding.cases}</td>
                        <td className="num">{finding.rowsAffected}</td>
                        <td>{finding.explanationCs ?? cs.common.none}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="subtle">
                  <Link className="linkish" to="/fronta">
                    {cs.queue.title} →
                  </Link>
                </p>
              </>
            )}
          </>
        ))}

      {/*
        Decisions belong to the PROCEDURE, not to the latest shadow run. The queue is scoped to
        the newest run because it shows work; this is the record, and it has to survive the
        green re-run that empties the queue.
      */}
      {tab === 'decisions' &&
        (decisions.length === 0 ? (
          <p className="empty">{cs.decisions.empty}</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>{cs.decisions.signature}</th>
                <th>{cs.decisions.action}</th>
                <th>{cs.decisions.by}</th>
                <th>{cs.decisions.run}</th>
                <th>{cs.decisions.note}</th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((d) => (
                <tr key={d.id}>
                  <td className="mono">{d.signature}</td>
                  <td>{cs.decisions.actions[d.action as keyof typeof cs.decisions.actions] ?? d.action}</td>
                  <td>{d.decidedBy === 'human' ? cs.decisions.human : d.decidedBy}</td>
                  <td className="subtle">{d.implementation}</td>
                  <td>{d.note ?? cs.common.none}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}

      {/*
        The service the agent wrote — which until now was in the database and nowhere on screen.
        `implement-service` is the most expensive run in the whole platform and the one the demo
        talks about most, and its output was invisible unless a PR had been assembled on top of it.
      */}
      {tab === 'service' &&
        (service?.artifacts == null ? (
          <p className="empty">{cs.service.empty}</p>
        ) : (
          <>
            <dl className="facts">
              <div>
                <dt>{cs.service.attempt}</dt>
                <dd className="mono">{service.artifacts.attempt}</dd>
              </div>
              <div>
                <dt>{cs.service.runHash}</dt>
                <dd className="mono">{service.artifacts.runHash.slice(0, 16)}</dd>
              </div>
              <div>
                <dt>{cs.service.complete}</dt>
                <dd>
                  <span className={`chip ${service.complete ? 'good' : 'warn'}`}>
                    {service.complete ? cs.service.yes : cs.service.no}
                  </span>
                </dd>
              </div>
            </dl>
            <p className="subtle">{cs.service.hint}</p>
            {service.artifacts.files.map((file) => (
              <div key={file.path} className="service-file">
                <h3 className="mono">
                  {file.path}
                  <span className="subtle service-sha">
                    {' '}
                    sha256 {file.sha256.slice(0, 12)} · {file.contents.length} znaků
                  </span>
                </h3>
                <pre className="mono source">{file.contents}</pre>
              </div>
            ))}
          </>
        ))}

      {/*
        Absent, never simulated. Without a token there is no URL, and what goes where the URL
        would be is the reason there is no URL — not a plausible-looking link.
      */}
      {tab === 'pr' &&
        (pr === null || pr.latest === null ? (
          <p className="empty">{cs.pr.empty}</p>
        ) : (
          <>
            <dl className="facts">
              <div>
                <dt>{cs.pr.status}</dt>
                <dd>{cs.pr.statuses[pr.latest.status as keyof typeof cs.pr.statuses] ?? pr.latest.status}</dd>
              </div>
              <div>
                <dt>{cs.pr.branch}</dt>
                <dd className="mono">
                  {pr.latest.branch} → {pr.latest.baseBranch}
                </dd>
              </div>
              <div>
                <dt>{cs.pr.repo}</dt>
                <dd className="mono">
                  {pr.latest.owner}/{pr.latest.repo}
                </dd>
              </div>
              <div>
                <dt>{cs.pr.artifact}</dt>
                <dd className="mono">{pr.latest.artifactHash.slice(0, 12)}</dd>
              </div>
            </dl>

            {pr.latest.url === null ? (
              <p className="subtle">{pr.readiness.ready ? cs.pr.notOpened : `${cs.pr.blocked} ${pr.readiness.reason ?? ''}`}</p>
            ) : (
              <p>
                <a className="mono" href={pr.latest.url} target="_blank" rel="noreferrer">
                  {pr.latest.url}
                </a>
              </p>
            )}

            <h3>{cs.pr.files}</h3>
            <ul className="mono">
              {pr.latest.files.map((f) => (
                <li key={f.path}>{f.path}</li>
              ))}
            </ul>

            <h3>{cs.pr.body}</h3>
            <pre className="source">{pr.latest.body}</pre>
          </>
        ))}

      {tab === 'steps' &&
        (runs.length === 0 ? (
          <p className="empty">{cs.steps.empty}</p>
        ) : (
          runs.map((run) => (
            <div className="run" key={run.runId}>
              <div className="run-head">
                <span className="skill">{run.skill}</span>
                <span>{run.model ?? cs.common.none}</span>
                <span>
                  {run.numTurns ?? 0} {cs.steps.turns}
                </span>
                {run.inputTokens !== null && (
                  <span>
                    {cs.steps.tokens} {formatInt(run.inputTokens)} / {formatInt(run.outputTokens ?? 0)}
                  </span>
                )}
                {run.costUsd !== null && <span>{cs.steps.cost} ${Number(run.costUsd).toFixed(4)}</span>}
                <span className={`chip ${run.status === 'succeeded' ? 'good' : run.status === 'blocked' ? 'warn' : 'bad'}`}>
                  {run.status}
                </span>
              </div>
              {run.steps.map((step) => (
                <div className="step" key={step.seq}>
                  <span className="seq">{step.seq}</span>
                  {step.toolName !== null && <span className="tool">{step.toolName}</span>}
                  <span className="body">{step.text ?? ''}</span>
                </div>
              ))}
            </div>
          ))
        ))}

      {tab === 'source' && <pre className="source">{procedure.sourceSql}</pre>}

      {tab === 'data' && (
        <div className="two-col">
          <div>
            <h2>
              {cs.procedure.writesTitle} · {data.writes.length}
            </h2>
            <ColumnList columns={data.writes} showOwner />
          </div>
          <div>
            <h2>
              {cs.procedure.readsTitle} · {data.reads.length}
            </h2>
            <ColumnList columns={data.reads} />
          </div>
        </div>
      )}

      {tab === 'coupling' && (
        <>
          <p className="subtle">{cs.procedure.couplingHint}</p>
          <h2>{cs.procedure.couplingTitle}</h2>
          {data.coupling.length === 0 ? (
            <p className="empty">{cs.procedure.noCoupling}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{cs.procedure.column}</th>
                  <th>{cs.procedure.alsoWrites}</th>
                  <th className="num">{cs.procedure.writers}</th>
                </tr>
              </thead>
              <tbody>
                {data.coupling.map((edge, i) => (
                  <tr key={`${edge.tableName}.${edge.columnName}.${edge.other}.${i}`}>
                    <td className="name">
                      {edge.tableName}.{edge.columnName}
                    </td>
                    <td>
                      <Link className="mono linkish" to={`/procedura/${edge.other}`}>
                        {edge.other}
                      </Link>
                    </td>
                    <td className="num">
                      {/* Two writers is a collision worth reading. Six is an audit column. */}
                      <span className={`chip ${edge.writers <= 2 ? 'warn' : 'none'}`}>{edge.writers}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}

function ColumnList({ columns, showOwner = false }: { columns: ColumnAccess[]; showOwner?: boolean }): JSX.Element {
  if (columns.length === 0) return <p className="empty">{cs.common.none}</p>;
  return (
    <table>
      <tbody>
        {columns.map((c) => (
          <tr key={`${c.tableName}.${c.columnName}`}>
            <td className="name">
              {c.tableName}.{c.columnName}
            </td>
            <td style={{ textAlign: 'right' }}>
              {showOwner && c.isWriteOwner && <span className="chip good">{cs.procedure.owner}</span>}
              {c.inferred && (
                <span className="chip warn" title={cs.procedure.inferredHint} style={{ marginLeft: 8 }}>
                  {cs.procedure.inferred}
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
