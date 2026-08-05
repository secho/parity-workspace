// Every date in the seeded estate derives from this constant. Nothing calls new Date()
// without an argument. If the demo slips, bump DEMO_EPOCH and re-seed — one constant,
// and the Estate screen's numbers stay identical between rehearsals.

export const DEMO_EPOCH = new Date('2026-08-05T00:00:00.000Z');

/** The 90-day capture window M1 fills with invocation history. */
export const HISTORY_DAYS = 90;

/** Seeded order history reaches further back than the capture window. */
export const ORDER_HISTORY_DAYS = 730;

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
