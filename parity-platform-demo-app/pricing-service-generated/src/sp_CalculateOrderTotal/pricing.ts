// pricing.ts
//
// Replacement for the calculating half of dbo.sp_CalculateOrderTotal.
//
// The rule for this file is parity, not correctness. Where the procedure does
// something that looks wrong, this file does the same thing and says so in a
// PRESERVED DEFECT comment naming the spec's open question. Fixes belong in a
// separate change, after parity is proven.
//
// Two things are load-bearing and easy to break:
//
//  1. MONEY IS DECIMAL, NOT DOUBLE. SQL Server computes in decimal and rounds
//     half away from zero when a value lands in a variable with fewer decimal
//     places. Binary floating point rounds the other way on exact boundaries
//     and every one of those is a monetary diff a human has to read. So all
//     arithmetic below is done on BigInt fixed-point values, and money crosses
//     the SQL boundary as VARCHAR that T-SQL CONVERTs to DECIMAL(18,4).
//
//  2. T-SQL IDENTIFIERS ARE CASE-INSENSITIVE. @totalNet and @TotalNet are the
//     same variable. Every bound parameter in this file is prefixed "in_" and
//     no local declared in any batch uses that prefix, so a DECLARE can never
//     collide with a parameter that mssql has already declared for the batch.
//
// The clock arrives as `now`. Never call new Date()/Date.now()/GETDATE() here:
// the service has to be replayable against a recorded clock.

import sql from "mssql";

export class OrderNotFound extends Error {
  constructor(orderNumber: string) {
    // Mirrors the procedure's RAISERROR text, which embeds @OrderNumber.
    super(`sp_CalculateOrderTotal: objednavka ${orderNumber} neexistuje`);
    this.name = "OrderNotFound";
  }
}

export interface PricingInput {
  orderNumber: string;
  promoCode: string | null;
  modifiedBy: string;
}

export interface Pricing {
  netSubtotal: number;
  vatRate: number;
  promoCode: string | null;
  promoDiscount: number;
  loyaltyDiscount: number;
  totalNet: number;
  totalVat: number;
  totalWithVat: number;
  stackedWithLoyalty: boolean;
}

// ---------------------------------------------------------------------------
// Fixed-point decimal arithmetic
// ---------------------------------------------------------------------------
// A value is a BigInt plus a scale (number of decimal places). Scale 4 is
// DECIMAL(18,4), the type of every money variable in the procedure. Scale 6 is
// DECIMAL(9,6), the type of @VatRate.

const SCALE_MONEY = 4;
const SCALE_RATE = 6;

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/** Parse a decimal string as emitted by CONVERT(VARCHAR, <decimal>). */
function parseDecimal(text: string): { value: bigint; scale: number } {
  const trimmed = text.trim();
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  const dot = body.indexOf(".");
  const intPart = dot < 0 ? body : body.slice(0, dot);
  const fracPart = dot < 0 ? "" : body.slice(dot + 1);
  if (!/^[0-9]*$/.test(intPart) || !/^[0-9]*$/.test(fracPart)) {
    throw new Error(`not a decimal literal: ${text}`);
  }
  const digits = (intPart === "" ? "0" : intPart) + fracPart;
  const magnitude = BigInt(digits);
  return { value: negative ? -magnitude : magnitude, scale: fracPart.length };
}

/**
 * Move a fixed-point value to a different scale.
 *
 * Widening is exact. Narrowing rounds half AWAY FROM ZERO, which is what SQL
 * Server does both when storing into a narrower decimal and in ROUND(). This
 * is the single most important function in the file.
 */
function rescale(value: bigint, fromScale: number, toScale: number): bigint {
  if (toScale === fromScale) return value;
  if (toScale > fromScale) return value * pow10(toScale - fromScale);
  const divisor = pow10(fromScale - toScale);
  const quotient = value / divisor; // BigInt division truncates toward zero
  const remainder = value % divisor;
  const doubledRemainder = (remainder < 0n ? -remainder : remainder) * 2n;
  if (doubledRemainder >= divisor) {
    return quotient + (value < 0n ? -1n : 1n);
  }
  return quotient;
}

/** Integer division rounding toward negative infinity, i.e. T-SQL FLOOR(). */
function floorDiv(numerator: bigint, denominator: bigint): bigint {
  let quotient = numerator / denominator;
  if (numerator % denominator !== 0n && numerator < 0n !== denominator < 0n) {
    quotient -= 1n;
  }
  return quotient;
}

/** Render a fixed-point value as a plain decimal string. */
export function formatScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  let digits = (negative ? -value : value).toString();
  if (scale === 0) return (negative ? "-" : "") + digits;
  while (digits.length <= scale) digits = "0" + digits;
  const split = digits.length - scale;
  return (
    (negative ? "-" : "") + digits.slice(0, split) + "." + digits.slice(split)
  );
}

function toNumber(value: bigint, scale: number): number {
  return Number(formatScaled(value, scale));
}

/** Take a number that carries a 4-decimal-place money value back to BigInt. */
export function scaled4(value: number): bigint {
  if (!Number.isFinite(value)) {
    throw new Error(`not a finite money value: ${value}`);
  }
  const parsed = parseDecimal(value.toFixed(SCALE_MONEY));
  return rescale(parsed.value, parsed.scale, SCALE_MONEY);
}

export function formatScaled4(value: bigint): string {
  return formatScaled(value, SCALE_MONEY);
}

function parseAtScale(
  text: string | null | undefined,
  scale: number,
): bigint | null {
  if (text === null || text === undefined) return null;
  const parsed = parseDecimal(text);
  return rescale(parsed.value, parsed.scale, scale);
}

function assertInvariant(ok: boolean, name: string, detail: string): void {
  if (!ok) throw new Error(`invariant ${name} violated: ${detail}`);
}

// ---------------------------------------------------------------------------
// Derived figures that persist.ts also needs
// ---------------------------------------------------------------------------
// The Pricing interface the HTTP shell expects carries neither ShippingCost nor
// LoyaltyPointsEarned, but both are written to OrderLedger. Both are pure
// functions of NetSubtotal, so persist.ts re-derives them through these two
// helpers rather than duplicating the thresholds.

/** Step 8: >= 1500 net ships free, otherwise a flat 99. */
function shippingCostScaled(netSubtotal: bigint): bigint {
  const freeShippingThreshold = rescale(1500n, 0, SCALE_MONEY);
  return netSubtotal >= freeShippingThreshold ? 0n : rescale(99n, 0, SCALE_MONEY);
}

export function shippingCostFor(netSubtotal: number): number {
  return toNumber(shippingCostScaled(scaled4(netSubtotal)), SCALE_MONEY);
}

/** Step 7: FLOOR(@NetSubtotal / 100.0), one point per 100 net. */
function loyaltyPointsScaled(netSubtotal: bigint): bigint {
  return floorDiv(netSubtotal, rescale(100n, 0, SCALE_MONEY));
}

export function loyaltyPointsFor(netSubtotal: number): number {
  return Number(loyaltyPointsScaled(scaled4(netSubtotal)));
}

// ---------------------------------------------------------------------------
// Reading the order
// ---------------------------------------------------------------------------

interface OrderFacts {
  orderFound: boolean;
  countryCode: string;
  loyaltyTier: number | null;
  netSubtotal: bigint; // scale 4
  vatRate: bigint; // scale 6
  resolvedPromoCode: string | null;
  promoFound: boolean;
  promoPct: bigint | null; // scale 2, DECIMAL(5,2)
  promoAmt: bigint | null; // scale 4
  promoMin: bigint | null; // scale 4
  promoCountry: string | null;
  promoActive: boolean;
  nowAtOrAfterValidFrom: boolean;
  nowAtOrBeforeValidTo: boolean;
  stacksFlag: boolean;
}

// Steps 1-7 of the procedure are read-only and are executed here as the same
// T-SQL the procedure used, deliberately:
//
//   * LineNet = Quantity * UnitPriceNet * (1 - LineDiscountPct / 100.0) is a
//     DECIMAL(29,4) * DECIMAL(21,10) product whose nominal precision exceeds
//     38, so SQL Server reduces the result scale by its own overflow rule.
//     Re-deriving that rule in TypeScript would be a guess; running the
//     identical expression against the identical declared types cannot be
//     wrong.
//   * The INNER JOIN to Catalog, the VAT fallback cascade and the promo lookup
//     all carry NULL and TOP-1-without-ORDER-BY semantics that are cheaper to
//     preserve than to re-express.
//
// Money leaves this batch as VARCHAR so that no value passes through a double.
const READ_ORDER_SQL = `
SET NOCOUNT ON;

-- Locals never use the "in_" prefix that every bound parameter uses. T-SQL
-- identifiers are case-insensitive, so a DECLARE differing from a bound
-- parameter only in case would be a duplicate declaration and the whole batch
-- would fail before computing anything.
DECLARE @OrderID            INT;
DECLARE @CustomerID         INT;
DECLARE @CountryCode        NVARCHAR(2);
DECLARE @LoyaltyTier        TINYINT;
DECLARE @NetSubtotal        DECIMAL(18,4) = 0;
DECLARE @VatRate            DECIMAL(9,6);
DECLARE @StacksFlag         BIT = 0;
DECLARE @ResolvedPromoCode  NVARCHAR(40);
DECLARE @PromoCodeID        INT;
DECLARE @PromoPct           DECIMAL(5,2);
DECLARE @PromoAmt           DECIMAL(18,4);
DECLARE @PromoMin           DECIMAL(18,4);
DECLARE @PromoCategory      INT;
DECLARE @PromoCountry       NVARCHAR(2);
DECLARE @PromoActive        BIT;
DECLARE @PromoFrom          DATETIME2(3);
DECLARE @PromoTo            DATETIME2(3);

CREATE TABLE #Lines
(
    OrderLineID     BIGINT,
    ProductID       INT,
    CategoryID      INT NULL,
    Quantity        INT,
    UnitPriceNet    DECIMAL(18,4),
    LineDiscountPct DECIMAL(5,2),
    LineNet         DECIMAL(18,4)
);

-- Step 1. TOP 1 with no ORDER BY: OrderID/CustomerID/CountryCode come from an
-- arbitrary row of the order and are never checked for agreement across rows.
SELECT TOP 1
    @OrderID     = OrderID,
    @CustomerID  = CustomerID,
    @CountryCode = CustomerCountryCode
FROM dbo.OrderLedger
WHERE OrderNumber = @in_orderNumber;

IF @OrderID IS NOT NULL
BEGIN
    -- Step 2. Unknown customer country defaults to CZ.
    IF @CountryCode IS NULL SET @CountryCode = N'CZ';

    -- Step 3. Only rows carrying a ProductID take part in the subtotal.
    INSERT INTO #Lines (OrderLineID, ProductID, Quantity, UnitPriceNet, LineDiscountPct)
    SELECT OrderLineID, ProductID, Quantity, UnitPriceNet, ISNULL(LineDiscountPct, 0)
    FROM dbo.OrderLedger
    WHERE OrderNumber = @in_orderNumber
      AND ProductID IS NOT NULL;

    -- PRESERVED DEFECT (spec: "Radky s produktem mimo katalog mlcky
    -- neprispivaji do mezisouctu"). INNER JOIN, so a line whose ProductID is no
    -- longer in Catalog keeps LineNet = NULL, drops out of SUM() silently, and
    -- still gets the order totals written to it at the end.
    UPDATE l
    SET l.CategoryID = c.CategoryID,
        l.LineNet    = l.Quantity * l.UnitPriceNet * (1 - l.LineDiscountPct / 100.0)
    FROM #Lines l
    INNER JOIN dbo.Catalog c ON c.ProductID = l.ProductID;

    SELECT @NetSubtotal = SUM(LineNet) FROM #Lines;
    IF @NetSubtotal IS NULL SET @NetSubtotal = 0;

    -- Step 4. VAT rate cascade: ratebook, then the category of the
    -- lowest-OrderLineID line, then a hardcoded 21%.
    SELECT @VatRate = Rate / 100.0
    FROM dbo.VatRate
    WHERE CountryCode = @CountryCode AND RateCode = N'standard';

    IF @VatRate IS NULL
    BEGIN
        -- PRESERVED DEFECT (spec: "Fallback sazby DPH podle kategorie prvni
        -- polozky je nahodily"). "First" means lowest OrderLineID, i.e. insert
        -- order, not the largest or most representative line.
        SELECT TOP 1 @VatRate = cat.VatRate / 100.0
        FROM #Lines l
        INNER JOIN dbo.Category cat ON cat.CategoryID = l.CategoryID
        ORDER BY l.OrderLineID;

        IF @VatRate IS NULL SET @VatRate = 0.21;
    END

    -- Step 5. Loyalty tier is read live from Customer, not snapshotted onto the
    -- order, so a later recalculation of the same order can differ.
    SELECT @LoyaltyTier = LoyaltyTier FROM dbo.Customer WHERE CustomerID = @CustomerID;

    -- Step 6. A NULL @PromoCode means "leave the promo as it is", not "no
    -- promo": the code already on the order is adopted. There is no way to
    -- clear a promo code through this procedure.
    SET @ResolvedPromoCode = @in_promoCode;
    IF @ResolvedPromoCode IS NULL
    BEGIN
        SELECT TOP 1 @ResolvedPromoCode = PromoCodeUsed
        FROM dbo.OrderLedger WHERE OrderNumber = @in_orderNumber;
    END

    IF @ResolvedPromoCode IS NOT NULL
    BEGIN
        -- PRESERVED DEFECT (spec: "StacksWithLoyalty se nastavi bez ohledu na
        -- platnost promo kodu"). @StacksFlag is taken here, on lookup by Code,
        -- before any activity/date/minimum/country check.
        -- PRESERVED DEFECT (spec: "Omezeni promo kodu na kategorii se
        -- nekontroluje"). @PromoCategory is read and then never consulted.
        SELECT
            @PromoCodeID = PromoCodeID, @PromoPct = DiscountPct, @PromoAmt = DiscountAmount,
            @PromoMin = MinOrderValue, @PromoCategory = CategoryID, @PromoCountry = CountryCode,
            @StacksFlag = ISNULL(StacksWithLoyalty, 0), @PromoActive = IsActive,
            @PromoFrom = ValidFrom, @PromoTo = ValidTo
        FROM dbo.PromoCode
        WHERE Code = @ResolvedPromoCode;
    END
END

SELECT
    CASE WHEN @OrderID IS NULL THEN 0 ELSE 1 END      AS OrderFound,
    @CountryCode                                      AS CountryCode,
    @LoyaltyTier                                      AS LoyaltyTier,
    CONVERT(VARCHAR(40), @NetSubtotal)                AS NetSubtotalText,
    CONVERT(VARCHAR(40), @VatRate)                    AS VatRateText,
    @ResolvedPromoCode                                AS ResolvedPromoCode,
    CASE WHEN @PromoCodeID IS NULL THEN 0 ELSE 1 END  AS PromoFound,
    CONVERT(VARCHAR(40), @PromoPct)                   AS PromoPctText,
    CONVERT(VARCHAR(40), @PromoAmt)                   AS PromoAmtText,
    CONVERT(VARCHAR(40), @PromoMin)                   AS PromoMinText,
    @PromoCountry                                     AS PromoCountry,
    -- NULL IsActive compares UNKNOWN against 1 in T-SQL, so it lands on 0 here
    -- exactly as it would fail the procedure's IF.
    CASE WHEN @PromoActive = 1 THEN 1 ELSE 0 END      AS PromoActive,
    -- The two date bounds are evaluated in SQL against the injected clock so
    -- that DATETIME2 comparison semantics (and NULL bounds, which make the
    -- procedure's IF fail) are the database's, not JavaScript's.
    CASE WHEN @in_now >= @PromoFrom THEN 1 ELSE 0 END AS NowAtOrAfterValidFrom,
    CASE WHEN @in_now <= @PromoTo THEN 1 ELSE 0 END   AS NowAtOrBeforeValidTo,
    CASE WHEN @StacksFlag = 1 THEN 1 ELSE 0 END       AS StacksFlag;

DROP TABLE #Lines;
`;

async function readOrderFacts(
  pool: sql.ConnectionPool,
  input: PricingInput,
  now: Date,
): Promise<OrderFacts> {
  const result = await pool
    .request()
    .input("in_orderNumber", sql.NVarChar(20), input.orderNumber)
    .input("in_promoCode", sql.NVarChar(40), input.promoCode)
    .input("in_now", sql.DateTime2(3), now)
    .query(READ_ORDER_SQL);

  const row = result.recordset[0] as Record<string, unknown>;

  if (Number(row.OrderFound) !== 1) {
    return {
      orderFound: false,
      countryCode: "CZ",
      loyaltyTier: null,
      netSubtotal: 0n,
      vatRate: 0n,
      resolvedPromoCode: null,
      promoFound: false,
      promoPct: null,
      promoAmt: null,
      promoMin: null,
      promoCountry: null,
      promoActive: false,
      nowAtOrAfterValidFrom: false,
      nowAtOrBeforeValidTo: false,
      stacksFlag: false,
    };
  }

  return {
    orderFound: true,
    countryCode: (row.CountryCode as string | null) ?? "CZ",
    loyaltyTier:
      row.LoyaltyTier === null || row.LoyaltyTier === undefined
        ? null
        : Number(row.LoyaltyTier),
    netSubtotal:
      parseAtScale(row.NetSubtotalText as string | null, SCALE_MONEY) ?? 0n,
    vatRate: parseAtScale(row.VatRateText as string | null, SCALE_RATE) ?? 0n,
    resolvedPromoCode: (row.ResolvedPromoCode as string | null) ?? null,
    promoFound: Number(row.PromoFound) === 1,
    promoPct: parseAtScale(row.PromoPctText as string | null, 2),
    promoAmt: parseAtScale(row.PromoAmtText as string | null, SCALE_MONEY),
    promoMin: parseAtScale(row.PromoMinText as string | null, SCALE_MONEY),
    promoCountry: (row.PromoCountry as string | null) ?? null,
    promoActive: Number(row.PromoActive) === 1,
    nowAtOrAfterValidFrom: Number(row.NowAtOrAfterValidFrom) === 1,
    nowAtOrBeforeValidTo: Number(row.NowAtOrBeforeValidTo) === 1,
    stacksFlag: Number(row.StacksFlag) === 1,
  };
}

/**
 * T-SQL `=` on NVARCHAR is case-insensitive and ignores trailing blanks under
 * the usual collations. Country codes are ASCII, so folding case and trimming
 * reproduces that.
 */
function sqlTextEquals(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return false;
  return left.trim().toUpperCase() === right.trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// The calculation
// ---------------------------------------------------------------------------

export async function price(
  pool: sql.ConnectionPool,
  input: PricingInput,
  now: Date,
): Promise<Pricing> {
  const facts = await readOrderFacts(pool, input, now);

  if (!facts.orderFound) {
    // Step 1: the procedure RAISERRORs and returns without writing anything.
    throw new OrderNotFound(input.orderNumber);
  }

  const netSubtotal = facts.netSubtotal; // scale 4
  const vatRate = facts.vatRate; // scale 6

  // -- Step 7. Promo discount ------------------------------------------------
  let promoDiscount = 0n; // scale 4

  if (facts.promoFound) {
    // Note what is NOT in this condition: PromoCode.CategoryID.
    // PRESERVED DEFECT (spec: "Omezeni promo kodu na kategorii se
    // nekontroluje"). A category-restricted code applies to an order that
    // contains none of that category.
    const promoIsValid =
      facts.promoActive &&
      facts.nowAtOrAfterValidFrom &&
      facts.nowAtOrBeforeValidTo &&
      (facts.promoMin === null || netSubtotal >= facts.promoMin) &&
      (facts.promoCountry === null ||
        sqlTextEquals(facts.promoCountry, facts.countryCode));

    if (promoIsValid) {
      if (facts.promoPct !== null) {
        // @NetSubtotal * @PromoPct / 100.0
        // scale 4 * scale 2 = scale 6; dividing by 100 shifts to scale 8 with
        // the same digits; SQL Server then stores into DECIMAL(18,4).
        const productScale8 = netSubtotal * facts.promoPct;
        promoDiscount = rescale(productScale8, 8, SCALE_MONEY);
      } else {
        // Percentage and flat amount are never combined.
        promoDiscount = facts.promoAmt ?? 0n;
      }
    }
    // Promo found but rejected by the IF: discount stays 0. Step 14 still
    // writes the code into PromoCodeUsed.
  }
  // PRESERVED DEFECT (spec: "Neznamy promo kod"). A code absent from
  // dbo.PromoCode yields no discount but is still recorded as "used".

  // -- Default total including VAT ------------------------------------------
  // @NetSubtotal * (1 + @VatRate) - @PromoDiscount
  // PRESERVED DEFECT (spec: "Nekonzistentni zaklad DPH mezi stacking a
  // nestacking vetvi"). Here VAT is charged on the full subtotal and the promo
  // discount is subtracted from the VAT-inclusive figure, so the promo is not
  // VAT-deductible. The stacking branch below does the opposite.
  const onePlusVatRate = rescale(1n, 0, SCALE_RATE) + vatRate; // scale 6
  let totalWithVat = rescale(
    netSubtotal * onePlusVatRate - rescale(promoDiscount, SCALE_MONEY, 10),
    10,
    SCALE_MONEY,
  );

  // -- Step 9. Loyalty discount by tier -------------------------------------
  let loyaltyDiscount = 0n; // scale 4
  const loyaltyThreshold = rescale(500n, 0, SCALE_MONEY);

  if (
    facts.loyaltyTier !== null &&
    facts.loyaltyTier >= 1 &&
    netSubtotal >= loyaltyThreshold
  ) {
    // Percentages are DECIMAL(2,2) literals in the procedure: scale 2.
    let tierPercent: bigint;
    if (sqlTextEquals(facts.countryCode, "CZ")) {
      if (facts.loyaltyTier >= 4) {
        tierPercent = 12n; // 0.12
      } else if (facts.loyaltyTier === 3) {
        tierPercent = 8n; // 0.08
      } else if (facts.loyaltyTier === 2) {
        tierPercent = 5n; // 0.05
      } else {
        tierPercent = 2n; // 0.02
      }
    } else {
      // PRESERVED DEFECT (spec: "Rozpor komentare a kodu u vernostni slevy mimo
      // CR"). The procedure's comment says non-CZ customers get no loyalty
      // discount; the code grants them a flat 3% regardless of tier. The code
      // is the behaviour of record.
      tierPercent = 3n; // 0.03
    }
    // scale 4 * scale 2 = scale 6, then stored into DECIMAL(18,4).
    loyaltyDiscount = rescale(netSubtotal * tierPercent, 6, SCALE_MONEY);
  }

  // -- Steps 10 and 11. Points and shipping ---------------------------------
  const loyaltyPoints = loyaltyPointsScaled(netSubtotal);
  const shippingCost = shippingCostScaled(netSubtotal);

  // ROUND(@ShippingCost * 0.21, 2).
  // PRESERVED DEFECT (spec: "DPH na dopravu je natvrdo 21 %"). Shipping VAT
  // ignores the rate resolved in step 4, so a non-CZ order can carry shipping
  // VAT at a rate its goods are not taxed at.
  const shippingVatScale2 = rescale(shippingCost * 21n, 6, 2);
  const shippingVat = rescale(shippingVatScale2, 2, SCALE_MONEY);

  // -- Step 12. Promo stacked with loyalty ----------------------------------
  // @StacksFlag was set on lookup by Code, so it is set even for a promo that
  // failed the validity IF above. That is harmless only because PromoDiscount
  // is then 0.
  const stackedWithLoyalty = facts.stacksFlag && loyaltyDiscount > 0n;

  if (stackedWithLoyalty) {
    // (@NetSubtotal - @PromoDiscount) * (1 + @VatRate): the promo comes off the
    // taxed base here and only here.
    totalWithVat = rescale(
      (netSubtotal - promoDiscount) * onePlusVatRate,
      10,
      SCALE_MONEY,
    );
  }

  // All scale 4 from here on, so these are exact.
  totalWithVat = totalWithVat - loyaltyDiscount + shippingCost + shippingVat;

  const totalNet = netSubtotal - promoDiscount - loyaltyDiscount + shippingCost;
  const totalVat = totalWithVat - totalNet;

  // -- Step 13. Negative-total safeguard ------------------------------------
  // PRESERVED DEFECT (spec: "Pojistka proti zaporne castce je neuplna").
  // TotalWithVat is clamped to 0 but TotalNet and TotalVat are left as they
  // were, so in this one case the three stored totals no longer reconcile.
  const clamped = totalWithVat < 0n;
  if (clamped) {
    totalWithVat = 0n;
  }

  // -- Invariants -----------------------------------------------------------
  assertInvariant(
    totalWithVat >= 0n,
    "monetary_columns_non_negative",
    `TotalWithVat=${formatScaled4(totalWithVat)}`,
  );
  assertInvariant(
    promoDiscount >= 0n && loyaltyDiscount >= 0n,
    "monetary_columns_non_negative",
    `PromoDiscount=${formatScaled4(promoDiscount)} LoyaltyDiscount=${formatScaled4(loyaltyDiscount)}`,
  );
  assertInvariant(
    shippingCost >= 0n && loyaltyPoints >= 0n,
    "monetary_columns_non_negative",
    `ShippingCost=${formatScaled4(shippingCost)} LoyaltyPoints=${loyaltyPoints}`,
  );
  // Checked only when the clamp did not fire: the clamp is the documented and
  // accepted way this identity breaks.
  if (!clamped) {
    assertInvariant(
      totalVat === totalWithVat - totalNet,
      "totalwithvat_equals_net_plus_vat",
      `TotalNet=${formatScaled4(totalNet)} TotalVat=${formatScaled4(totalVat)} TotalWithVat=${formatScaled4(totalWithVat)}`,
    );
  }

  return {
    netSubtotal: toNumber(netSubtotal, SCALE_MONEY),
    vatRate: toNumber(vatRate, SCALE_RATE),
    // Step 14 writes the resolved code, which may have come from the order
    // rather than from the caller, and may be a code that gave no discount.
    promoCode: facts.resolvedPromoCode,
    promoDiscount: toNumber(promoDiscount, SCALE_MONEY),
    loyaltyDiscount: toNumber(loyaltyDiscount, SCALE_MONEY),
    totalNet: toNumber(totalNet, SCALE_MONEY),
    totalVat: toNumber(totalVat, SCALE_MONEY),
    totalWithVat: toNumber(totalWithVat, SCALE_MONEY),
    stackedWithLoyalty,
  };
}
