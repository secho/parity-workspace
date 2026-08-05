// Every date in the seeded estate derives from this constant. Nothing calls new Date()
// without an argument. If the demo slips, bump DEMO_EPOCH and re-seed — one constant,
// and the Estate screen's numbers stay identical between rehearsals.

export const DEMO_EPOCH = new Date('2026-08-05T00:00:00.000Z');

/** The 90-day capture window M1 fills with invocation history. */
export const HISTORY_DAYS = 90;

/**
 * Seeded order history reaches further back than the capture window.
 *
 * 900 rather than 730 so that the history spans 29 February 2024. SPEC lists a leap-day
 * order as a rare branch, but no leap day can fall inside the 90-day capture window —
 * 2026 is not a leap year — and no procedure in the estate takes a date parameter. The
 * leap day therefore has to be carried by the *order* a procedure operates on, which
 * means the seed has to reach back far enough to contain one.
 */
export const ORDER_HISTORY_DAYS = 900;

/** The leap day the rare-branch orders are pinned to. 889 days before DEMO_EPOCH. */
export const LEAP_DAY = new Date('2024-02-29T00:00:00.000Z');

/** Orders 1..N are pinned to LEAP_DAY so the branch exists deterministically rather
 *  than by luck of the draw. */
export const LEAP_DAY_ORDER_COUNT = 3;

const DAY_MS = 86_400_000;

export function daysBefore(days: number, msOffset = 0): Date {
  return new Date(DEMO_EPOCH.getTime() - days * DAY_MS + msOffset);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

/** yyyy-mm-dd hh:mm:ss.mmm — the literal form used when inlining into T-SQL. */
export function sqlDateTime(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}
