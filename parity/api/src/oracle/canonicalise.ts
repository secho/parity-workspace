import type { ExecutionOutcome, RowImage } from './execute.js';

/**
 * Normalisation, in code, before anything is compared and long before anything is shown to
 * a model. This is the one place it happens; M5's diff engine imports it unchanged.
 *
 * The design rule that matters: **normalise the clock, not dates.** Blanking every
 * datetime-shaped value would be easy and would quietly destroy real evidence — an order's
 * `OrderedAt`, a promo's validity window, a computed dispatch date are all behaviour, and a
 * golden test that ignores them asserts almost nothing. So a timestamp is normalised only
 * when it falls inside the wall-clock window the run itself occupied, which makes it
 * provably a value the run read off the clock rather than one it derived from data.
 *
 * Measured on `sp_CalculateOrderTotal`: two runs against identical state differ in exactly
 * four columns — `Catalog.LastQuotedAt`, `Catalog.ModifiedAt`, `OrderLedger.CalcCachedAt`,
 * `OrderLedger.ModifiedAt`. Every money column is stable. The canonicaliser is built from
 * that evidence rather than from a guess about what might drift.
 *
 * Every normalisation that fires is reported. `skills/generate-oracle/SKILL.md` ends on
 * "an oracle that claims more coverage than it has is worse than no oracle" — a test whose
 * ordering was normalised away asserts set equality, not sequence equality, and the UI has
 * to be able to say so.
 */

export const CLOCK = '<clock>';

/**
 * The clock window is read either side of the call, but a row can be stamped a beat after
 * the last read returns. Two seconds is far longer than any call in this estate (the slowest
 * measured is 25 ms) and far shorter than any gap that would make a real date ambiguous.
 */
const WINDOW_SLACK_MS = 2_000;

/**
 * How far from the run's own clock a value can sit and still be treated as derived from it.
 *
 * `sp_ReserveStock` writes `ExpiresAt = DATEADD(MINUTE, @reservationMinutes, @now)` — clock
 * arithmetic, so it lands outside the window by construction and drifts run to run exactly
 * as `ModifiedAt` does. Such a value is normalised to its offset (`<clock+1800s>`) rather
 * than blanked, because the offset is the behaviour and a golden test should still fail if
 * the reservation window changes from thirty minutes to sixty.
 *
 * Only forward, and only within a day. Forward is the principle: a write set holds whole row
 * images, so it carries columns the procedure never touched, and those hold ordinary data.
 * A value dated in the past is ambiguous — `Catalog.LastQuotedAt` is seeded history — and
 * measuring it against a moving anchor turns a perfectly stable value into a drifting one,
 * which is how this presented. A value dated in the *future* cannot be observed history, so
 * on a row this run wrote it can only have come from arithmetic on the clock.
 *
 * The cost is that a procedure writing `DATEADD(day, -30, GETDATE())` would produce an
 * unstable golden test. Nothing in this estate does, and the failure would be loud.
 */
const CLOCK_HORIZON_MS = 24 * 60 * 60 * 1_000;

/** Money is four decimal places at most in this schema; six kills binary drift and no more. */
const FLOAT_DECIMALS = 6;

/**
 * Not anchored. `sp_PlaceOrder` writes `PaymentRef = 'PR-' + NEWID()`, so a GUID has to be
 * recognised inside a string and not only as the whole of one.
 */
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export interface CanonicalOptions {
  clockWindow: { from: number; to: number };
  /** table → identity columns, from `readIdentityColumns`. */
  identityColumns: Map<string, Set<string>>;
}

export interface CanonicalOutcome {
  resultSets: unknown[][];
  writeSet: Record<string, RowImage[]>;
  /** Which normalisations actually fired, so nothing claims more than it verified. */
  normalisations: string[];
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);

/** Stable, key-sorted JSON. The sort key for every ordering decision below. */
export function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Identity values this run created, indexed by the column they belong to and held as strings.
 *
 * Strings because a procedure can hand the same key back through its result set under a
 * different type — `sp_PlaceOrder` returns `LastOrderLineID` as text while the column itself
 * is an integer — and a value that changes every run has to normalise in both places or the
 * golden test is unstable for a reason that has nothing to do with behaviour.
 */
type FreshIdentities = Map<string, Set<string>>;

/**
 * Does this column hold one of the identity values this run created?
 *
 * Exact name, or a suffix of it: result-set columns are procedure-authored aliases
 * (`LastOrderLineID` for `OrderLineID`), and matching on value alone would be wrong because
 * the estate's identity ranges overlap across tables.
 */
function freshToken(fresh: FreshIdentities, column: string, value: unknown): string | null {
  const raw = String(value);
  for (const [identityColumn, values] of fresh) {
    if (column !== identityColumn && !column.endsWith(identityColumn)) continue;
    if (values.has(raw)) return `${identityColumn}:${raw}`;
  }
  return null;
}

class Normaliser {
  readonly fired = new Set<string>();
  private readonly guids = new Map<string, string>();
  private readonly identities = new Map<string, string>();

  constructor(private readonly options: CanonicalOptions) {}

  /**
   * A timestamp the run got from the clock, or null if it is data.
   *
   * Inside the window it is the clock itself. Outside but within a day, it is the clock plus
   * a constant the procedure applied, and the constant is kept — that is behaviour. Beyond
   * that horizon it is left alone.
   */
  private clockValue(value: Date | string): string | null {
    const at = value instanceof Date ? value.getTime() : Date.parse(value);
    if (Number.isNaN(at)) return null;
    const { from, to } = this.options.clockWindow;
    if (at >= from - WINDOW_SLACK_MS && at <= to + WINDOW_SLACK_MS) return CLOCK;

    const delta = at - from;
    if (delta <= 0 || delta > CLOCK_HORIZON_MS) return null;
    // Floored to ten seconds, and both halves of that matter.
    //
    // The offset is `procedure clock − run clock`, so it always carries however long the call
    // took to reach the statement. Rounding to the nearest second put `DATEADD(MINUTE, 30, …)`
    // at 1800 s or 1801 s depending on whether that took under or over half a second — and
    // `sp_PlaceOrder`, which orchestrates three other procedures, is the one call in the estate
    // slow enough to cross it. Its golden suite flipped between runs for a reason that had
    // nothing to do with the estate.
    //
    // Flooring rather than rounding is what makes the quantum a real margin: the excess is
    // always positive, so a true offset of exactly 1800 s stays 1800 s for any call taking
    // under ten seconds. A behaviour change from thirty minutes to an hour is still caught; one
    // from 1800 s to 1805 s is not, and that is the price.
    return `<clock+${Math.floor(delta / 10_000) * 10}s>`;
  }

  /** Ordinal, not blanked: two columns holding the same new identifier still look equal. */
  private ordinal(map: Map<string, string>, prefix: string, raw: string): string {
    const existing = map.get(raw);
    if (existing !== undefined) return existing;
    const token = `<${prefix}:${map.size}>`;
    map.set(raw, token);
    return token;
  }

  value(input: unknown, column: string, fresh: FreshIdentities): unknown {
    if (input === null || input === undefined) return null;

    // First, before anything else. An identity key is an integer, so testing this after the
    // number branch means it never fires — which is exactly what happened, and it left every
    // inserting procedure reporting as unstable.
    //
    // Matched on column name as well as value. A raw value set alone would be wrong: the
    // estate's identity ranges overlap, so a freshly created ReservationID of 1956 would
    // otherwise silently normalise an unrelated ProductID of 1956 in another table.
    if (typeof input === 'number' || typeof input === 'string' || typeof input === 'bigint') {
      const token = freshToken(fresh, column, input);
      if (token !== null) {
        this.fired.add('identity');
        return this.ordinal(this.identities, 'new', token);
      }
    }

    if (input instanceof Date) {
      const clock = this.clockValue(input);
      if (clock !== null) {
        this.fired.add('clock');
        return clock;
      }
      return input.toISOString();
    }

    if (typeof input === 'number') {
      if (Number.isInteger(input)) return input;
      this.fired.add('float');
      return Number(input.toFixed(FLOAT_DECIMALS));
    }

    if (typeof input === 'string') {
      // Replace in place, so `PR-<guid>` keeps its prefix and stays readable in a diff.
      // Deliberately not `GUID.test(...)` first: the pattern is global, and `test` on a
      // global regex advances `lastIndex` and then misses every other match.
      const deguided = input.replace(GUID, (match) => this.ordinal(this.guids, 'guid', match.toLowerCase()));
      if (deguided !== input) {
        this.fired.add('guid');
        return deguided;
      }
      // Only strings that really parse as a date; Date.parse of arbitrary text is NaN, so a
      // product name is never at risk of matching.
      if (/\d{4}-\d{2}-\d{2}/.test(input)) {
        const clock = this.clockValue(input);
        if (clock !== null) {
          this.fired.add('clock');
          return clock;
        }
      }
      return input;
    }

    if (Array.isArray(input)) return input.map((v) => this.value(v, column, fresh));
    if (isPlainObject(input)) return this.object(input, fresh);
    return input;
  }

  object(input: Record<string, unknown>, fresh: FreshIdentities): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) out[key] = this.value(input[key], key, fresh);
    return out;
  }
}

/**
 * Canonicalise one execution outcome.
 *
 * Result-set rows are sorted. This estate is deliberately full of `ORDER BY` branches with no
 * secondary key — `sp_SearchProducts` is built that way on purpose — so two runs legitimately
 * return the same rows in a different sequence. Sorting turns that into set equality, which
 * is a weaker claim honestly made rather than a stronger claim that fails at random.
 */
export function canonicalise(outcome: ExecutionOutcome, options: CanonicalOptions): CanonicalOutcome {
  const normaliser = new Normaliser(options);

  /**
   * Built across every table before anything is normalised, not per table.
   * `sp_ReserveStock` inserts a `StockReservation` and then writes that brand-new key into
   * `OrderLedger.ReservationID`. Scoped per table, the foreign key stays a raw integer and
   * drifts on every run — which is exactly how it presented.
   *
   * Only inserted rows contribute. On an updated row the key already existed and is real
   * evidence about which row was touched.
   */
  const fresh: FreshIdentities = new Map();
  for (const [table, images] of Object.entries(outcome.writeSet)) {
    const identityColumns = options.identityColumns.get(table) ?? new Set<string>();
    for (const image of images) {
      if (image.op !== 'I') continue;
      for (const column of identityColumns) {
        const value = image.pk[column];
        if (value === undefined || value === null) continue;
        fresh.set(column, (fresh.get(column) ?? new Set()).add(String(value)));
      }
    }
  }

  const resultSets = outcome.resultSets.map((rows) => {
    const canonical = rows.map((row) =>
      isPlainObject(row) ? normaliser.object(row, fresh) : normaliser.value(row, '', fresh),
    );
    const sorted = [...canonical].sort((a, b) => stableKey(a).localeCompare(stableKey(b)));
    if (rows.length > 1 && stableKey(canonical) !== stableKey(sorted)) normaliser.fired.add('ordering');
    return sorted;
  });

  const writeSet: Record<string, RowImage[]> = {};
  for (const table of Object.keys(outcome.writeSet).sort()) {
    const images = outcome.writeSet[table].map((image) => ({
      pk: normaliser.object(image.pk, fresh),
      op: image.op,
      row: image.row === null ? null : normaliser.object(image.row, fresh),
    }));

    writeSet[table] = images.sort((a, b) => stableKey(a.pk).localeCompare(stableKey(b.pk)));
  }

  return { resultSets, writeSet, normalisations: [...normaliser.fired].sort() };
}

/** What a golden test compares. Equality over the canonical form, nothing cleverer. */
export const fingerprint = (canonical: CanonicalOutcome): string =>
  stableKey({ resultSets: canonical.resultSets, writeSet: canonical.writeSet });
