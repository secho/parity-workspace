import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { cs, formatDate, formatInt } from '../copy';
import {
  fetchOracle,
  fetchProcedure,
  fetchRuns,
  fetchSpec,
  type AgentRunInfo,
  type ColumnAccess,
  type OracleResponse,
  type ProcedureResponse,
} from '../lib/api';

type Tab = 'source' | 'data' | 'coupling' | 'spec' | 'oracle' | 'steps';

export function Procedure(): JSX.Element {
  const { name = '' } = useParams();
  const [data, setData] = useState<ProcedureResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('source');
  const [spec, setSpec] = useState<{ markdown: string; createdAt: string } | null>(null);
  const [oracle, setOracle] = useState<OracleResponse | null>(null);
  const [runs, setRuns] = useState<AgentRunInfo[]>([]);

  useEffect(() => {
    setData(null);
    setSpec(null);
    setOracle(null);
    setRuns([]);
    fetchProcedure(name).then(setData, (err: Error) => setError(err.message));
    void fetchSpec(name).then((r) => setSpec(r.spec), () => undefined);
    void fetchOracle(name).then(setOracle, () => undefined);
    void fetchRuns(name).then((r) => setRuns(r.runs), () => undefined);
  }, [name]);

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
