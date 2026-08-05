import { getPool } from '../db.js';

/**
 * Customer facts the procedures look up for themselves.
 *
 * The branch-coverage proxy was originally derived from call parameters alone, which
 * misses the branches that matter most: sp_CalculateOrderTotal takes only
 * (OrderNumber, PromoCode, ModifiedBy) and sp_GetCartSummary takes (CartItems,
 * CustomerID, PromoCode), yet both branch on the customer's COUNTRY (CZ 21% vs SK 20%
 * VAT) and LOYALTY TIER — resolved by a SELECT inside the procedure. A parameter-only
 * key therefore treats a Slovak tier-4 order and a Czech tier-0 order as the same
 * branch, and "always capture on an uncovered branch" silently stops covering the two
 * branches the demo depends on.
 *
 * The whole table is 500 rows, so it is cached in memory and consulted synchronously.
 * Cleared by /api/_capture/reset along with everything else that outlives a reseed.
 */
export interface CustomerFacts {
  countryCode: string;
  loyaltyTier: number;
}

let cache: Map<number, CustomerFacts> | null = null;

export async function ensureCustomerFacts(): Promise<Map<number, CustomerFacts>> {
  if (cache) return cache;
  const pool = await getPool();
  const result = await pool.request().query(
    'SELECT CustomerID, CountryCode, LoyaltyTier FROM dbo.Customer',
  );
  cache = new Map(
    (result.recordset as { CustomerID: number; CountryCode: string | null; LoyaltyTier: number | null }[]).map((r) => [
      Number(r.CustomerID),
      { countryCode: r.CountryCode ?? 'CZ', loyaltyTier: Number(r.LoyaltyTier ?? 0) },
    ]),
  );
  return cache;
}

export function resetCustomerFacts(): void {
  cache = null;
}
