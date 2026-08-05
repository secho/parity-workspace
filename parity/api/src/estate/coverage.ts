import { blockerFor, BLOCKER_ORDER } from './blocker.js';

/**
 * Oracle coverage, weighted by invocation.
 *
 * Counting procedures would let the three dead ones and the quarterly import flatter
 * the number: 3 of 14 "covered" reads as 21% while none of the traffic is actually
 * verifiable. Weighting by real invocations answers the question the room is asking —
 * how much of what actually runs is now provable.
 *
 * A consequence worth saying out loud: deleting the dead procedures does not move
 * coverage at all, because they contribute zero to both sides. It moves the count.
 */

const COVERED_STATES = new Set(['golden', 'invariants', 'shadow', 'proven']);

export interface CoverageRow {
  name: string;
  invocations90d: number;
  oracleClass: string | null;
  oracleState: string;
  campaignStatus: string;
  domain: string | null;
}

export interface EstateTotals {
  procedures: number;
  liveProcedures: number;
  deadProcedures: number;
  invocations90d: number;
  /** 0..1, weighted by invocations. */
  coverage: number;
  /** What a naive count would have said — kept so the UI can show the honest one. */
  coverageByCount: number;
}

export function totalsFor(rows: CoverageRow[]): EstateTotals {
  const invocations = rows.reduce((sum, r) => sum + r.invocations90d, 0);
  const covered = rows.filter((r) => COVERED_STATES.has(r.oracleState));
  const coveredInvocations = covered.reduce((sum, r) => sum + r.invocations90d, 0);

  return {
    procedures: rows.length,
    liveProcedures: rows.filter((r) => r.invocations90d > 0).length,
    deadProcedures: rows.filter((r) => r.invocations90d === 0).length,
    invocations90d: invocations,
    coverage: invocations === 0 ? 0 : coveredInvocations / invocations,
    coverageByCount: rows.length === 0 ? 0 : covered.length / rows.length,
  };
}

export interface StatusBucket {
  status: string;
  label: string;
  procedures: number;
  invocations90d: number;
}

/** The portfolio status bar across the top of Estate. Ordered by campaign progression. */
const STATUS_LABELS: [string, string][] = [
  ['untouched', 'nezanalyzováno'],
  ['specced', 'specifikace'],
  ['oracled', 'oracle'],
  ['shadow', 'shadow run'],
  ['migrated', 'migrováno'],
  ['deleted', 'smazáno'],
];

export function statusBar(rows: CoverageRow[]): StatusBucket[] {
  return STATUS_LABELS.map(([status, label]) => {
    const inBucket = rows.filter((r) => r.campaignStatus === status);
    return {
      status,
      label,
      procedures: inBucket.length,
      invocations90d: inBucket.reduce((sum, r) => sum + r.invocations90d, 0),
    };
  });
}

export interface BlockerBucket {
  key: string;
  label: string;
  procedures: number;
  invocations90d: number;
}

/** The blocker breakdown. This table is the roadmap — every row links to a filtered list. */
export function blockerBreakdown(rows: CoverageRow[]): BlockerBucket[] {
  const buckets = new Map<string, BlockerBucket>();

  for (const row of rows) {
    const blocker = blockerFor(row);
    if (blocker === null) continue;
    const bucket = buckets.get(blocker.key) ?? {
      key: blocker.key,
      label: blocker.label,
      procedures: 0,
      invocations90d: 0,
    };
    bucket.procedures += 1;
    bucket.invocations90d += row.invocations90d;
    buckets.set(blocker.key, bucket);
  }

  return BLOCKER_ORDER.filter((k) => buckets.has(k)).map((k) => buckets.get(k)!);
}
