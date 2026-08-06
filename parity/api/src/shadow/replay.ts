import sql from 'mssql';
import type { AmbientContext, ProcedureParameter, WriteSet } from '../oracle/execute.js';
import { bindParameters } from '../oracle/execute.js';
import { extractWriteSet, markCall, type TrackedTable } from './changetracking.js';
import type { ShadowCase } from './cases.js';

/**
 * The two passes of a shadow run.
 *
 * Both replay the same cases in the same order from the same reverted state, and both commit.
 * Comparing them is the only comparison M4's own decision permits: a captured value and a
 * value produced today differ for reasons that have nothing to do with the code, because
 * ninety days of later traffic touched the same rows. Two passes over identical state is what
 * removes that variable.
 *
 * Deliberately serial. A concurrent call would land inside another call's Change Tracking
 * version window and have its writes attributed to it — M1's write-lane reasoning, unchanged.
 * Parallelism here would buy wall clock and cost the one property that makes the diff mean
 * anything.
 *
 * One caveat, stated rather than discovered later: pass B writes different values wherever the
 * implementations diverge, so a case could in principle read what an earlier case in the same
 * pass wrote. For `sp_CalculateOrderTotal` the only written column it ever reads back is
 * `PromoCodeUsed`, and both sides set it identically, so the passes stay comparable. A
 * procedure that fed its own outputs back would need a revert per case instead.
 */

export interface ReplayOutcome {
  invocationId: number;
  resultSets: unknown[][];
  writeSet: WriteSet;
  context: AmbientContext;
  clockWindow: { from: number; to: number };
  durationMs: number;
  /** The procedure RAISERRORs on an unknown order; the service 409s. Both are outcomes. */
  error: string | null;
  truncatedTables: string[];
}

export interface ReplayContext {
  tracked: TrackedTable[];
  columns: Map<string, string[]>;
}

async function serverNow(pool: sql.ConnectionPool): Promise<number> {
  return ((await pool.request().query('SELECT GETDATE() AS at')).recordset[0].at as Date).getTime();
}

/** Pass A: the estate's own procedure, on the shadow copy, committed. */
export async function replayProcedure(
  pool: sql.ConnectionPool,
  procedureName: string,
  parameters: ProcedureParameter[],
  cases: ShadowCase[],
  context: ReplayContext,
  onProgress?: (done: number) => void,
): Promise<ReplayOutcome[]> {
  const outcomes: ReplayOutcome[] = [];

  for (const [index, replayCase] of cases.entries()) {
    const mark = await markCall(pool);
    const started = Date.now();
    let resultSets: unknown[][] = [];
    let error: string | null = null;

    try {
      const request = pool.request();
      bindParameters(request, parameters, replayCase.params);
      const result = await request.execute(`dbo.${procedureName}`);
      resultSets = (result.recordsets ?? []) as unknown as unknown[][];
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const durationMs = Date.now() - started;
    const extracted = await extractWriteSet(pool, mark, context.tracked, context.columns);

    outcomes.push({
      invocationId: replayCase.invocationId,
      resultSets,
      writeSet: extracted.writeSet,
      context: mark.context,
      clockWindow: { from: mark.clockFrom, to: await serverNow(pool) },
      durationMs,
      error,
      truncatedTables: extracted.truncatedTables,
    });
    onProgress?.(index + 1);
  }

  return outcomes;
}

interface ServiceResponse {
  resultSets?: unknown[][];
  error?: string;
}

/**
 * Pass B: the replacement, over HTTP, writing to the same shadow database.
 *
 * The write set still comes from Change Tracking rather than from anything the service says
 * about itself. That is the point — a replacement is judged on what it did to the database,
 * not on what it reports having done, and M6's agent-generated service gets exactly the same
 * treatment as this hand-written one.
 */
export async function replayService(
  pool: sql.ConnectionPool,
  baseUrl: string,
  procedureName: string,
  cases: ShadowCase[],
  context: ReplayContext,
  onProgress?: (done: number) => void,
): Promise<ReplayOutcome[]> {
  const outcomes: ReplayOutcome[] = [];

  for (const [index, replayCase] of cases.entries()) {
    const mark = await markCall(pool);
    const started = Date.now();
    let resultSets: unknown[][] = [];
    let error: string | null = null;

    try {
      const response = await fetch(`${baseUrl}/replay/${procedureName}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(replayCase.params),
      });
      const body = (await response.json()) as ServiceResponse;
      if (!response.ok) error = body.error ?? `${response.status} ${response.statusText}`;
      else resultSets = body.resultSets ?? [];
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const durationMs = Date.now() - started;
    const extracted = await extractWriteSet(pool, mark, context.tracked, context.columns);

    outcomes.push({
      invocationId: replayCase.invocationId,
      resultSets,
      writeSet: extracted.writeSet,
      context: mark.context,
      clockWindow: { from: mark.clockFrom, to: await serverNow(pool) },
      durationMs,
      error,
      truncatedTables: extracted.truncatedTables,
    });
    onProgress?.(index + 1);
  }

  return outcomes;
}

/**
 * Ask the replacement to drop its connection pool.
 *
 * Called before every revert. RESTORE needs exclusive access and does not fail without it —
 * it waits, indefinitely if a pool holds an idle connection. Measured: 530 ms clean against
 * 6.5 s with one live session, and a session that never ends never returns.
 */
export async function releaseService(baseUrl: string): Promise<void> {
  try {
    await fetch(`${baseUrl}/_admin/disconnect`, { method: 'POST' });
  } catch {
    // The service being down is not a reason to fail a revert — there is nothing holding a
    // connection in that case, which is the state the call was trying to reach.
  }
}
