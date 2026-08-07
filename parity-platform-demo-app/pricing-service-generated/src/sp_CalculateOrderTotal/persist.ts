// persist.ts
//
// Replacement for the writing half of dbo.sp_CalculateOrderTotal: steps 14 and
// 15. Two UPDATEs, in the procedure's order, in one batch. The procedure opens
// no explicit transaction and neither does this.
//
// Naming discipline, because attempt 1 died on it: T-SQL identifiers are
// CASE-INSENSITIVE, so a bound parameter named "totalWithVat" and a
// DECLARE @TotalWithVat are the same variable and the batch fails to compile
// with "The variable name '@TotalWithVat' has already been declared."
// Therefore, in this file:
//
//   * every bound parameter is prefixed "in_", and
//   * this batch DECLAREs nothing at all. Values are CONVERTed inline at the
//     point of use, so there is no local that could collide with anything.
//
// Money crosses the boundary as VARCHAR and becomes DECIMAL(18,4) inside SQL
// Server. Passing it as a float parameter would let binary floating point pick
// the rounding on exact-boundary values, and every such value becomes a
// monetary difference a human has to read in the shadow diff.

import sql from "mssql";
import type { Pricing, PricingInput } from "./pricing.js";
import {
  formatScaled4,
  loyaltyPointsFor,
  scaled4,
  shippingCostFor,
} from "./pricing.js";

// Step 14 writes the same summary onto EVERY row of the order (denormalised),
// and step 15 anchors the current catalogue price onto every product on it.
//
// PRESERVED DEFECT (spec: "Catalog.LastQuotedPrice"). LastQuotedPrice is set to
// the current Catalog.PriceNet, NOT to the UnitPriceNet the product was
// actually billed at on this order, so the morning price report reads a figure
// that does not represent what was sold. The spec records this as behaviour of
// record, so it is reproduced.
//
// CalcVersion is a hardcoded constant, not a record of which branch computed
// the totals.
const PERSIST_SQL = `
SET NOCOUNT ON;

UPDATE dbo.OrderLedger
SET
    TotalNet              = CONVERT(DECIMAL(18,4), @in_totalNet),
    TotalVat              = CONVERT(DECIMAL(18,4), @in_totalVat),
    TotalWithVat          = CONVERT(DECIMAL(18,4), @in_totalWithVat),
    ShippingCost          = CONVERT(DECIMAL(18,4), @in_shippingCost),
    DiscountAmount        = CONVERT(DECIMAL(18,4), @in_discountAmount),
    PromoCodeUsed         = @in_promoCodeUsed,
    PromoDiscountAmount   = CONVERT(DECIMAL(18,4), @in_promoDiscount),
    LoyaltyDiscountAmount = CONVERT(DECIMAL(18,4), @in_loyaltyDiscount),
    LoyaltyPointsEarned   = @in_loyaltyPoints,
    CalcCachedAt          = @in_now,
    CalcVersion           = N'calc-2022-08',
    ModifiedAt            = @in_now,
    ModifiedBy            = @in_modifiedBy
WHERE OrderNumber = @in_orderNumber;

UPDATE c
SET
    c.LastQuotedPrice = c.PriceNet,
    c.LastQuotedAt    = @in_now,
    c.ModifiedAt      = @in_now,
    c.ModifiedBy      = @in_modifiedBy
FROM dbo.Catalog c
INNER JOIN (
    -- The procedure joins #Lines here, which holds one row per order line with
    -- a ProductID. A product appearing on several lines matched several times
    -- and every match wrote the identical values, so DISTINCT is equivalent.
    -- ProductID is not touched by the UPDATE above, so reading it back now
    -- gives the same set the procedure snapshotted earlier.
    SELECT DISTINCT ProductID
    FROM dbo.OrderLedger
    WHERE OrderNumber = @in_orderNumber
      AND ProductID IS NOT NULL
) l ON l.ProductID = c.ProductID;
`;

function assertInvariant(ok: boolean, name: string, detail: string): void {
  if (!ok) throw new Error(`invariant ${name} violated: ${detail}`);
}

export async function persist(
  pool: sql.ConnectionPool,
  input: PricingInput,
  pricing: Pricing,
  now: Date,
): Promise<void> {
  // Back to exact fixed-point before anything is written.
  const totalNet = scaled4(pricing.totalNet);
  const totalVat = scaled4(pricing.totalVat);
  const totalWithVat = scaled4(pricing.totalWithVat);
  const promoDiscount = scaled4(pricing.promoDiscount);
  const loyaltyDiscount = scaled4(pricing.loyaltyDiscount);

  // The procedure writes DiscountAmount as @PromoDiscount + @LoyaltyDiscount
  // inline in the UPDATE. Summed as integers so the written column is the exact
  // sum of the two columns written beside it.
  const discountAmount = promoDiscount + loyaltyDiscount;

  // Neither of these is carried on the Pricing interface, and both are pure
  // functions of NetSubtotal, so they are re-derived through the same helpers
  // the calculation used rather than re-stating the 1500 and 100 thresholds.
  const shippingCost = scaled4(shippingCostFor(pricing.netSubtotal));
  const loyaltyPoints = loyaltyPointsFor(pricing.netSubtotal);

  // -- Invariants, checked against what is about to be written --------------
  assertInvariant(
    discountAmount === promoDiscount + loyaltyDiscount,
    "discountamount_equals_promo_plus_loyalty",
    `DiscountAmount=${formatScaled4(discountAmount)} PromoDiscountAmount=${formatScaled4(promoDiscount)} LoyaltyDiscountAmount=${formatScaled4(loyaltyDiscount)}`,
  );
  assertInvariant(
    totalWithVat >= 0n &&
      shippingCost >= 0n &&
      discountAmount >= 0n &&
      promoDiscount >= 0n &&
      loyaltyDiscount >= 0n &&
      loyaltyPoints >= 0,
    "monetary_columns_non_negative",
    `TotalWithVat=${formatScaled4(totalWithVat)} ShippingCost=${formatScaled4(shippingCost)} DiscountAmount=${formatScaled4(discountAmount)} LoyaltyPointsEarned=${loyaltyPoints}`,
  );
  assertInvariant(
    shippingCost === 0n || shippingCost === scaled4(99),
    "monetary_columns_non_negative",
    `ShippingCost must be 0 or 99, got ${formatScaled4(shippingCost)}`,
  );
  assertInvariant(
    Number.isInteger(loyaltyPoints),
    "loyalty_points_floor_division_not_checked_precisely",
    `LoyaltyPointsEarned=${loyaltyPoints} is not a whole number`,
  );
  // TotalNet + TotalVat = TotalWithVat holds except where step 13's clamp fired,
  // which the spec documents and which is recognisable as TotalWithVat = 0.
  assertInvariant(
    totalNet + totalVat === totalWithVat || totalWithVat === 0n,
    "totalwithvat_equals_net_plus_vat",
    `TotalNet=${formatScaled4(totalNet)} TotalVat=${formatScaled4(totalVat)} TotalWithVat=${formatScaled4(totalWithVat)}`,
  );

  await pool
    .request()
    .input("in_orderNumber", sql.NVarChar(20), input.orderNumber)
    .input("in_modifiedBy", sql.NVarChar(60), input.modifiedBy)
    .input("in_promoCodeUsed", sql.NVarChar(40), pricing.promoCode)
    .input("in_totalNet", sql.VarChar(40), formatScaled4(totalNet))
    .input("in_totalVat", sql.VarChar(40), formatScaled4(totalVat))
    .input("in_totalWithVat", sql.VarChar(40), formatScaled4(totalWithVat))
    .input("in_shippingCost", sql.VarChar(40), formatScaled4(shippingCost))
    .input("in_discountAmount", sql.VarChar(40), formatScaled4(discountAmount))
    .input("in_promoDiscount", sql.VarChar(40), formatScaled4(promoDiscount))
    .input(
      "in_loyaltyDiscount",
      sql.VarChar(40),
      formatScaled4(loyaltyDiscount),
    )
    .input("in_loyaltyPoints", sql.Int, loyaltyPoints)
    .input("in_now", sql.DateTime2(3), now)
    .query(PERSIST_SQL);
}
