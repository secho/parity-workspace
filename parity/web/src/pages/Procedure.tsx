import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { cs, formatDate, formatInt } from '../copy';
import { fetchProcedure, type ColumnAccess, type ProcedureResponse } from '../lib/api';

type Tab = 'source' | 'data' | 'coupling';

export function Procedure(): JSX.Element {
  const { name = '' } = useParams();
  const [data, setData] = useState<ProcedureResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('source');

  useEffect(() => {
    setData(null);
    fetchProcedure(name).then(setData, (err: Error) => setError(err.message));
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
      </div>

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
