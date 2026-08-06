import type sql from 'mssql';
import { stratumOf } from '../capture/signature.js';

/**
 * Which captured invocations a shadow run replays.
 *
 * `SPEC.md` §4 and `DEMO-SCRIPT.md` beat 3 both asked for "2 000+ replayed calls in under
 * 60 seconds". `docs/DECISIONS.md` supersedes that, and the argument is that the number was
 * measuring the wrong thing: two thousand calls of `sp_CalculateOrderTotal` drawn by volume
 * are overwhelmingly the same handful of branches repeated. This selects by **stratum**
 * instead — every distinct behaviour the estate was observed taking, before any of them is
 * replayed twice.
 *
 * A stratum is the branch key **and** a coarse signature of what the call produced. M4 paid
 * for that lesson in full: keyed on inputs alone, every `sp_CalculateOrderTotal` call carrying
 * VERNY20 shares one stratum whether or not the customer also had a loyalty discount — and the
 * planted defect lives precisely in the intersection. A selection heuristic that cannot see the
 * distinction produces a confident, small, useless replay set.
 *
 * Deterministic throughout. Strata are ordered by size then by lowest invocation id, cases
 * within a stratum by invocation id, and the fill is round-robin. No RNG, no clock, no model
 * judgement — hard rule 5 says the same traffic gives the same numbers every run, and the case
 * set is the first place that can stop being true.
 */

/** Enough to replay every stratum several times over on this estate, and to stay inside 60 s. */
export const DEFAULT_CASE_LIMIT = 400;

/** How many sampled invocations to consider. Well above the sampled count of any procedure. */
const CANDIDATE_LIMIT = 4000;

export interface ShadowCase {
  invocationId: number;
  branchKey: string | null;
  stratum: string;
  params: Record<string, unknown>;
  callerContext: string | null;
  /** Position in the stratum's own ordering: 0 is the case that covers it. */
  depth: number;
}

export interface CaseSelection {
  cases: ShadowCase[];
  strata: number;
  /** Sampled invocations considered, so a small case set can say what it was drawn from. */
  candidates: number;
}

interface CandidateRow {
  InvocationID: number;
  BranchKey: string | null;
  InputParams: string;
  CallerContext: string | null;
  WriteSet: string | null;
  ResultSet: string | null;
}

export async function selectCases(
  pool: sql.ConnectionPool,
  procedureName: string,
  limit: number = DEFAULT_CASE_LIMIT,
): Promise<CaseSelection> {
  // `verify:%` is excluded for the reason M2 recorded: without it, running an acceptance gate
  // moves the numbers the demo depends on. `Sampled = 1` because an unsampled row carries no
  // result set and no write set, so it cannot be stratified and cannot be replayed faithfully.
  const rows = (
    await pool.request().input('proc', procedureName).query(`
      SELECT TOP (${CANDIDATE_LIMIT})
             InvocationID, BranchKey, InputParams, CallerContext, WriteSet, ResultSet
      FROM parity_capture.Invocation
      WHERE ProcName = @proc AND Sampled = 1
        AND (CallerContext IS NULL OR CallerContext NOT LIKE 'verify:%')
      ORDER BY InvocationID`)
  ).recordset as unknown as CandidateRow[];

  const strata = new Map<string, ShadowCase[]>();
  for (const row of rows) {
    let params: Record<string, unknown>;
    try {
      params = JSON.parse(row.InputParams) as Record<string, unknown>;
    } catch {
      continue; // a capture we cannot replay faithfully is one we do not replay at all
    }

    const stratum = stratumOf(row.BranchKey, row.WriteSet, row.ResultSet);
    const bucket = strata.get(stratum) ?? [];
    bucket.push({
      invocationId: row.InvocationID,
      branchKey: row.BranchKey,
      stratum,
      params,
      callerContext: row.CallerContext,
      depth: bucket.length,
    });
    strata.set(stratum, bucket);
  }

  // Largest strata first so the replay's shape resembles production, but every stratum gets
  // its first case before any gets its second. That ordering is what makes the deliberately
  // rare traffic — leap day, negative stock, Slovak VAT, the stacked promo, the forty-line
  // order — included by the platform rather than chosen. M4 learned that a suite assembled by
  // preference drops exactly those and still looks complete.
  const ordered = [...strata.values()].sort(
    (a, b) => b.length - a.length || a[0].invocationId - b[0].invocationId,
  );

  const cases: ShadowCase[] = [];
  for (let depth = 0; cases.length < limit; depth++) {
    const round = ordered.filter((bucket) => bucket.length > depth);
    if (round.length === 0) break;
    for (const bucket of round) {
      if (cases.length >= limit) break;
      cases.push(bucket[depth]);
    }
  }

  return { cases, strata: strata.size, candidates: rows.length };
}
