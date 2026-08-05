// ParityShop seed. Applies db/*.sql in filename order, then bulk-loads deterministic
// data. Idempotent: 00-database.sql drops and recreates the database.
//
// Rows are inserted in a fixed order, so IDENTITY values come out identical on every
// run — Catalog.ProductID is 1..300 and Customer.CustomerID is 1..500 by construction,
// which is why the generated orders can reference them directly.

import sql from 'mssql';
import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, runSqlFile } from './db.js';
import { buildCatalog } from './catalog.js';
import { buildCustomers } from './customers.js';
import { buildOrders } from './orders.js';

const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db');

function t(started: number): string {
  return `${((Date.now() - started) / 1000).toFixed(1)}s`;
}

async function applySqlFiles(): Promise<void> {
  const master = await connect('master');
  try {
    const entries = (await readdir(DB_DIR, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.sql'))
      .map((e) => e.name)
      .sort();

    for (const name of entries) {
      const started = Date.now();
      await runSqlFile(master, join(DB_DIR, name));
      console.log(`  ${name} (${t(started)})`);
    }
  } finally {
    await master.close();
  }
}

async function applyProcedures(pool: sql.ConnectionPool): Promise<number> {
  const procDir = join(DB_DIR, '20-procs');
  let entries: string[];
  try {
    entries = (await readdir(procDir)).filter((n) => n.endsWith('.sql')).sort();
  } catch {
    return 0; // procedures not written yet
  }
  for (const name of entries) {
    await runSqlFile(pool, join(procDir, name));
  }
  return entries.length;
}

async function main(): Promise<void> {
  const overall = Date.now();
  console.log('applying schema...');
  await applySqlFiles();

  const pool = await connect('ParityShop');
  try {
    console.log('generating deterministic data...');
    const products = buildCatalog();
    const customers = buildCustomers(500);
    const { lines, movements, scores, aggregates } = buildOrders(products, customers, 5000);
    console.log(`  ${products.length} products, ${customers.length} customers, ${lines.length} order lines`);

    // --- Catalog ---------------------------------------------------------------
    let started = Date.now();
    const cat = new sql.Table('dbo.Catalog');
    cat.create = false;
    cat.columns.add('Sku', sql.NVarChar(40), { nullable: false });
    cat.columns.add('Name', sql.NVarChar(200), { nullable: false });
    cat.columns.add('ShortDescription', sql.NVarChar(500), { nullable: true });
    cat.columns.add('CategoryID', sql.Int, { nullable: true });
    cat.columns.add('CategoryPathCache', sql.NVarChar(300), { nullable: true });
    cat.columns.add('SupplierID', sql.Int, { nullable: true });
    cat.columns.add('SupplierSku', sql.NVarChar(60), { nullable: true });
    cat.columns.add('SupplierName', sql.NVarChar(150), { nullable: true });
    cat.columns.add('Manufacturer', sql.NVarChar(120), { nullable: true });
    cat.columns.add('Ean', sql.NVarChar(20), { nullable: true });
    cat.columns.add('WarrantyMonths', sql.Int, { nullable: true });
    cat.columns.add('WeightGrams', sql.Int, { nullable: true });
    cat.columns.add('PriceNet', sql.Decimal(18, 4), { nullable: false });
    cat.columns.add('PriceWithVat', sql.Decimal(18, 4), { nullable: true });
    cat.columns.add('VatRate', sql.Decimal(5, 2), { nullable: true });
    cat.columns.add('PurchasePrice', sql.Decimal(18, 4), { nullable: true });
    cat.columns.add('RecommendedPrice', sql.Decimal(18, 4), { nullable: true });
    cat.columns.add('Currency', sql.NVarChar(3), { nullable: true });
    cat.columns.add('StockQty', sql.Int, { nullable: true });
    cat.columns.add('ReservedQty', sql.Int, { nullable: true });
    cat.columns.add('StockQtyWh1', sql.Int, { nullable: true });
    cat.columns.add('StockQtyWh2', sql.Int, { nullable: true });
    cat.columns.add('StockQtyWh3', sql.Int, { nullable: true });
    cat.columns.add('ReorderLevel', sql.Int, { nullable: true });
    cat.columns.add('StockStatusCode', sql.TinyInt, { nullable: true });
    cat.columns.add('IsActive', sql.Bit, { nullable: true });
    cat.columns.add('IsVisible', sql.Bit, { nullable: true });
    cat.columns.add('IsFeatured', sql.Bit, { nullable: true });
    cat.columns.add('IsClearance', sql.Bit, { nullable: true });
    cat.columns.add('AllowBackorder', sql.Bit, { nullable: true });
    cat.columns.add('Popularity', sql.Int, { nullable: true });
    cat.columns.add('RatingAvg', sql.Decimal(3, 2), { nullable: true });
    cat.columns.add('RatingCount', sql.Int, { nullable: true });
    cat.columns.add('SoldCount', sql.Int, { nullable: true });
    cat.columns.add('ViewCount', sql.Int, { nullable: true });
    cat.columns.add('SeoTitle', sql.NVarChar(200), { nullable: true });
    cat.columns.add('SeoSlug', sql.NVarChar(200), { nullable: true });
    cat.columns.add('ImageUrl', sql.NVarChar(300), { nullable: true });
    cat.columns.add('ImageCount', sql.Int, { nullable: true });
    cat.columns.add('CreatedAt', sql.DateTime2(3), { nullable: true });
    cat.columns.add('CreatedBy', sql.NVarChar(60), { nullable: true });
    cat.columns.add('ModifiedAt', sql.DateTime2(3), { nullable: true });
    cat.columns.add('ModifiedBy', sql.NVarChar(60), { nullable: true });
    for (const p of products) {
      cat.rows.add(
        p.sku, p.name, p.shortDescription, p.categoryId, null,
        p.supplierId, p.supplierSku, p.supplierName, p.manufacturer, p.ean,
        p.warrantyMonths, p.weightGrams, p.priceNet, p.priceWithVat, p.vatRate,
        p.purchasePrice, p.recommendedPrice, 'CZK',
        p.stockQty, 0, p.stockQtyWh1, p.stockQtyWh2, p.stockQtyWh3, p.reorderLevel,
        p.stockQty > 0 ? 1 : 0,
        p.isActive, p.isVisible, p.isFeatured, p.isClearance, p.allowBackorder,
        p.popularity, p.ratingAvg, p.ratingCount, p.soldCount, p.viewCount,
        p.name, p.seoSlug, `/img/${p.seoSlug}.jpg`, 1,
        p.createdAt, 'seed', p.createdAt, 'seed',
      );
    }
    await pool.request().bulk(cat);
    console.log(`  Catalog ${products.length} (${t(started)})`);

    // --- Customer --------------------------------------------------------------
    started = Date.now();
    const cust = new sql.Table('dbo.Customer');
    cust.create = false;
    cust.columns.add('Email', sql.NVarChar(200), { nullable: false });
    cust.columns.add('FirstName', sql.NVarChar(100), { nullable: true });
    cust.columns.add('LastName', sql.NVarChar(100), { nullable: true });
    cust.columns.add('Phone', sql.NVarChar(40), { nullable: true });
    cust.columns.add('Street', sql.NVarChar(200), { nullable: true });
    cust.columns.add('City', sql.NVarChar(100), { nullable: true });
    cust.columns.add('Zip', sql.NVarChar(10), { nullable: true });
    cust.columns.add('CountryCode', sql.NVarChar(2), { nullable: true });
    cust.columns.add('CompanyName', sql.NVarChar(150), { nullable: true });
    cust.columns.add('VatId', sql.NVarChar(20), { nullable: true });
    cust.columns.add('LoyaltyTier', sql.TinyInt, { nullable: true });
    cust.columns.add('LoyaltyPoints', sql.Int, { nullable: true });
    cust.columns.add('TotalSpent', sql.Decimal(18, 4), { nullable: true });
    cust.columns.add('OrderCount', sql.Int, { nullable: true });
    cust.columns.add('RegisteredAt', sql.DateTime2(3), { nullable: true });
    cust.columns.add('LastOrderAt', sql.DateTime2(3), { nullable: true });
    cust.columns.add('IsActive', sql.Bit, { nullable: true });
    cust.columns.add('ModifiedAt', sql.DateTime2(3), { nullable: true });
    cust.columns.add('ModifiedBy', sql.NVarChar(60), { nullable: true });
    cust.columns.add('OldAddressLine', sql.NVarChar(300), { nullable: true });
    for (const c of customers) {
      const agg = aggregates.get(c.customerId)!;
      cust.rows.add(
        c.email, c.firstName, c.lastName, c.phone, c.street, c.city, c.zip, c.countryCode,
        c.companyName, c.vatId, c.loyaltyTier, c.loyaltyPoints,
        agg.totalSpent, agg.orderCount, c.registeredAt, agg.lastOrderAt,
        1, c.registeredAt, 'seed', c.oldAddressLine,
      );
    }
    await pool.request().bulk(cust);
    console.log(`  Customer ${customers.length} (${t(started)})`);

    // --- OrderLedger -----------------------------------------------------------
    started = Date.now();
    const ol = new sql.Table('dbo.OrderLedger');
    ol.create = false;
    ol.columns.add('OrderID', sql.Int, { nullable: false });
    ol.columns.add('OrderNumber', sql.NVarChar(20), { nullable: false });
    ol.columns.add('LineNumber', sql.Int, { nullable: false });
    ol.columns.add('CustomerID', sql.Int, { nullable: true });
    ol.columns.add('CustomerEmailSnapshot', sql.NVarChar(200), { nullable: true });
    ol.columns.add('CustomerNameSnapshot', sql.NVarChar(200), { nullable: true });
    ol.columns.add('CustomerPhoneSnapshot', sql.NVarChar(40), { nullable: true });
    ol.columns.add('CustomerLoyaltyTierSnapshot', sql.TinyInt, { nullable: true });
    ol.columns.add('CustomerCountryCode', sql.NVarChar(2), { nullable: true });
    ol.columns.add('BillStreet', sql.NVarChar(200), { nullable: true });
    ol.columns.add('BillCity', sql.NVarChar(100), { nullable: true });
    ol.columns.add('BillZip', sql.NVarChar(10), { nullable: true });
    ol.columns.add('BillCountry', sql.NVarChar(2), { nullable: true });
    ol.columns.add('ShipStreet', sql.NVarChar(200), { nullable: true });
    ol.columns.add('ShipCity', sql.NVarChar(100), { nullable: true });
    ol.columns.add('ShipZip', sql.NVarChar(10), { nullable: true });
    ol.columns.add('ShipCountry', sql.NVarChar(2), { nullable: true });
    ol.columns.add('ShipCompany', sql.NVarChar(150), { nullable: true });
    ol.columns.add('ProductID', sql.Int, { nullable: true });
    ol.columns.add('Sku', sql.NVarChar(40), { nullable: true });
    ol.columns.add('ProductNameSnapshot', sql.NVarChar(200), { nullable: true });
    ol.columns.add('Quantity', sql.Int, { nullable: true });
    ol.columns.add('UnitPriceNet', sql.Decimal(18, 4), { nullable: true });
    ol.columns.add('UnitPriceWithVat', sql.Decimal(18, 4), { nullable: true });
    ol.columns.add('LineVatRate', sql.Decimal(5, 2), { nullable: true });
    ol.columns.add('LineDiscountPct', sql.Decimal(5, 2), { nullable: true });
    ol.columns.add('LineNet', sql.Decimal(18, 4), { nullable: true });
    ol.columns.add('LineVat', sql.Decimal(18, 4), { nullable: true });
    ol.columns.add('LineTotal', sql.Decimal(18, 4), { nullable: true });
    ol.columns.add('TotalNet', sql.Decimal(18, 4), { nullable: true });
    ol.columns.add('TotalVat', sql.Decimal(18, 4), { nullable: true });
    ol.columns.add('TotalWithVat', sql.Decimal(18, 4), { nullable: true });
    ol.columns.add('ShippingCost', sql.Decimal(18, 4), { nullable: true });
    ol.columns.add('ShippingMethod', sql.NVarChar(40), { nullable: true });
    ol.columns.add('ShippingVatRate', sql.Decimal(5, 2), { nullable: true });
    ol.columns.add('DiscountAmount', sql.Decimal(18, 4), { nullable: true });
    ol.columns.add('PromoCodeUsed', sql.NVarChar(40), { nullable: true });
    ol.columns.add('PromoDiscountAmount', sql.Decimal(18, 4), { nullable: true });
    ol.columns.add('LoyaltyDiscountAmount', sql.Decimal(18, 4), { nullable: true });
    ol.columns.add('LoyaltyPointsEarned', sql.Int, { nullable: true });
    ol.columns.add('LoyaltyPointsSpent', sql.Int, { nullable: true });
    ol.columns.add('CalcCachedAt', sql.DateTime2(3), { nullable: true });
    ol.columns.add('CalcVersion', sql.NVarChar(20), { nullable: true });
    ol.columns.add('PaymentMethod', sql.NVarChar(40), { nullable: true });
    ol.columns.add('PaymentStatus', sql.NVarChar(30), { nullable: true });
    ol.columns.add('PaymentRef', sql.NVarChar(60), { nullable: true });
    ol.columns.add('PaidAt', sql.DateTime2(3), { nullable: true });
    for (let s = 1; s <= 6; s++) ol.columns.add(`Status${s}`, sql.NVarChar(30), { nullable: true });
    for (let s = 1; s <= 6; s++) ol.columns.add(`Status${s}At`, sql.DateTime2(3), { nullable: true });
    ol.columns.add('WarehouseID', sql.Int, { nullable: true });
    ol.columns.add('DispatchRef', sql.NVarChar(60), { nullable: true });
    ol.columns.add('DispatchedAt', sql.DateTime2(3), { nullable: true });
    ol.columns.add('TrackingNumber', sql.NVarChar(60), { nullable: true });
    ol.columns.add('OrderedAt', sql.DateTime2(3), { nullable: true });
    ol.columns.add('CreatedAt', sql.DateTime2(3), { nullable: true });
    ol.columns.add('CreatedBy', sql.NVarChar(60), { nullable: true });
    ol.columns.add('ModifiedAt', sql.DateTime2(3), { nullable: true });
    ol.columns.add('ModifiedBy', sql.NVarChar(60), { nullable: true });
    for (const l of lines) {
      ol.rows.add(
        l.orderId, l.orderNumber, l.lineNumber, l.customerId,
        l.customerEmailSnapshot, l.customerNameSnapshot, l.customerPhoneSnapshot,
        l.customerLoyaltyTierSnapshot, l.customerCountryCode,
        l.billStreet, l.billCity, l.billZip, l.billCountry,
        l.shipStreet, l.shipCity, l.shipZip, l.shipCountry, l.shipCompany,
        l.productId, l.sku, l.productNameSnapshot, l.quantity,
        l.unitPriceNet, l.unitPriceWithVat, l.lineVatRate, l.lineDiscountPct,
        l.lineNet, l.lineVat, l.lineTotal,
        l.totalNet, l.totalVat, l.totalWithVat,
        l.shippingCost, l.shippingMethod, l.shippingVatRate,
        l.discountAmount, l.promoCodeUsed, l.promoDiscountAmount,
        l.loyaltyDiscountAmount, l.loyaltyPointsEarned, l.loyaltyPointsSpent,
        l.calcCachedAt, l.calcVersion,
        l.paymentMethod, l.paymentStatus, l.paymentRef, l.paidAt,
        l.status[0], l.status[1], l.status[2], l.status[3], l.status[4], l.status[5],
        l.statusAt[0], l.statusAt[1], l.statusAt[2], l.statusAt[3], l.statusAt[4], l.statusAt[5],
        l.warehouseId, l.dispatchRef, l.dispatchedAt, l.trackingNumber,
        l.orderedAt, l.orderedAt, 'seed', l.orderedAt, 'seed',
      );
    }
    await pool.request().bulk(ol);
    console.log(`  OrderLedger ${lines.length} (${t(started)})`);

    // --- StockMovement ---------------------------------------------------------
    started = Date.now();
    const mv = new sql.Table('dbo.StockMovement');
    mv.create = false;
    mv.columns.add('ProductID', sql.Int, { nullable: false });
    mv.columns.add('WarehouseID', sql.Int, { nullable: true });
    mv.columns.add('MovementType', sql.NVarChar(20), { nullable: true });
    mv.columns.add('Quantity', sql.Int, { nullable: true });
    mv.columns.add('QtyBefore', sql.Int, { nullable: true });
    mv.columns.add('QtyAfter', sql.Int, { nullable: true });
    mv.columns.add('OrderNumber', sql.NVarChar(20), { nullable: true });
    mv.columns.add('Note', sql.NVarChar(200), { nullable: true });
    mv.columns.add('CreatedAt', sql.DateTime2(3), { nullable: true });
    mv.columns.add('CreatedBy', sql.NVarChar(60), { nullable: true });
    for (const m of movements) {
      mv.rows.add(m.productId, m.warehouseId, m.movementType, m.quantity, m.qtyBefore, m.qtyAfter, m.orderNumber, m.note, m.createdAt, 'seed');
    }
    await pool.request().bulk(mv);
    console.log(`  StockMovement ${movements.length} (${t(started)})`);

    // --- CustomerScore ---------------------------------------------------------
    started = Date.now();
    const sc = new sql.Table('dbo.CustomerScore');
    sc.create = false;
    sc.columns.add('CustomerID', sql.Int, { nullable: false });
    sc.columns.add('Score', sql.Decimal(10, 4), { nullable: true });
    sc.columns.add('RecencyPoints', sql.Decimal(10, 4), { nullable: true });
    sc.columns.add('FrequencyPoints', sql.Decimal(10, 4), { nullable: true });
    sc.columns.add('MonetaryPoints', sql.Decimal(10, 4), { nullable: true });
    sc.columns.add('ReturnPenalty', sql.Decimal(10, 4), { nullable: true });
    sc.columns.add('ManualAdjust', sql.Decimal(10, 4), { nullable: true });
    sc.columns.add('CalculatedAt', sql.DateTime2(3), { nullable: true });
    for (const s of scores) {
      sc.rows.add(s.customerId, s.score, s.recencyPoints, s.frequencyPoints, s.monetaryPoints, s.returnPenalty, s.manualAdjust, s.calculatedAt);
    }
    await pool.request().bulk(sc);
    console.log(`  CustomerScore ${scores.length} (${t(started)})`);

    // --- Procedures ------------------------------------------------------------
    const procCount = await applyProcedures(pool);
    console.log(procCount > 0 ? `  procedures ${procCount}` : '  procedures: none yet');

    console.log(`seed complete in ${t(overall)}`);
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
