import { stream } from './rng.js';
import { DEMO_EPOCH, ORDER_HISTORY_DAYS, daysBefore } from './epoch.js';
import type { Product } from './catalog.js';
import type { Customer } from './customers.js';

export interface OrderLine {
  orderId: number;
  orderNumber: string;
  lineNumber: number;
  customerId: number;
  customerEmailSnapshot: string;
  customerNameSnapshot: string;
  customerPhoneSnapshot: string;
  customerLoyaltyTierSnapshot: number;
  customerCountryCode: string;
  billStreet: string | null;
  billCity: string | null;
  billZip: string | null;
  billCountry: string;
  shipStreet: string | null;
  shipCity: string | null;
  shipZip: string | null;
  shipCountry: string;
  shipCompany: string | null;
  productId: number;
  sku: string;
  productNameSnapshot: string;
  quantity: number;
  unitPriceNet: number;
  unitPriceWithVat: number;
  lineVatRate: number;
  lineDiscountPct: number;
  lineNet: number;
  lineVat: number;
  lineTotal: number;
  totalNet: number;
  totalVat: number;
  totalWithVat: number;
  shippingCost: number;
  shippingMethod: string;
  shippingVatRate: number;
  discountAmount: number;
  promoCodeUsed: string | null;
  promoDiscountAmount: number;
  loyaltyDiscountAmount: number;
  loyaltyPointsEarned: number;
  loyaltyPointsSpent: number;
  calcCachedAt: Date;
  calcVersion: string;
  paymentMethod: string;
  paymentStatus: string;
  paymentRef: string;
  paidAt: Date | null;
  status: (string | null)[];
  statusAt: (Date | null)[];
  warehouseId: number;
  dispatchRef: string | null;
  dispatchedAt: Date | null;
  trackingNumber: string | null;
  orderedAt: Date;
}

export interface StockMovementRow {
  productId: number;
  warehouseId: number;
  movementType: string;
  quantity: number;
  qtyBefore: number;
  qtyAfter: number;
  orderNumber: string;
  note: string;
  createdAt: Date;
}

export interface ScoreRow {
  customerId: number;
  score: number;
  recencyPoints: number;
  frequencyPoints: number;
  monetaryPoints: number;
  returnPenalty: number;
  manualAdjust: number;
  calculatedAt: Date;
}

const SHIPPING = [
  { method: 'Zásilkovna', cost: 79 },
  { method: 'PPL', cost: 119 },
  { method: 'Česká pošta', cost: 99 },
  { method: 'Osobní odběr Praha', cost: 0 },
  { method: 'DPD', cost: 129 },
] as const;

const PAYMENTS = ['Karta online', 'Bankovní převod', 'Dobírka', 'Apple Pay', 'Google Pay'] as const;

const STATUS_FLOW = ['Nová', 'Zaplacená', 'Rezervovaná', 'Expedovaná', 'Doručená', 'Uzavřená'] as const;

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface CustomerAggregate {
  totalSpent: number;
  orderCount: number;
  lastOrderAt: Date | null;
}

export interface OrderBuild {
  lines: OrderLine[];
  movements: StockMovementRow[];
  scores: ScoreRow[];
  /** Per-customer rollups, so Customer.TotalSpent agrees with OrderLedger. */
  aggregates: Map<number, CustomerAggregate>;
}

export function buildOrders(products: Product[], customers: Customer[], orderCount = 5000): OrderBuild {
  const r = stream('orders');
  const lines: OrderLine[] = [];
  const movements: StockMovementRow[] = [];

  // Running stock per product so StockMovement's before/after are internally consistent.
  const stockCursor = new Map<number, number>();
  for (const p of products) stockCursor.set(p.productId, p.stockQty + 2000);

  const spendByCustomer = new Map<number, number>();
  const ordersByCustomer = new Map<number, number>();
  const lastOrderAt = new Map<number, Date>();

  for (let orderId = 1; orderId <= orderCount; orderId++) {
    // Customers are not uniform: a minority place most of the orders. That skew is what
    // makes sp_RecalculateCustomerScore's recency/frequency terms mean anything.
    const customer = customers[r.zipf(customers.length, 1.25)];
    const orderedAt = daysBefore(r.int(1, ORDER_HISTORY_DAYS), r.int(0, 86_399_000));

    // Mostly small baskets, a long tail of larger ones.
    const lineCount = r.chance(0.03) ? r.int(9, 16) : r.chance(0.25) ? r.int(4, 8) : r.int(1, 3);

    const vatRate = customer.countryCode === 'SK' ? 20 : 21;
    const ship = r.pick(SHIPPING);
    const orderNumber = `${DEMO_EPOCH.getUTCFullYear()}${String(orderId).padStart(6, '0')}`;

    // Build the lines first so the order totals can be derived from them.
    const draft: { product: Product; qty: number; discountPct: number }[] = [];
    const usedProducts = new Set<number>();
    for (let i = 0; i < lineCount; i++) {
      const product = products[r.zipf(products.length, 1.35)];
      if (usedProducts.has(product.productId)) continue;
      usedProducts.add(product.productId);
      draft.push({
        product,
        qty: r.chance(0.82) ? 1 : r.int(2, 5),
        discountPct: r.chance(0.18) ? r.pick([5, 10, 15, 20]) : 0,
      });
    }
    if (draft.length === 0) {
      draft.push({ product: products[r.zipf(products.length, 1.35)], qty: 1, discountPct: 0 });
    }

    let totalNet = 0;
    let totalVat = 0;
    for (const d of draft) {
      const gross = d.product.priceNet * d.qty;
      const lineNet = round2(gross * (1 - d.discountPct / 100));
      totalNet = round2(totalNet + lineNet);
      totalVat = round2(totalVat + round2((lineNet * vatRate) / 100));
    }

    // Promo. Kept modest and consistent so the seeded history satisfies the total
    // identity invariant M4 proposes for sp_CalculateOrderTotal.
    const hasPromo = r.chance(0.22);
    const promoCode = hasPromo ? r.pick(['JARO10', 'LETO15', 'GEEK200', 'VERNY20', 'RPI5', 'DOPRAVA0', 'SK10']) : null;
    const promoDiscount = hasPromo ? round2(Math.min(totalNet * 0.15, r.float(50, 900, 2))) : 0;
    const loyaltyDiscount = customer.loyaltyTier >= 3 && r.chance(0.35) ? round2(totalNet * 0.02) : 0;
    const discountAmount = round2(promoDiscount + loyaltyDiscount);
    const shippingCost = totalNet > 2500 ? 0 : ship.cost;
    const totalWithVat = round2(totalNet + totalVat + shippingCost - discountAmount);

    // Status history. Older orders have progressed further.
    const ageDays = (DEMO_EPOCH.getTime() - orderedAt.getTime()) / 86_400_000;
    const reached = ageDays > 14 ? 6 : ageDays > 7 ? 5 : ageDays > 3 ? r.int(3, 5) : r.int(1, 3);
    const status: (string | null)[] = [null, null, null, null, null, null];
    const statusAt: (Date | null)[] = [null, null, null, null, null, null];
    for (let s = 0; s < reached; s++) {
      status[s] = STATUS_FLOW[s];
      statusAt[s] = new Date(orderedAt.getTime() + s * r.int(3_600_000, 36_000_000));
    }

    const warehouseId = customer.countryCode === 'SK' ? 3 : r.chance(0.6) ? 1 : 2;
    const dispatched = reached >= 4;
    const paid = reached >= 2;

    spendByCustomer.set(customer.customerId, round2((spendByCustomer.get(customer.customerId) ?? 0) + totalWithVat));
    ordersByCustomer.set(customer.customerId, (ordersByCustomer.get(customer.customerId) ?? 0) + 1);
    const prevLast = lastOrderAt.get(customer.customerId);
    if (!prevLast || orderedAt > prevLast) lastOrderAt.set(customer.customerId, orderedAt);

    draft.forEach((d, idx) => {
      const gross = d.product.priceNet * d.qty;
      const lineNet = round2(gross * (1 - d.discountPct / 100));
      const lineVat = round2((lineNet * vatRate) / 100);

      lines.push({
        orderId,
        orderNumber,
        lineNumber: idx + 1,
        customerId: customer.customerId,
        customerEmailSnapshot: customer.email,
        customerNameSnapshot: `${customer.firstName} ${customer.lastName}`,
        customerPhoneSnapshot: customer.phone,
        customerLoyaltyTierSnapshot: customer.loyaltyTier,
        customerCountryCode: customer.countryCode,
        billStreet: customer.street,
        billCity: customer.city,
        billZip: customer.zip,
        billCountry: customer.countryCode,
        shipStreet: customer.street,
        shipCity: customer.city,
        shipZip: customer.zip,
        shipCountry: customer.countryCode,
        shipCompany: customer.companyName,
        productId: d.product.productId,
        sku: d.product.sku,
        productNameSnapshot: d.product.name,
        quantity: d.qty,
        unitPriceNet: d.product.priceNet,
        unitPriceWithVat: round2(d.product.priceNet * (1 + vatRate / 100)),
        lineVatRate: vatRate,
        lineDiscountPct: d.discountPct,
        lineNet,
        lineVat,
        lineTotal: round2(lineNet + lineVat),
        totalNet,
        totalVat,
        totalWithVat,
        shippingCost,
        shippingMethod: ship.method,
        shippingVatRate: vatRate,
        discountAmount,
        promoCodeUsed: promoCode,
        promoDiscountAmount: promoDiscount,
        loyaltyDiscountAmount: loyaltyDiscount,
        loyaltyPointsEarned: Math.floor(totalWithVat / 100),
        loyaltyPointsSpent: 0,
        calcCachedAt: new Date(orderedAt.getTime() + 1500),
        calcVersion: 'v3',
        paymentMethod: r.pick(PAYMENTS),
        paymentStatus: paid ? 'Zaplaceno' : 'Čeká na platbu',
        paymentRef: `PMT${orderId}${idx}`,
        paidAt: paid ? new Date(orderedAt.getTime() + r.int(60_000, 7_200_000)) : null,
        status,
        statusAt,
        warehouseId,
        dispatchRef: dispatched ? `DISP-${orderNumber}` : null,
        dispatchedAt: dispatched ? statusAt[3] : null,
        trackingNumber: dispatched ? `CZ${r.int(100000000, 999999999)}` : null,
        orderedAt,
      });

      const before = stockCursor.get(d.product.productId) ?? 0;
      const after = before - d.qty;
      stockCursor.set(d.product.productId, after);
      movements.push({
        productId: d.product.productId,
        warehouseId,
        movementType: 'OUT',
        quantity: -d.qty,
        qtyBefore: before,
        qtyAfter: after,
        orderNumber,
        note: `Výdej k objednávce ${orderNumber}`,
        createdAt: new Date(orderedAt.getTime() + 900_000),
      });
    });
  }

  // Scores derived from the history just generated, so they are internally consistent.
  const rs = stream('scores');
  const scores: ScoreRow[] = customers.map((c) => {
    const spent = spendByCustomer.get(c.customerId) ?? 0;
    const count = ordersByCustomer.get(c.customerId) ?? 0;
    const last = lastOrderAt.get(c.customerId);
    const recencyDays = last ? (DEMO_EPOCH.getTime() - last.getTime()) / 86_400_000 : 999;
    const recencyPoints = round2(Math.max(0, 100 - recencyDays / 3));
    const frequencyPoints = round2(Math.min(100, count * 7));
    const monetaryPoints = round2(Math.min(100, spent / 900));
    const returnPenalty = rs.chance(0.15) ? rs.float(1, 18, 2) : 0;
    const manualAdjust = rs.chance(0.05) ? rs.float(-10, 15, 2) : 0;
    return {
      customerId: c.customerId,
      score: round2(recencyPoints * 0.3 + frequencyPoints * 0.4 + monetaryPoints * 0.3 - returnPenalty + manualAdjust),
      recencyPoints,
      frequencyPoints,
      monetaryPoints,
      returnPenalty,
      manualAdjust,
      calculatedAt: daysBefore(rs.int(1, 30)),
    };
  });

  const aggregates = new Map<number, CustomerAggregate>();
  for (const c of customers) {
    aggregates.set(c.customerId, {
      totalSpent: spendByCustomer.get(c.customerId) ?? 0,
      orderCount: ordersByCustomer.get(c.customerId) ?? 0,
      lastOrderAt: lastOrderAt.get(c.customerId) ?? null,
    });
  }

  return { lines, movements, scores, aggregates };
}
