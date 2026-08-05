import { getPool, sql } from './db.js';
import { withCapture } from './capture/index.js';

/**
 * The single seam through which every stored-procedure call passes.
 *
 * M1 wraps THIS function with invocation capture — inputs, result set, write set and
 * duration. Nothing may call a procedure any other way, or the capture has holes and
 * every number downstream becomes theatre.
 */
export interface ProcParam {
  type: sql.ISqlType | (() => sql.ISqlType);
  value: unknown;
}

export interface ProcResult {
  recordsets: sql.IRecordSet<Record<string, unknown>>[];
  recordset: sql.IRecordSet<Record<string, unknown>> | undefined;
  rowsAffected: number[];
  returnValue: unknown;
  durationMs: number;
}

export async function callProcedure(
  name: string,
  params: Record<string, ProcParam> = {},
): Promise<ProcResult> {
  const plainValues = Object.fromEntries(Object.entries(params).map(([k, p]) => [k, p.value ?? null]));

  // M1 wraps the seam here. Capture decides sampling, owns the Change Tracking version
  // window for the calls it records, and writes to parity_capture.Invocation. With
  // PARITY_CAPTURE=off this is a straight passthrough and the monolith behaves as in M0.
  return withCapture(name, plainValues, async () => {
    const pool = await getPool();
    const request = pool.request();

    for (const [key, param] of Object.entries(params)) {
      request.input(key, param.type, param.value ?? null);
    }

    const started = Date.now();
    const result = await request.execute(name);

    return {
      recordsets: result.recordsets as sql.IRecordSet<Record<string, unknown>>[],
      recordset: result.recordset as sql.IRecordSet<Record<string, unknown>> | undefined,
      rowsAffected: result.rowsAffected,
      returnValue: result.returnValue,
      durationMs: Date.now() - started,
    };
  });
}

// --- The eleven live procedures -------------------------------------------------
//
// Parameter names below are the procedures' real names, warts included: the estate
// was written by different people over fifteen years, so @OrderNumber, @p_OrderNumber,
// @orderNo and @orderNumber all mean the same thing. Normalising them here would hide
// the very inconsistency the spec is meant to surface.
//
// sp_ExportCatalogXml_OLD, sp_MigrateCustomerAddresses and sp_RecomputeLoyaltyTier_deprecated
// are deliberately ABSENT. They are the dead procedures: unreachable from the application,
// so their invocation count is structurally zero rather than merely observed to be zero.
// verify-m0 asserts they appear nowhere in this directory.

export const searchProducts = (p: {
  search?: string | null;
  categoryId?: number | null;
  minPrice?: number | null;
  maxPrice?: number | null;
  inStockOnly?: boolean;
  sortMode?: string | null;
  pageNumber?: number;
  pageSize?: number;
}) =>
  callProcedure('sp_SearchProducts', {
    searchText: { type: sql.NVarChar(200), value: p.search ?? null },
    categoryId: { type: sql.Int, value: p.categoryId ?? null },
    minPrice: { type: sql.Decimal(18, 4), value: p.minPrice ?? null },
    maxPrice: { type: sql.Decimal(18, 4), value: p.maxPrice ?? null },
    inStockOnly: { type: sql.Bit, value: p.inStockOnly ?? false },
    sortMode: { type: sql.NVarChar(30), value: p.sortMode ?? null },
    pageNumber: { type: sql.Int, value: p.pageNumber ?? 1 },
    pageSize: { type: sql.Int, value: p.pageSize ?? 24 },
  });

export const getProductDetail = (productId: number) =>
  callProcedure('sp_GetProductDetail', {
    ProductID: { type: sql.Int, value: productId },
  });

export const getProductAvailability = (productId: number) =>
  callProcedure('sp_GetProductAvailability', {
    ProductId: { type: sql.Int, value: productId },
  });

export const getCartSummary = (p: { cartItems: string; customerId?: number | null; promoCode?: string | null }) =>
  callProcedure('sp_GetCartSummary', {
    CartItems: { type: sql.NVarChar(4000), value: p.cartItems },
    CustomerID: { type: sql.Int, value: p.customerId ?? null },
    PromoCode: { type: sql.NVarChar(40), value: p.promoCode ?? null },
  });

export const calculateOrderTotal = (p: { orderNumber: string; promoCode?: string | null; modifiedBy?: string }) =>
  callProcedure('sp_CalculateOrderTotal', {
    OrderNumber: { type: sql.NVarChar(20), value: p.orderNumber },
    PromoCode: { type: sql.NVarChar(40), value: p.promoCode ?? null },
    ModifiedBy: { type: sql.NVarChar(60), value: p.modifiedBy ?? 'api' },
  });

export const reserveStock = (orderNumber: string, modifiedBy = 'api') =>
  callProcedure('sp_ReserveStock', {
    orderNo: { type: sql.NVarChar(20), value: orderNumber },
    modifiedBy: { type: sql.NVarChar(60), value: modifiedBy },
  });

export const applyPromoCode = (p: { orderNumber: string; code: string; customerId: number; modifiedBy?: string }) =>
  callProcedure('sp_ApplyPromoCode', {
    p_OrderNumber: { type: sql.NVarChar(20), value: p.orderNumber },
    p_Code: { type: sql.NVarChar(40), value: p.code },
    p_CustomerID: { type: sql.Int, value: p.customerId },
    p_ModifiedBy: { type: sql.NVarChar(60), value: p.modifiedBy ?? 'api' },
  });

export const placeOrder = (p: {
  customerId: number;
  linesRaw: string;
  promoCode?: string | null;
  paymentMethod?: string;
  shipStreet?: string | null;
  shipCity?: string | null;
  shipZip?: string | null;
  shipCountry?: string | null;
  billStreet?: string | null;
  billCity?: string | null;
  billZip?: string | null;
  billCountry?: string | null;
  createdBy?: string;
}) =>
  callProcedure('sp_PlaceOrder', {
    CustomerID: { type: sql.Int, value: p.customerId },
    LinesRaw: { type: sql.NVarChar(4000), value: p.linesRaw },
    PromoCode: { type: sql.NVarChar(40), value: p.promoCode ?? null },
    PaymentMethod: { type: sql.NVarChar(40), value: p.paymentMethod ?? 'Karta online' },
    ShipStreet: { type: sql.NVarChar(200), value: p.shipStreet ?? null },
    ShipCity: { type: sql.NVarChar(100), value: p.shipCity ?? null },
    ShipZip: { type: sql.NVarChar(10), value: p.shipZip ?? null },
    ShipCountry: { type: sql.NVarChar(2), value: p.shipCountry ?? null },
    BillStreet: { type: sql.NVarChar(200), value: p.billStreet ?? null },
    BillCity: { type: sql.NVarChar(100), value: p.billCity ?? null },
    BillZip: { type: sql.NVarChar(10), value: p.billZip ?? null },
    BillCountry: { type: sql.NVarChar(2), value: p.billCountry ?? null },
    CreatedBy: { type: sql.NVarChar(60), value: p.createdBy ?? 'api' },
  });

export const syncWarehouseDispatch = (p: { orderNumber: string; modifiedBy?: string }) =>
  callProcedure('sp_SyncWarehouseDispatch', {
    orderNumber: { type: sql.NVarChar(20), value: p.orderNumber },
    modifiedBy: { type: sql.NVarChar(60), value: p.modifiedBy ?? 'api' },
  });

export const recalculateCustomerScore = (customerId: number, calculatedBy = 'api') =>
  callProcedure('sp_RecalculateCustomerScore', {
    iCustomerId: { type: sql.Int, value: customerId },
    sCalculatedBy: { type: sql.NVarChar(60), value: calculatedBy },
  });

export const legacyPriceImport = (p: { priceData: string; batchId: string; modifiedBy?: string }) =>
  callProcedure('sp_LegacyPriceImport_v2', {
    PriceData: { type: sql.NVarChar(sql.MAX), value: p.priceData },
    BatchID: { type: sql.NVarChar(40), value: p.batchId },
    ModifiedBy: { type: sql.NVarChar(60), value: p.modifiedBy ?? 'api' },
  });
