import sql from 'mssql';
import type { Pricing, PricingInput } from './pricing.js';

/**
 * The two writes `sp_CalculateOrderTotal` makes.
 *
 * Both are load-bearing and the second one is easy to miss. The procedure caches the order
 * summary onto **every line** of the order — `OrderLedger` is one row per line, so a single
 * order total updates three or forty rows — and it then "anchors" the current catalogue price
 * of every product on the order into `Catalog.LastQuotedPrice` for a pricing report that runs
 * each morning. That second write is a side effect of a procedure whose name says it
 * calculates, it belongs to nobody, and it is exactly the kind of thing an extraction loses.
 *
 * Losing it would not be subtle: the shadow run would report a missing `Catalog` write on
 * every single case. Which is the point — the write set is what makes that visible at all.
 */
export async function persist(
  pool: sql.ConnectionPool,
  input: PricingInput,
  pricing: Pricing,
  now: Date,
): Promise<void> {
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    await new sql.Request(transaction)
      .input('order', sql.NVarChar(20), input.orderNumber)
      .input('totalNet', sql.Decimal(18, 4), pricing.totalNet)
      .input('totalVat', sql.Decimal(18, 4), pricing.totalVat)
      .input('totalWithVat', sql.Decimal(18, 4), pricing.totalWithVat)
      .input('shipping', sql.Decimal(18, 4), pricing.shippingCost)
      .input('discount', sql.Decimal(18, 4), pricing.discountAmount)
      .input('promoCode', sql.NVarChar(40), pricing.promoCode)
      .input('promoDiscount', sql.Decimal(18, 4), pricing.promoDiscount)
      .input('loyaltyDiscount', sql.Decimal(18, 4), pricing.loyaltyDiscount)
      .input('points', sql.Int, pricing.loyaltyPoints)
      .input('now', sql.DateTime2(3), now)
      .input('modifiedBy', sql.NVarChar(60), input.modifiedBy).query(`
        UPDATE dbo.OrderLedger
        SET TotalNet = @totalNet,
            TotalVat = @totalVat,
            TotalWithVat = @totalWithVat,
            ShippingCost = @shipping,
            DiscountAmount = @discount,
            PromoCodeUsed = @promoCode,
            PromoDiscountAmount = @promoDiscount,
            LoyaltyDiscountAmount = @loyaltyDiscount,
            LoyaltyPointsEarned = @points,
            CalcCachedAt = @now,
            CalcVersion = N'calc-2022-08',
            ModifiedAt = @now,
            ModifiedBy = @modifiedBy
        WHERE OrderNumber = @order`);

    // The anchor. Only products that resolved against Catalog — the procedure joins #Lines,
    // and a line whose product is gone never made it into that join.
    const anchored = pricing.lines.filter((line) => line.lineNet !== null).map((line) => line.productId);
    if (anchored.length > 0) {
      const request = new sql.Request(transaction)
        .input('now', sql.DateTime2(3), now)
        .input('modifiedBy', sql.NVarChar(60), input.modifiedBy);
      const unique = [...new Set(anchored)];
      unique.forEach((productId, i) => request.input(`p${i}`, sql.Int, productId));

      await request.query(`
        UPDATE dbo.Catalog
        SET LastQuotedPrice = PriceNet,
            LastQuotedAt = @now,
            ModifiedAt = @now,
            ModifiedBy = @modifiedBy
        WHERE ProductID IN (${unique.map((_, i) => `@p${i}`).join(', ')})`);
    }

    await transaction.commit();
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

/**
 * `CalcVersion` stays `calc-2022-08`.
 *
 * A new implementation is tempting to stamp with a new version string, and doing so would
 * turn every replayed case into a behaviour change — drowning the one real finding in
 * hundreds of self-inflicted ones. The version marks the pricing rules, and this service
 * implements the same rules; when the human decides what to do about the VAT branch, *that*
 * is when the version means something new.
 */
export const CALC_VERSION = 'calc-2022-08';
