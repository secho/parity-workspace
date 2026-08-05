/**
 * `blocker` is DERIVED. It is never stored, never edited, and this is the only place
 * it is produced.
 *
 * The reasoning is the same as the DSL rule in the deck: a maintained field drifts
 * from the thing it describes, and a blocker table that has drifted is worse than no
 * blocker table, because the main screen now lies with a straight face. Computing it
 * on every read means it cannot be stale by construction.
 *
 * `verify-m2` asserts both halves: that no column named `blocker` exists anywhere in
 * Parity's schema, and that changing `oracle_state` moves the value the API returns.
 */

export type OracleClass = 'pure_read' | 'det_write' | 'nondet' | 'external' | 'none';
export type OracleState = 'none' | 'golden' | 'invariants' | 'shadow' | 'proven';

export interface BlockerInput {
  oracleClass: string | null;
  oracleState: string;
  domain: string | null;
}

export interface Blocker {
  /** Stable identifier — the Estate blocker table filters on this, not on the label. */
  key: string;
  /** Czech, engineering register. */
  label: string;
}

/**
 * An ordered ladder: the first condition that matches wins. Order encodes what has to
 * be solved first, so the blocker table reads as a work queue rather than a taxonomy.
 */
export function blockerFor(p: BlockerInput): Blocker | null {
  if (p.oracleClass === null) return { key: 'untriaged', label: 'netriazováno' };

  if (p.oracleClass === 'external') return { key: 'external', label: 'nelze stínovat — externí efekt' };
  if (p.oracleClass === 'none') return { key: 'no_definition', label: 'není definice správnosti' };

  // A nondeterministic procedure cannot be shadowed until something is injected —
  // an oracle built before the seam exists would be measuring the clock, not the code.
  if (p.oracleClass === 'nondet' && (p.oracleState === 'none' || p.oracleState === 'golden')) {
    return { key: 'needs_seam', label: 'chybí seam' };
  }

  if (p.oracleState === 'none') return { key: 'no_oracle', label: 'chybí oracle' };
  if (p.oracleState === 'golden' || p.oracleState === 'invariants') {
    return { key: 'no_shadow', label: 'chybí shadow run' };
  }
  if (p.oracleState === 'shadow') return { key: 'awaiting_decision', label: 'čeká na rozhodnutí' };

  if (p.domain === null) return { key: 'no_domain', label: 'nepřiřazená doména' };

  return null;
}

/** Every blocker key in ladder order, so the breakdown table has a stable row order. */
export const BLOCKER_ORDER: string[] = [
  'untriaged',
  'external',
  'no_definition',
  'needs_seam',
  'no_oracle',
  'no_shadow',
  'awaiting_decision',
  'no_domain',
];
