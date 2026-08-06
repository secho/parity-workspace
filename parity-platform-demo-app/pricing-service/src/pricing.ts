import sql from 'mssql';

/**
 * `sp_CalculateOrderTotal`, as a service.
 *
 * Written from the specification the agent extracted at M3 and the invariants it proposed at
 * M4 — line totals, the VAT rate table, the loyalty ladder, points, shipping. Every branch of
 * the procedure is reproduced, with **one deliberate exception**, and that exception is the
 * entire reason M5 has anything to compare:
 *
 *   The procedure has a branch, added during the 2022 VERNY20 campaign, that computes VAT on
 *   `net − promo` when a stacking promo meets a loyalty discount. Every other branch computes
 *   VAT on the full net. The two differ by exactly `promo × vat`.
 *
 *   It does not break the procedure's own `TotalWithVat = TotalNet + TotalVat` identity —
 *   `TotalVat` is *defined* as the difference — so fifteen years of self-consistency checks
 *   could never have seen it. It is only visible against the rate table, or against a second
 *   implementation. This is the second implementation.
 *
 * This service therefore charges VAT on the full net in every branch, which is what the spec
 * says and what the rate table implies. It is not a fix — nobody has decided anything yet.
 * It is a divergence, and the point of the shadow run is that a human gets to choose.
 *
 * On arithmetic: T-SQL evaluates this in `DECIMAL(18,4)` and rounds at every assignment, so
 * `dec4` is applied in exactly the places the procedure assigns to a variable. Rounding in
 * different places would produce differences in the last cent that are real but meaningless,
 * and this file exists to make the differences that survive meaningful.
 */

/** Round to a decimal scale the way SQL Server does: half away from zero. */
function dec(value: number, scale: number): number {
  const factor = 10 ** scale;
  // Scaling a binary float lands just under the true half often enough to matter — 20.785
  // arrives as 20.784999999999997 and would round down where the engine rounds up. The nudge
  // is far smaller than the last kept digit and far larger than the representation error.
  const scaled = value * factor;
  const nudged = scaled + (scaled < 0 ? -1e-9 : 1e-9);
  return (scaled < 0 ? -Math.round(-nudged) : Math.round(nudged)) / factor;
}

const dec4 = (value: number): number => dec(value, 4);

export interface PricingInput {
  orderNumber: string;
  promoCode: string | null;
  modifiedBy: string;
}

export interface OrderLine {
  orderLineId: number;
  productId: number;
  categoryId: number | null;
  quantity: number;
  unitPriceNet: number;
  lineDiscountPct: number;
  /** Null when the product is missing from Catalog — see the note where this is built. */
  lineNet: number | null;
}

export interface Pricing {
  orderId: number;
  customerId: number;
  countryCode: string;
  lines: OrderLine[];
  netSubtotal: number;
  vatRate: number;
  promoCode: string | null;
  promoDiscount: number;
  loyaltyDiscount: number;
  loyaltyPoints: number;
  shippingCost: number;
  shippingVat: number;
  totalNet: number;
  totalVat: number;
  totalWithVat: number;
  discountAmount: number;
  /** True when the procedure would have taken its VAT-on-net-minus-promo branch here. */
  stackedWithLoyalty: boolean;
}

export class OrderNotFound extends Error {
  constructor(orderNumber: string) {
    super(`sp_CalculateOrderTotal: objednavka ${orderNumber} neexistuje`);
  }
}

export async function price(pool: sql.ConnectionPool, input: PricingInput, now: Date): Promise<Pricing> {
  // 1. the order
  const header = (
    await pool.request().input('order', sql.NVarChar(20), input.orderNumber).query(`
      SELECT TOP 1 OrderID, CustomerID, CustomerCountryCode, PromoCodeUsed
      FROM dbo.OrderLedger WHERE OrderNumber = @order`)
  ).recordset[0] as { OrderID: number; CustomerID: number; CustomerCountryCode: string | null; PromoCodeUsed: string | null } | undefined;

  if (header === undefined) throw new OrderNotFound(input.orderNumber);
  const countryCode = header.CustomerCountryCode ?? 'CZ';

  // 2. lines, with the per-line net the procedure computes into #Lines
  const lineRows = (
    await pool.request().input('order', sql.NVarChar(20), input.orderNumber).query(`
      SELECT o.OrderLineID, o.ProductID, c.CategoryID, o.Quantity, o.UnitPriceNet,
             ISNULL(o.LineDiscountPct, 0) AS LineDiscountPct
      FROM dbo.OrderLedger o
      LEFT JOIN dbo.Catalog c ON c.ProductID = o.ProductID
      WHERE o.OrderNumber = @order AND o.ProductID IS NOT NULL
      ORDER BY o.OrderLineID`)
  ).recordset as { OrderLineID: number; ProductID: number; CategoryID: number | null; Quantity: number; UnitPriceNet: number; LineDiscountPct: number }[];

  const lines: OrderLine[] = lineRows.map((row) => ({
    orderLineId: row.OrderLineID,
    productId: row.ProductID,
    categoryId: row.CategoryID,
    quantity: row.Quantity,
    unitPriceNet: Number(row.UnitPriceNet),
    lineDiscountPct: Number(row.LineDiscountPct),
    // Null when the product is not in Catalog, and that is the procedure's behaviour rather
    // than a defensive default: `#Lines` is filled from OrderLedger alone, and `LineNet` is
    // only ever set by the `UPDATE … INNER JOIN dbo.Catalog` that follows. A line whose
    // product has gone misses that update, keeps a NULL, and `SUM` skips it silently.
    lineNet:
      row.CategoryID === null
        ? null
        : // Rounded per line, because #Lines.LineNet is DECIMAL(18,4) and the sum comes after.
          dec4(row.Quantity * Number(row.UnitPriceNet) * (1 - Number(row.LineDiscountPct) / 100)),
  }));

  const netSubtotal = dec4(lines.reduce((sum, line) => sum + (line.lineNet ?? 0), 0));

  // 3. VAT, with the procedure's fallback cascade intact: the country's standard rate, then
  //    the first line's category rate, then 0.21 as a backstop.
  const vatRate = await resolveVatRate(pool, countryCode, lines);

  // 4. loyalty tier — the current one from Customer, not the snapshot on the order
  const tier = (
    await pool.request().input('customer', sql.Int, header.CustomerID).query(`
      SELECT LoyaltyTier FROM dbo.Customer WHERE CustomerID = @customer`)
  ).recordset[0]?.LoyaltyTier as number | null | undefined;

  // 5. promo — the parameter, or the one already on the order
  const promoCode = input.promoCode ?? header.PromoCodeUsed ?? null;
  const promo = await resolvePromo(pool, promoCode, countryCode, netSubtotal, now);

  // 6. loyalty discount: four levels of nesting in the original, and the SK branch really is
  //    a flat 3% despite the comment above it claiming SK customers get nothing.
  let loyaltyDiscount = 0;
  if (tier !== null && tier !== undefined && tier >= 1 && netSubtotal >= 500) {
    if (countryCode === 'CZ') {
      const rate = tier >= 4 ? 0.12 : tier === 3 ? 0.08 : tier === 2 ? 0.05 : 0.02;
      loyaltyDiscount = dec4(netSubtotal * rate);
    } else {
      loyaltyDiscount = dec4(netSubtotal * 0.03);
    }
  }

  // 7. one point per 100 Kč of net
  const loyaltyPoints = Math.floor(netSubtotal / 100);

  // 8. shipping: free over 1500, otherwise a flat 99
  const shippingCost = netSubtotal >= 1500 ? 0 : 99;
  const shippingVat = dec(shippingCost * 0.21, 2);

  // 9. ---- the divergence -------------------------------------------------------------
  // VAT on the full net, in every branch. The procedure switches to `(net − promo) × (1 + vat)`
  // when a stacking promo meets a loyalty discount; nothing in the specification, the rate
  // table, or the invariants says the taxable base should shrink because a discount was
  // granted. Recorded here rather than silently: the flag travels with the result so the
  // shadow run can say which cases the old branch applied to.
  const stackedWithLoyalty = promo.stacksWithLoyalty && loyaltyDiscount > 0;
  let totalWithVat = dec4(netSubtotal * (1 + vatRate) - promo.discount);

  totalWithVat = dec4(totalWithVat - loyaltyDiscount + shippingCost + shippingVat);
  const totalNet = dec4(netSubtotal - promo.discount - loyaltyDiscount + shippingCost);
  const totalVat = dec4(totalWithVat - totalNet);
  if (totalWithVat < 0) totalWithVat = 0;

  return {
    orderId: header.OrderID,
    customerId: header.CustomerID,
    countryCode,
    lines,
    netSubtotal,
    vatRate,
    promoCode,
    promoDiscount: promo.discount,
    loyaltyDiscount,
    loyaltyPoints,
    shippingCost,
    shippingVat,
    totalNet,
    totalVat,
    totalWithVat,
    discountAmount: dec4(promo.discount + loyaltyDiscount),
    stackedWithLoyalty,
  };
}

async function resolveVatRate(pool: sql.ConnectionPool, countryCode: string, lines: OrderLine[]): Promise<number> {
  const standard = (
    await pool.request().input('country', sql.NVarChar(2), countryCode).query(`
      SELECT Rate FROM dbo.VatRate WHERE CountryCode = @country AND RateCode = N'standard'`)
  ).recordset[0]?.Rate as number | undefined;
  if (standard !== undefined && standard !== null) return dec(Number(standard) / 100, 6);

  // The procedure's second fallback is `TOP 1 … INNER JOIN dbo.Category … ORDER BY OrderLineID`,
  // so it is the first line whose category actually *exists* in the reference table, not the
  // first line that carries an id. Kept as one query rather than a find-then-lookup for that
  // reason — the two differ exactly when a Catalog row points at a category that was deleted.
  const ids = lines.map((line) => line.categoryId).filter((id): id is number => id !== null);
  if (ids.length > 0) {
    const request = pool.request();
    lines.forEach((line, i) => {
      if (line.categoryId !== null) request.input(`c${i}`, sql.Int, line.categoryId);
    });
    const ordered = lines
      .map((line, i) => (line.categoryId === null ? null : `(${line.orderLineId}, @c${i})`))
      .filter((v): v is string => v !== null)
      .join(', ');

    const categoryRate = (
      await request.query(`
        SELECT TOP 1 cat.VatRate
        FROM (VALUES ${ordered}) AS l(OrderLineID, CategoryID)
        INNER JOIN dbo.Category cat ON cat.CategoryID = l.CategoryID
        ORDER BY l.OrderLineID`)
    ).recordset[0]?.VatRate as number | null | undefined;
    if (categoryRate !== undefined && categoryRate !== null) return dec(Number(categoryRate) / 100, 6);
  }

  // Reference table and category both missing. The procedure's comment calls this a
  // "pojistka"; it is reproduced because it is behaviour, not because it is good.
  return 0.21;
}

interface ResolvedPromo {
  discount: number;
  stacksWithLoyalty: boolean;
}

async function resolvePromo(
  pool: sql.ConnectionPool,
  code: string | null,
  countryCode: string,
  netSubtotal: number,
  now: Date,
): Promise<ResolvedPromo> {
  if (code === null) return { discount: 0, stacksWithLoyalty: false };

  const row = (
    await pool.request().input('code', sql.NVarChar(40), code).query(`
      SELECT PromoCodeID, DiscountPct, DiscountAmount, MinOrderValue, CountryCode,
             ISNULL(StacksWithLoyalty, 0) AS StacksWithLoyalty, IsActive, ValidFrom, ValidTo
      FROM dbo.PromoCode WHERE Code = @code`)
  ).recordset[0] as
    | {
        DiscountPct: number | null;
        DiscountAmount: number | null;
        MinOrderValue: number | null;
        CountryCode: string | null;
        StacksWithLoyalty: boolean | number;
        IsActive: boolean | number | null;
        ValidFrom: Date | null;
        ValidTo: Date | null;
      }
    | undefined;

  // The stacking flag is read off the promo whether or not the promo applies — that is what
  // the procedure does, because it assigns @StacksFlag in the same SELECT as everything else.
  if (row === undefined) return { discount: 0, stacksWithLoyalty: false };
  const stacksWithLoyalty = row.StacksWithLoyalty === true || row.StacksWithLoyalty === 1;

  const active = row.IsActive === true || row.IsActive === 1;
  const inWindow =
    row.ValidFrom !== null && row.ValidTo !== null && now >= row.ValidFrom && now <= row.ValidTo;
  const meetsMinimum = row.MinOrderValue === null || netSubtotal >= Number(row.MinOrderValue);
  const rightCountry = row.CountryCode === null || row.CountryCode === countryCode;

  if (!(active && inWindow && meetsMinimum && rightCountry)) return { discount: 0, stacksWithLoyalty };

  const discount =
    row.DiscountPct !== null
      ? dec4((netSubtotal * Number(row.DiscountPct)) / 100)
      : dec4(Number(row.DiscountAmount ?? 0));

  return { discount, stacksWithLoyalty };
}
