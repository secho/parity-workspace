import { getPool, sql } from '../db.js';

/**
 * Buffered writer for parity_capture.Invocation.
 *
 * A traffic run issues ~120 000 calls. One synchronous INSERT per call would dominate
 * the three-minute budget on its own, so rows accumulate in memory and go out in bulk
 * batches. The traffic generator calls flush() over HTTP when it finishes; there is also
 * an idle timer so the shop UI's occasional calls do not sit in the buffer forever.
 */

export interface InvocationRow {
  procName: string;
  calledAt: Date;
  realCalledAt: Date;
  inputParams: string | null;
  resultSetHash: string | null;
  resultSet: string | null;
  writeSet: string | null;
  context: string | null;
  durationMs: number;
  rowsAffected: number | null;
  callerContext: string | null;
  sessionId: string | null;
  branchKey: string | null;
  sampled: boolean;
}

const BATCH_SIZE = 500;
const IDLE_FLUSH_MS = 2000;

let buffer: InvocationRow[] = [];
let idleTimer: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;
let totalWritten = 0;

function buildTable(rows: InvocationRow[]): sql.Table {
  const table = new sql.Table('parity_capture.Invocation');
  table.create = false;
  table.columns.add('ProcName', sql.NVarChar(128), { nullable: false });
  table.columns.add('CalledAt', sql.DateTime2(3), { nullable: false });
  table.columns.add('RealCalledAt', sql.DateTime2(3), { nullable: false });
  table.columns.add('InputParams', sql.NVarChar(sql.MAX), { nullable: true });
  table.columns.add('ResultSetHash', sql.Char(64), { nullable: true });
  table.columns.add('ResultSet', sql.NVarChar(sql.MAX), { nullable: true });
  table.columns.add('WriteSet', sql.NVarChar(sql.MAX), { nullable: true });
  table.columns.add('Context', sql.NVarChar(sql.MAX), { nullable: true });
  table.columns.add('DurationMs', sql.Int, { nullable: false });
  table.columns.add('RowsAffected', sql.Int, { nullable: true });
  table.columns.add('CallerContext', sql.NVarChar(200), { nullable: true });
  table.columns.add('SessionID', sql.NVarChar(40), { nullable: true });
  table.columns.add('BranchKey', sql.NVarChar(200), { nullable: true });
  table.columns.add('Sampled', sql.Bit, { nullable: false });

  for (const r of rows) {
    table.rows.add(
      r.procName, r.calledAt, r.realCalledAt, r.inputParams, r.resultSetHash,
      r.resultSet, r.writeSet, r.context, r.durationMs, r.rowsAffected,
      r.callerContext, r.sessionId, r.branchKey, r.sampled,
    );
  }
  return table;
}

async function writeBatch(rows: InvocationRow[]): Promise<void> {
  if (rows.length === 0) return;
  const pool = await getPool();
  await pool.request().bulk(buildTable(rows));
  totalWritten += rows.length;
}

export function record(row: InvocationRow): void {
  buffer.push(row);
  if (buffer.length >= BATCH_SIZE) {
    void flush();
    return;
  }
  if (!idleTimer) {
    idleTimer = setTimeout(() => {
      idleTimer = null;
      void flush();
    }, IDLE_FLUSH_MS);
    idleTimer.unref?.();
  }
}

export async function flush(): Promise<number> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  // Serialise flushes so two bulk loads never interleave on the same buffer.
  while (flushing) await flushing;
  if (buffer.length === 0) return 0;

  const batch = buffer;
  buffer = [];
  let resolveDone: () => void = () => {};
  flushing = new Promise<void>((resolve) => (resolveDone = resolve));
  try {
    await writeBatch(batch);
    return batch.length;
  } finally {
    flushing = null;
    resolveDone();
  }
}

export const stats = () => ({ buffered: buffer.length, written: totalWritten });

/** Capture is inert unless switched on, so the shop and verify-m0 behave exactly as they
 *  did in M0 unless a traffic run or an explicit opt-in turns it on. */
export const captureEnabled = (): boolean => process.env.PARITY_CAPTURE !== 'off';
