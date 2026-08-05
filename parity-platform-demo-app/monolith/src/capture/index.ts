import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { isWriteCapable } from './tables.js';
import { writeLock } from './lock.js';
import { markCall, extractWriteSet } from './writeset.js';
import { decide } from './sampler.js';
import { record, captureEnabled } from './recorder.js';
import { ensureCustomerFacts } from './facts.js';

/**
 * The capture wrapper. Everything the estate does passes through here because
 * callProcedure is the only way the monolith invokes a procedure.
 */

export interface CallContext {
  /** Simulated wall clock supplied by the traffic generator, so one run yields 90 days. */
  simulatedAt?: Date;
  sessionId?: string;
  caller?: string;
}

const store = new AsyncLocalStorage<CallContext>();

export const runWithContext = <T>(ctx: CallContext, fn: () => T): T => store.run(ctx, fn);
export const currentContext = (): CallContext => store.getStore() ?? {};

export interface RawResult {
  recordsets: unknown[][];
  rowsAffected: number[];
}

/** Stable enough for a fingerprint: key order fixed, dates as ISO, no float drift games.
 *  M5 does the real canonicalisation — this only has to be reproducible. */
function canonicalise(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v instanceof Date) return v.toISOString();
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
}

const hashOf = (value: unknown): string => createHash('sha256').update(canonicalise(value)).digest('hex');

/** Result sets can be large; a sampled capture stores a bounded slice rather than
 *  everything, so the table stays well under SPEC's 200 MB ceiling. */
const MAX_SAMPLED_ROWS = 50;

function sampleResult(recordsets: unknown[][]): string {
  return canonicalise(recordsets.map((rs) => rs.slice(0, MAX_SAMPLED_ROWS)));
}

export async function withCapture<T extends RawResult>(
  procName: string,
  params: Record<string, unknown>,
  invoke: () => Promise<T>,
): Promise<T> {
  if (!captureEnabled()) return invoke();

  const ctx = currentContext();
  // Country and loyalty tier are branch selectors these procedures resolve internally.
  const facts = await ensureCustomerFacts().catch(() => undefined);
  const decision = decide(procName, params, facts);
  const writeCapable = isWriteCapable(procName);

  // A captured write owns the Change Tracking version window and must exclude every
  // other writer. Uncaptured writes only need to not run during one of those.
  const lockMode = writeCapable ? (decision.capture ? 'exclusive' : 'shared') : null;

  const body = async (): Promise<T> => {
    const mark = decision.capture ? await markCall() : null;

    const started = Date.now();
    const result = await invoke();
    const durationMs = Date.now() - started;

    let writeSet: string | null = null;
    if (mark && writeCapable) {
      const ws = await extractWriteSet(mark);
      writeSet = Object.keys(ws).length > 0 ? JSON.stringify(ws) : JSON.stringify({});
    }

    const realCalledAt = new Date();
    record({
      procName,
      calledAt: ctx.simulatedAt ?? realCalledAt,
      realCalledAt,
      inputParams: JSON.stringify(params),
      resultSetHash: hashOf(result.recordsets ?? []),
      resultSet: decision.capture ? sampleResult((result.recordsets ?? []) as unknown[][]) : null,
      writeSet,
      // The ambient values the procedure could read. Four procedures branch on the
      // clock, so without this a replay lands in a different regime and reports a
      // behaviour change that never happened.
      context: mark ? JSON.stringify(mark.context) : null,
      durationMs,
      rowsAffected: (result.rowsAffected ?? []).reduce((a, b) => a + b, 0),
      callerContext: ctx.caller ?? null,
      sessionId: ctx.sessionId ?? null,
      branchKey: decision.branchKey,
      sampled: decision.capture,
    });

    return result;
  };

  return lockMode ? writeLock.run(lockMode, body) : body();
}

export { flush, stats } from './recorder.js';
export { samplerStats, resetSampler } from './sampler.js';
export { resetWriteSetCache } from './writeset.js';
export { resetCustomerFacts } from './facts.js';
