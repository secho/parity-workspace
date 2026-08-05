/**
 * The tables capture watches, and their primary keys.
 *
 * Change Tracking reports changes per table, so the write-set extractor needs to know
 * the key columns in order to name the changed row. Order matters only for readability
 * of the resulting write set.
 */
export interface TrackedTable {
  name: string;
  /** Primary key columns, in ordinal order. VatRate has a composite key. */
  pk: string[];
}

export const TRACKED_TABLES: readonly TrackedTable[] = [
  { name: 'Catalog', pk: ['ProductID'] },
  { name: 'OrderLedger', pk: ['OrderLineID'] },
  { name: 'Customer', pk: ['CustomerID'] },
  { name: 'CustomerScore', pk: ['CustomerID'] },
  { name: 'StockMovement', pk: ['MovementID'] },
  { name: 'StockReservation', pk: ['ReservationID'] },
  { name: 'PromoCode', pk: ['PromoCodeID'] },
  { name: 'PromoRedemption', pk: ['RedemptionID'] },
  { name: 'AuditTrail', pk: ['AuditID'] },
  { name: 'Category', pk: ['CategoryID'] },
  { name: 'Warehouse', pk: ['WarehouseID'] },
  { name: 'VatRate', pk: ['CountryCode', 'RateCode'] },
];

/**
 * Procedures that cannot write. Skipping the write-set round-trip for these is worth
 * doing: they are roughly 70% of all traffic, and asking Change Tracking about a call
 * that provably wrote nothing is pure overhead. verify-m0 already asserts that these
 * four write nothing, so this list is checked rather than assumed.
 *
 * The estate's fifth pure_read procedure is dead and is deliberately absent: the monolith
 * has no code path to any dead procedure, and verify-m0 asserts that none of the three is
 * so much as named here. Listing one would weaken a structural guarantee to buy nothing.
 */
export const READ_ONLY_PROCEDURES: ReadonlySet<string> = new Set([
  'sp_SearchProducts',
  'sp_GetProductDetail',
  'sp_GetProductAvailability',
  'sp_GetCartSummary',
]);

export const isWriteCapable = (procName: string): boolean => !READ_ONLY_PROCEDURES.has(procName);
