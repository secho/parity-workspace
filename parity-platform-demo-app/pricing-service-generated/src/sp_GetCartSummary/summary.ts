// summary.ts -- replacement for dbo.sp_GetCartSummary
//
// Behaviour-preserving port. Read-only: this module issues SELECTs only and
// writes nothing, exactly like the procedure (whose only mutation was the local
// #CartLines temp table, replaced here by an in-memory array).
//
// Everything that looks wrong in here is wrong in the procedure too and is
// reproduced deliberately. See the report accompanying this file.

import sql from "mssql";

// ---------------------------------------------------------------------------
// Decimal arithmetic
//
// SQL Server computes money in DECIMAL, and every SET in the procedure lands in
// a DECIMAL(18,4) (or DECIMAL(9,6)) variable, which rounds the expression to
// that scale, half away from zero. Binary floating point rounds the other way
// on values that land exactly on a boundary, so we keep an exact scaled integer
// and round explicitly at each assignment.
// ---------------------------------------------------------------------------

type Dec = { v: bigint; s: number }; // value = v / 10^s

const POW10: bigint[] = [1n];

function pow10(n: number): bigint {
  while (POW10.length <= n) {
    POW10.push(POW10[POW10.length - 1] * 10n);
  }
  return POW10[n];
}

function decFromInt(n: number): Dec {
  return { v: BigInt(n), s: 0 };
}

/** Parse a decimal literal, or a decimal the server rendered as VARCHAR. */
function decFromString(text: string): Dec {
  const t = text.trim();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(t);
  if (m === null) {
    throw new Error(`not a decimal value: ${JSON.stringify(text)}`);
  }
  const whole = m[2];
  const frac = m[3] === undefined ? "" : m[3];
  if (whole.length === 0 && frac.length === 0) {
    throw new Error(`not a decimal value: ${JSON.stringify(text)}`);
  }
  const digits = BigInt((whole === "" ? "0" : whole) + frac);
  return { v: m[1] === "-" ? -digits : digits, s: frac.length };
}

/** Read a DECIMAL that the server sent us; NULL stays NULL. */
function decFromDb(value: unknown): Dec | null {
  if (value === null || value === undefined) return null;
  return decFromString(String(value));
}

/** Change scale. Reducing scale rounds half away from zero, as SQL Server does. */
function rescale(d: Dec, s: number): Dec {
  if (s === d.s) return d;
  if (s > d.s) return { v: d.v * pow10(s - d.s), s };
  const factor = pow10(d.s - s);
  const negative = d.v < 0n;
  const magnitude = negative ? -d.v : d.v;
  let quotient = magnitude / factor;
  if ((magnitude % factor) * 2n >= factor) quotient += 1n;
  return { v: negative ? -quotient : quotient, s };
}

function add(a: Dec, b: Dec): Dec {
  const s = Math.max(a.s, b.s);
  return { v: rescale(a, s).v + rescale(b, s).v, s };
}

function sub(a: Dec, b: Dec): Dec {
  const s = Math.max(a.s, b.s);
  return { v: rescale(a, s).v - rescale(b, s).v, s };
}

function mul(a: Dec, b: Dec): Dec {
  return { v: a.v * b.v, s: a.s + b.s };
}

function cmp(a: Dec, b: Dec): number {
  const s = Math.max(a.s, b.s);
  const av = rescale(a, s).v;
  const bv = rescale(b, s).v;
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

/** a / b, exact quotient rounded half away from zero at the given scale. */
function div(a: Dec, b: Dec, scale: number): Dec {
  if (b.v === 0n) throw new Error("divide by zero");
  let numerator = a.v * pow10(b.s) * pow10(scale);
  let denominator = b.v * pow10(a.s);
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  let quotient = magnitude / denominator;
  if ((magnitude % denominator) * 2n >= denominator) quotient += 1n;
  return { v: negative ? -quotient : quotient, s: scale };
}

/** FLOOR(d / 100.0) as an integer. */
function floorDivideBy100(d: Dec): number {
  const denominator = pow10(d.s) * 100n;
  let quotient = d.v / denominator;
  if (d.v < 0n && d.v % denominator !== 0n) quotient -= 1n;
  return Number(quotient);
}

function decToString(d: Dec): string {
  const negative = d.v < 0n;
  let digits = (negative ? -d.v : d.v).toString();
  if (d.s === 0) return (negative ? "-" : "") + digits;
  while (digits.length <= d.s) digits = "0" + digits;
  const cut = digits.length - d.s;
  return (negative ? "-" : "") + digits.slice(0, cut) + "." + digits.slice(cut);
}

function decToNumber(d: Dec): number {
  return Number(decToString(d));
}

const ZERO4: Dec = { v: 0n, s: 4 };

// ---------------------------------------------------------------------------
// T-SQL string semantics, needed by the cart parser
// ---------------------------------------------------------------------------

/** LEN() ignores trailing spaces. */
function tsqlLen(s: string): number {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 32) end -= 1;
  return end;
}

/** SUBSTRING(): 1-based start; a start below 1 eats into the length. */
function tsqlSubstring(s: string, start: number, length: number): string {
  let from = start;
  let len = length;
  if (from < 1) {
    len = len + from - 1;
    from = 1;
  }
  if (len <= 0) return "";
  return s.slice(from - 1, from - 1 + len);
}

/** LTRIM(RTRIM()) strips spaces. */
function tsqlTrimSpaces(s: string): string {
  return s.replace(/^ +/, "").replace(/ +$/, "");
}

/** CHARINDEX(): 1-based position, 0 when not found. */
function tsqlCharIndex(needle: string, haystack: string): number {
  return haystack.indexOf(needle) + 1;
}

/**
 * TRY_CAST(<string> AS INT). Note the quirk the procedure leans on: an empty or
 * all-whitespace string casts to 0, it does not fail. So "5:" yields Qty = 0
 * (dropped by the Qty > 0 gate) and ":3" yields ProductID = 0 (inserted, then
 * lost at the INNER JOIN against dbo.Catalog).
 */
function tryCastInt(text: string): number | null {
  const t = text.replace(/^\s+/, "").replace(/\s+$/, "");
  if (t === "") return 0;
  if (!/^[+-]?\d+$/.test(t)) return null;
  const v = BigInt(t);
  if (v < -2147483648n || v > 2147483647n) return null;
  return Number(v);
}

/**
 * Default-collation string equality: case-insensitive, trailing spaces are not
 * significant. Used for @CountryCode = N'CZ' and the promo country restriction.
 */
function tsqlStringEquals(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  return a.replace(/ +$/, "").toUpperCase() === b.replace(/ +$/, "").toUpperCase();
}

// ---------------------------------------------------------------------------
// Invariant assertions
// ---------------------------------------------------------------------------

function assertInvariant(ok: boolean, name: string, detail: string): void {
  if (!ok) throw new Error(`invariant ${name} violated: ${detail}`);
}

// ---------------------------------------------------------------------------
// Parameters
//
// The captured input object is keyed by the procedure's parameter names. Accept
// them with or without the leading @ and without caring about case.
// ---------------------------------------------------------------------------

function paramValue(params: Record<string, unknown>, name: string): unknown {
  for (const key of Object.keys(params)) {
    const bare = key.startsWith("@") ? key.slice(1) : key;
    if (bare.toLowerCase() === name.toLowerCase()) return params[key];
  }
  return undefined;
}

function paramString(params: Record<string, unknown>, name: string): string | null {
  const value = paramValue(params, name);
  if (value === null || value === undefined) return null;
  return String(value);
}

function paramInt(params: Record<string, unknown>, name: string): number | null {
  const value = paramValue(params, name);
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  const t = String(value).trim();
  if (t === "") return null;
  return Number(t);
}

function dbInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function dbTimeMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

// ---------------------------------------------------------------------------

type CartLine = {
  productID: number;
  quantity: number;
  categoryID: number | null;
  unitPriceNet: Dec | null;
  lineNet: Dec | null;
  inCatalog: boolean;
  sku: unknown;
  name: unknown;
};

export async function summarise(
  pool: sql.ConnectionPool,
  params: Record<string, unknown>,
  now: Date,
): Promise<{ resultSets: unknown[][] }> {
  const cartItems = paramString(params, "CartItems");
  const customerID = paramInt(params, "CustomerID");
  const promoCode = paramString(params, "PromoCode");
  // @ModifiedBy is declared by the procedure but never read -- a leftover from
  // the copy of sp_CalculateOrderTotal. Nothing to do with it.

  // -- country and loyalty tier -------------------------------------------
  // SELECT @CountryCode = ..., @LoyaltyTier = ... FROM dbo.Customer WHERE
  // CustomerID = @CustomerID. A NULL @CustomerID matches no row, so both stay
  // NULL; when several rows matched, the last one assigned would win.
  let countryCode: string | null = null;
  let loyaltyTier: number | null = null;
  if (customerID !== null) {
    const result = await pool
      .request()
      .input("CustomerID", sql.Int, customerID)
      .query(
        "SELECT CountryCode, LoyaltyTier FROM dbo.Customer WHERE CustomerID = @CustomerID",
      );
    if (result.recordset.length > 0) {
      const row = result.recordset[result.recordset.length - 1];
      const rawCountry = row.CountryCode;
      // @CountryCode is NVARCHAR(2); a longer value would be truncated.
      countryCode =
        rawCountry === null || rawCountry === undefined ? null : String(rawCountry).slice(0, 2);
      loyaltyTier = dbInt(row.LoyaltyTier);
    }
  }
  if (countryCode === null) countryCode = "CZ";

  // -- 1. parse "productId:qty,productId:qty,..." --------------------------
  const cartLines: CartLine[] = [];
  let cart = (cartItems === null ? "" : cartItems) + ",";
  while (tsqlLen(cart) > 0) {
    const pos = tsqlCharIndex(",", cart);
    if (pos === 0) break;
    // @Chunk is NVARCHAR(100): anything longer is silently truncated.
    const chunk = tsqlTrimSpaces(tsqlSubstring(cart, 1, pos - 1)).slice(0, 100);
    cart = tsqlSubstring(cart, pos + 1, tsqlLen(cart));
    if (tsqlLen(chunk) > 0) {
      const colonPos = tsqlCharIndex(":", chunk);
      if (colonPos > 0) {
        const pid = tryCastInt(tsqlSubstring(chunk, 1, colonPos - 1));
        const qty = tryCastInt(tsqlSubstring(chunk, colonPos + 1, tsqlLen(chunk)));
        if (pid !== null && qty !== null && qty > 0) {
          // Duplicate ProductIDs are NOT merged -- two rows are inserted.
          cartLines.push({
            productID: pid,
            quantity: qty,
            categoryID: null,
            unitPriceNet: null,
            lineNet: null,
            inCatalog: false,
            sku: null,
            name: null,
          });
        }
      }
    }
  }

  // -- 2. price and category from the catalog, line net --------------------
  // The UPDATE ... FROM #CartLines INNER JOIN dbo.Catalog only touches rows
  // whose ProductID exists; the rest keep NULL CategoryID/UnitPriceNet/LineNet.
  const productIDs = Array.from(new Set(cartLines.map((line) => line.productID)));
  if (productIDs.length > 0) {
    const request = pool.request();
    const placeholders = productIDs.map((id, i) => {
      request.input(`p${i}`, sql.Int, id);
      return `@p${i}`;
    });
    const result = await request.query(
      `SELECT ProductID, CAST(PriceNet AS VARCHAR(40)) AS PriceNet, CategoryID, Sku, Name
         FROM dbo.Catalog
        WHERE ProductID IN (${placeholders.join(", ")})`,
    );
    const catalog = new Map<number, sql.IRecordSet<any>[number]>();
    for (const row of result.recordset) {
      catalog.set(Number(row.ProductID), row);
    }
    for (const line of cartLines) {
      const row = catalog.get(line.productID);
      if (row === undefined) continue;
      line.inCatalog = true;
      line.categoryID = dbInt(row.CategoryID);
      line.sku = row.Sku === undefined ? null : row.Sku;
      line.name = row.Name === undefined ? null : row.Name;
      const priceNet = decFromDb(row.PriceNet);
      line.unitPriceNet = priceNet === null ? null : rescale(priceNet, 4);
      // LineNet = Quantity * PriceNet * (1 - LineDiscountPct / 100.0).
      // LineDiscountPct is inserted as 0 and never changed, so the factor is
      // exactly 1. Result lands in DECIMAL(18,4).
      line.lineNet =
        priceNet === null ? null : rescale(mul(decFromInt(line.quantity), priceNet), 4);
    }
  }

  // SELECT @NetSubtotal = SUM(LineNet) FROM #CartLines; SUM skips NULLs and
  // returns NULL when there is nothing to add, which ISNULL turns into 0.
  let netSubtotal: Dec | null = null;
  for (const line of cartLines) {
    if (line.lineNet === null) continue;
    netSubtotal = netSubtotal === null ? line.lineNet : add(netSubtotal, line.lineNet);
  }
  const net: Dec = netSubtotal === null ? ZERO4 : rescale(netSubtotal, 4);

  // -- 3. VAT rate: three-step cascade ------------------------------------
  let vatRate: Dec | null = null;
  {
    const result = await pool
      .request()
      .input("CountryCode", sql.NVarChar(2), countryCode)
      .query(
        `SELECT CAST(Rate AS VARCHAR(40)) AS Rate
           FROM dbo.VatRate
          WHERE CountryCode = @CountryCode AND RateCode = N'standard'`,
      );
    if (result.recordset.length > 0) {
      const rate = decFromDb(result.recordset[result.recordset.length - 1].Rate);
      // @VatRate is DECIMAL(9,6).
      vatRate = rate === null ? null : rescale(div(rate, decFromInt(100), 7), 6);
    }
  }
  if (vatRate === null) {
    // SELECT TOP 1 @VatRate = cat.VatRate / 100.0 FROM #CartLines l INNER JOIN
    // dbo.Category cat ON cat.CategoryID = l.CategoryID ORDER BY l.ProductID.
    // One arbitrarily chosen category's rate, not a weighted average.
    const categoryIDs = Array.from(
      new Set(
        cartLines
          .filter((line) => line.categoryID !== null)
          .map((line) => line.categoryID as number),
      ),
    );
    const categoryVat = new Map<number, Dec | null>();
    if (categoryIDs.length > 0) {
      const request = pool.request();
      const placeholders = categoryIDs.map((id, i) => {
        request.input(`c${i}`, sql.Int, id);
        return `@c${i}`;
      });
      const result = await request.query(
        `SELECT CategoryID, CAST(VatRate AS VARCHAR(40)) AS VatRate
           FROM dbo.Category
          WHERE CategoryID IN (${placeholders.join(", ")})`,
      );
      for (const row of result.recordset) {
        const rate = decFromDb(row.VatRate);
        // Invariant: category_vat_rate_non_negative. A negative fallback rate
        // would make @VatRate negative and corrupt VatAmount/TotalWithVat for
        // every cart that reaches this branch.
        assertInvariant(
          rate === null || cmp(rate, decFromInt(0)) >= 0,
          "category_vat_rate_non_negative",
          `dbo.Category.VatRate = ${rate === null ? "NULL" : decToString(rate)} for CategoryID ${row.CategoryID}`,
        );
        categoryVat.set(Number(row.CategoryID), rate);
      }
    }
    const joinable = cartLines
      .filter((line) => line.categoryID !== null && categoryVat.has(line.categoryID as number))
      .slice()
      .sort((a, b) => a.productID - b.productID);
    if (joinable.length > 0) {
      const rate = categoryVat.get(joinable[0].categoryID as number) as Dec | null;
      vatRate = rate === null ? null : rescale(div(rate, decFromInt(100), 7), 6);
    }
    if (vatRate === null) {
      vatRate = { v: 210000n, s: 6 }; // 0.21 -- the safety net
    }
  }

  // -- 4. promo code ------------------------------------------------------
  let promoDiscount: Dec = ZERO4;
  if (promoCode !== null) {
    const result = await pool
      .request()
      .input("Code", sql.NVarChar(40), promoCode)
      .query(
        `SELECT PromoCodeID,
                CAST(DiscountPct AS VARCHAR(40))    AS DiscountPct,
                CAST(DiscountAmount AS VARCHAR(40)) AS DiscountAmount,
                CAST(MinOrderValue AS VARCHAR(40))  AS MinOrderValue,
                CategoryID, CountryCode, StacksWithLoyalty, IsActive, ValidFrom, ValidTo
           FROM dbo.PromoCode
          WHERE Code = @Code`,
      );
    if (result.recordset.length > 0) {
      const row = result.recordset[result.recordset.length - 1];
      const promoCodeID = dbInt(row.PromoCodeID);
      const promoPct = decFromDb(row.DiscountPct);
      const promoAmt = decFromDb(row.DiscountAmount);
      const promoMin = decFromDb(row.MinOrderValue);
      const promoCountry =
        row.CountryCode === null || row.CountryCode === undefined
          ? null
          : String(row.CountryCode).slice(0, 2);
      const promoActive = dbInt(row.IsActive);
      const promoFrom = dbTimeMs(row.ValidFrom);
      const promoTo = dbTimeMs(row.ValidTo);
      // @PromoCategory and @StacksFlag are read by the procedure and then never
      // used; nothing consumes them here either.

      // Invariant: promocode_discount_fields_non_negative. @PromoDiscount is
      // never clamped to >= 0, so the reference data must not hold negative
      // discounts or a negative minimum-order gate.
      assertInvariant(
        promoPct === null || cmp(promoPct, decFromInt(0)) >= 0,
        "promocode_discount_fields_non_negative",
        `dbo.PromoCode.DiscountPct = ${promoPct === null ? "NULL" : decToString(promoPct)}`,
      );
      assertInvariant(
        promoAmt === null || cmp(promoAmt, decFromInt(0)) >= 0,
        "promocode_discount_fields_non_negative",
        `dbo.PromoCode.DiscountAmount = ${promoAmt === null ? "NULL" : decToString(promoAmt)}`,
      );
      assertInvariant(
        promoMin === null || cmp(promoMin, decFromInt(0)) >= 0,
        "promocode_discount_fields_non_negative",
        `dbo.PromoCode.MinOrderValue = ${promoMin === null ? "NULL" : decToString(promoMin)}`,
      );

      if (promoCodeID !== null) {
        // @Now >= @PromoFrom AND @Now <= @PromoTo: a NULL bound makes the whole
        // predicate unknown, so the discount is not applied.
        const nowMs = now.getTime();
        const inWindow =
          promoFrom !== null && promoTo !== null && nowMs >= promoFrom && nowMs <= promoTo;
        const minOk = promoMin === null || cmp(net, promoMin) >= 0;
        const countryOk = promoCountry === null || tsqlStringEquals(promoCountry, countryCode);
        if (promoActive === 1 && inWindow && minOk && countryOk) {
          if (promoPct !== null) {
            // @NetSubtotal * @PromoPct / 100.0 -> DECIMAL(18,4)
            promoDiscount = rescale(div(mul(net, promoPct), decFromInt(100), 11), 4);
          } else {
            promoDiscount = promoAmt === null ? ZERO4 : rescale(promoAmt, 4);
          }
        }
      }
    }
  }

  // Oldest part of the procedure. Note this SET rounds to DECIMAL(18,4) before
  // the loyalty/shipping adjustments below are applied.
  let totalWithVat = rescale(sub(mul(net, add(decFromInt(1), vatRate)), promoDiscount), 4);

  // -- 5. loyalty discount by tier ---------------------------------------
  let loyaltyDiscount: Dec = ZERO4;
  if (loyaltyTier !== null) {
    if (loyaltyTier >= 1) {
      if (cmp(net, decFromInt(500)) >= 0) {
        if (tsqlStringEquals(countryCode, "CZ")) {
          if (loyaltyTier >= 4) {
            loyaltyDiscount = rescale(mul(net, decFromString("0.12")), 4);
          } else if (loyaltyTier === 3) {
            loyaltyDiscount = rescale(mul(net, decFromString("0.08")), 4);
          } else if (loyaltyTier === 2) {
            loyaltyDiscount = rescale(mul(net, decFromString("0.05")), 4);
          } else {
            loyaltyDiscount = rescale(mul(net, decFromString("0.02")), 4);
          }
        } else {
          // The source comment here claims "SK customers are not entitled to a
          // loyalty discount", but the code grants a flat 3% and the captured
          // traffic confirms it. Preserved as written, comment and all.
          loyaltyDiscount = rescale(mul(net, decFromString("0.03")), 4);
        }
      }
    }
  }

  // -- 6. loyalty points: 1 per 100 of the undiscounted net ---------------
  const loyaltyPoints = floorDivideBy100(net);

  // -- 7. shipping --------------------------------------------------------
  const shippingCost: Dec = cmp(net, decFromInt(1500)) >= 0 ? ZERO4 : rescale(decFromInt(99), 4);
  // Shipping VAT is hardcoded at 21%, ignoring @VatRate entirely.
  const shippingVat = rescale(rescale(mul(shippingCost, decFromString("0.21")), 2), 4);

  totalWithVat = add(add(sub(totalWithVat, loyaltyDiscount), shippingCost), shippingVat);
  const totalNet = add(sub(sub(net, promoDiscount), loyaltyDiscount), shippingCost);
  // TotalVat is derived before the clamp below, and this is what the summary
  // reports as VatAmount. The discounts cancel out of it algebraically, so
  // VatAmount always equals NetSubtotal * VatRate + ShippingVat.
  const totalVat = sub(totalWithVat, totalNet);

  const discountAmount = add(promoDiscount, loyaltyDiscount);

  // Verified pre-clamp: TotalWithVat = NetSubtotal - DiscountAmount
  //                                    + ShippingCost + VatAmount.
  assertInvariant(
    cmp(totalWithVat, add(add(sub(net, discountAmount), shippingCost), totalVat)) === 0,
    "output_total_identity",
    `NetSubtotal=${decToString(net)} DiscountAmount=${decToString(discountAmount)} ` +
      `ShippingCost=${decToString(shippingCost)} VatAmount=${decToString(totalVat)} ` +
      `TotalWithVat=${decToString(totalWithVat)}`,
  );

  // The clamp happens after TotalVat/TotalNet are computed, so on an extreme
  // discount combination the reported VatAmount no longer reconciles with the
  // clamped TotalWithVat. Preserved.
  if (cmp(totalWithVat, decFromInt(0)) < 0) totalWithVat = ZERO4;

  // -- 8. cart lines ------------------------------------------------------
  // INNER JOIN dbo.Catalog, so products missing from the catalog vanish.
  const lines = cartLines
    .filter((line) => line.inCatalog)
    .slice()
    .sort((a, b) => a.productID - b.productID)
    .map((line) => ({
      ProductID: line.productID,
      Sku: line.sku,
      Name: line.name,
      Quantity: line.quantity,
      UnitPriceNet: line.unitPriceNet === null ? null : decToNumber(line.unitPriceNet),
      LineNet: line.lineNet === null ? null : decToNumber(line.lineNet),
    }));

  // -- 9. summary row -----------------------------------------------------
  const summary = {
    NetSubtotal: decToNumber(net),
    VatAmount: decToNumber(totalVat),
    ShippingCost: decToNumber(shippingCost),
    DiscountAmount: decToNumber(discountAmount),
    LoyaltyPointsEarned: loyaltyPoints,
    TotalWithVat: decToNumber(totalWithVat),
  };

  return { resultSets: [lines, [summary]] };
}
