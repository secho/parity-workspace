import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { DataTable, type Column } from '../components/DataTable';
import { StatusBar } from '../components/StatusBar';
import { cs, formatDate, formatInt, formatPercent } from '../copy';
import { fetchEstate, type EstateProcedure, type EstateResponse } from '../lib/api';

const CLASS_TONE: Record<string, string> = {
  pure_read: 'good',
  det_write: '',
  nondet: 'warn',
  external: 'bad',
  none: 'bad',
};

export function Estate(): JSX.Element {
  const [data, setData] = useState<EstateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const blockerFilter = params.get('blocker');

  useEffect(() => {
    fetchEstate().then(setData, (err: Error) => setError(err.message));
  }, []);

  if (error !== null) return <p className="empty">{cs.common.error}: {error}</p>;
  if (data === null) return <p className="empty">{cs.common.loading}</p>;

  const { totals } = data;
  const rows = blockerFilter === null ? data.procedures : data.procedures.filter((p) => p.blocker?.key === blockerFilter);
  const filterLabel = data.blockers.find((b) => b.key === blockerFilter)?.label;

  const columns: Column<EstateProcedure>[] = [
    {
      key: 'name',
      header: cs.estate.columns.name,
      value: (r) => r.name,
      render: (r) => (
        <Link className="mono linkish" to={`/procedura/${r.name}`}>
          {r.name}
        </Link>
      ),
    },
    { key: 'lines', header: cs.estate.columns.lines, numeric: true, value: (r) => r.lineCount, render: (r) => r.lineCount },
    {
      key: 'invocations',
      header: cs.estate.columns.invocations,
      numeric: true,
      value: (r) => r.invocations90d,
      render: (r) => formatInt(r.invocations90d),
    },
    {
      key: 'last',
      header: cs.estate.columns.lastInvoked,
      value: (r) => r.lastInvokedAt,
      render: (r) => <span className="chip none">{formatDate(r.lastInvokedAt)}</span>,
    },
    {
      key: 'class',
      header: cs.estate.columns.oracleClass,
      value: (r) => r.oracleClass,
      render: (r) =>
        r.oracleClass === null ? (
          <span className="chip none">{cs.common.none}</span>
        ) : (
          <span className={`chip ${CLASS_TONE[r.oracleClass] ?? ''}`}>{r.oracleClass}</span>
        ),
    },
    {
      key: 'state',
      header: cs.estate.columns.oracleState,
      value: (r) => r.oracleState,
      render: (r) => <span className="chip">{cs.oracleState[r.oracleState] ?? r.oracleState}</span>,
    },
    {
      key: 'blocker',
      header: cs.estate.columns.blocker,
      value: (r) => r.blocker?.label ?? null,
      render: (r) =>
        r.blocker === null ? (
          <span className="chip good">{cs.common.none}</span>
        ) : (
          <span className="chip warn">{r.blocker.label}</span>
        ),
    },
  ];

  return (
    <>
      <div className="topline">
        <h1>{cs.estate.title}</h1>
        <span className="subtle">{cs.estate.subtitle(totals.liveProcedures)}</span>
      </div>

      <div className="metrics">
        <div className="metric">
          <div className="value">{totals.procedures}</div>
          <div className="label">{cs.estate.metrics.procedures}</div>
        </div>
        <div className="metric">
          <div className="value">{formatInt(totals.invocations90d)}</div>
          <div className="label">{cs.estate.metrics.invocations}</div>
        </div>
        <div className="metric">
          <div className="value">{totals.deadProcedures}</div>
          <div className="label">{cs.estate.metrics.dead}</div>
        </div>
        <div className="metric">
          <div className="value">{formatPercent(totals.coverage)}</div>
          <div className="label">{cs.estate.metrics.coverage}</div>
          <div className="note">{cs.estate.metrics.coverageNote}</div>
        </div>
      </div>

      <h2>{cs.estate.statusTitle}</h2>
      <StatusBar buckets={data.statusBar} />

      <h2>{cs.estate.blockersTitle}</h2>
      <table>
        <thead>
          <tr>
            <th>{cs.estate.columns.blocker}</th>
            <th className="num">{cs.estate.metrics.procedures}</th>
            <th className="num">{cs.estate.metrics.invocations}</th>
          </tr>
        </thead>
        <tbody>
          {data.blockers.map((bucket) => (
            <tr key={bucket.key}>
              <td>
                <a
                  className="linkish"
                  onClick={() => setParams(bucket.key === blockerFilter ? {} : { blocker: bucket.key! })}
                  style={{ cursor: 'pointer' }}
                >
                  {bucket.label}
                </a>
              </td>
              <td className="num">{bucket.procedures}</td>
              <td className="num">{formatInt(bucket.invocations90d)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="subtle" style={{ marginTop: 6 }}>
        {cs.estate.blockersHint}
      </p>

      <h2>
        {cs.estate.tableTitle}
        {filterLabel !== undefined && (
          <>
            {' · '}
            <span style={{ textTransform: 'none', letterSpacing: 0 }}>{cs.estate.filtered(filterLabel)}</span>{' '}
            <a className="linkish" onClick={() => setParams({})} style={{ cursor: 'pointer', textTransform: 'none' }}>
              {cs.estate.clearFilter}
            </a>
          </>
        )}
      </h2>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.name}
        initialSort={{ key: 'invocations', direction: 'desc' }}
      />
    </>
  );
}
