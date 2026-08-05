import { stream } from '../../seed/src/rng.js';
import { DEMO_EPOCH, HISTORY_DAYS, LEAP_DAY_ORDER_COUNT } from '../../seed/src/epoch.js';

/**
 * The whole call plan is built deterministically BEFORE anything is issued.
 *
 * That ordering is what makes a run reproducible: the plan depends only on the seeded
 * PRNG, never on how fast the server answered or which request finished first. The
 * driver then executes the plan, and concurrency cannot change what was planned.
 */

export type Lane = 'read' | 'write';

export interface PlannedCall {
  /** Procedure this exercises — used for the distribution assertions, not sent over the wire. */
  proc: string;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  /** Simulated instant, spread across the 90-day window. */
  at: Date;
  sessionId: string;
  lane: Lane;
  /** Set for the five rare branches so verify can find them. */
  rare?: string;
}

/**
 * SPEC §3: sp_GetProductAvailability and sp_SearchProducts take ~70% of all calls, and
 * the tail procedures get hundreds, not millions.
 *
 * These are shares of PLAN ENTRIES, which is not quite the same as shares of captured
 * invocations: /api/products/:id invokes both sp_GetProductDetail and
 * sp_GetProductAvailability, so each detail entry yields two capture rows. Accounting
 * for that, the captured share of availability+search lands at ~70%:
 *   (0.34 + 0.12 + 0.32) / 1.12 = 0.696
 *
 * The write shares are set by the time budget rather than by taste. Writes run in a
 * single serial lane (see the driver), so they dominate wall-clock: ~40 ms each measured.
 * sp_CalculateOrderTotal gets the largest write share because M5 must replay 2 000+
 * captured calls of it, and its sampling policy captures every call up to 3 000.
 */
const WEIGHTS: Record<string, number> = {
  sp_GetProductAvailability: 0.34,
  sp_SearchProducts: 0.32,
  sp_GetProductDetail: 0.12,
  sp_GetCartSummary: 0.07,
  sp_CalculateOrderTotal: 0.06,   // ~2 400 calls, all captured — M5's precondition
  sp_PlaceOrder: 0.045,
  sp_ApplyPromoCode: 0.0225,
  sp_ReserveStock: 0.0225,
  sp_SyncWarehouseDispatch: 0.0015,
  sp_RecalculateCustomerScore: 0.0015,
};

/** Cold, not dead — SPEC says ~4 calls in 90 days. It is the judgement case in triage. */
const PRICE_IMPORT_CALLS = 4;

const DAY_MS = 86_400_000;
const SORTS = ['popularity', 'price_asc', 'price_desc', 'newest', 'rating', 'name'];
const SEARCH_TERMS = ['Pi', 'Raspberry', 'SSD', 'klavesnice', 'RTX', 'Commodore', 'tricko', 'switch', 'NAS', ''];

export interface PlanInput {
  totalCalls: number;
  productCount: number;
  customerCount: number;
  orderCount: number;
  /** Customers whose CountryCode is SK — the Slovak VAT branch. */
  slovakCustomerIds: number[];
  /** Customers at loyalty tier >= 3 — needed for the stacked-promo branch. */
  loyalCustomerIds: number[];
  /** Products with AllowBackorder = 1 — needed for the negative-stock branch. */
  backorderProductIds: number[];
  /** Order numbers dated 29 Feb 2024 — the leap-day branch. */
  leapDayOrders: string[];
}

const at = (r: ReturnType<typeof stream>, dayIndex: number): Date =>
  new Date(DEMO_EPOCH.getTime() - (HISTORY_DAYS - dayIndex) * DAY_MS + r.int(6 * 3600_000, 22 * 3600_000));

export function buildPlan(input: PlanInput): PlannedCall[] {
  const r = stream('traffic');
  const calls: PlannedCall[] = [];
  const orderNo = (n: number): string => `${DEMO_EPOCH.getUTCFullYear()}${String(n).padStart(6, '0')}`;

  const pushSession = (day: number, kind: 'browse' | 'buy'): void => {
    const sessionId = `s${day}-${calls.length}`;
    const when = at(r, day);
    const step = (offsetMs: number): Date => new Date(when.getTime() + offsetMs);
    const product = r.int(1, input.productCount);
    const customer = r.int(1, input.customerCount);

    // browse -> cart -> promo -> order. Co-invocation inside one session is what makes
    // M2's domain-boundary evidence real rather than a guess.
    calls.push({
      proc: 'sp_SearchProducts', method: 'GET', lane: 'read', sessionId, at: step(0),
      path: `/api/products?search=${encodeURIComponent(r.pick(SEARCH_TERMS))}&sort=${r.pick(SORTS)}&page=${r.int(1, 4)}`,
    });
    calls.push({
      proc: 'sp_GetProductDetail', method: 'GET', lane: 'read', sessionId, at: step(20_000),
      path: `/api/products/${product}`,
    });
    calls.push({
      proc: 'sp_GetProductAvailability', method: 'GET', lane: 'read', sessionId, at: step(35_000),
      path: `/api/availability/${product}`,
    });

    if (kind === 'buy') {
      calls.push({
        proc: 'sp_GetCartSummary', method: 'POST', lane: 'read', sessionId, at: step(90_000),
        path: '/api/cart/summary',
        body: { items: [{ productId: product, qty: r.int(1, 3) }], customerId: customer },
      });
      calls.push({
        proc: 'sp_PlaceOrder', method: 'POST', lane: 'write', sessionId, at: step(150_000),
        path: '/api/orders',
        body: {
          customerId: customer,
          items: [{ productId: product, qty: r.int(1, 2) }, { productId: r.int(1, input.productCount), qty: 1 }],
          paymentMethod: 'Karta online',
        },
      });
    }
  };

  // --- sessions carry the narrative; loose calls fill the distribution ---------
  const sessionCount = Math.floor(input.totalCalls * 0.03);
  for (let i = 0; i < sessionCount; i++) pushSession(r.int(0, HISTORY_DAYS - 1), r.chance(0.35) ? 'buy' : 'browse');

  // Fill to EXACT per-procedure counts rather than sampling weights independently.
  // Exact counts make the distribution reproducible to the call, which is what lets
  // verify-m1 assert equality across two runs instead of a tolerance band — and they
  // stop the session mix from quietly skewing the shares.
  const alreadyPlanned = new Map<string, number>();
  for (const c of calls) alreadyPlanned.set(c.proc, (alreadyPlanned.get(c.proc) ?? 0) + 1);

  const fill: string[] = [];
  for (const [proc, weight] of Object.entries(WEIGHTS)) {
    const target = Math.round(input.totalCalls * weight);
    const deficit = Math.max(0, target - (alreadyPlanned.get(proc) ?? 0));
    for (let i = 0; i < deficit; i++) fill.push(proc);
  }

  // Deterministic Fisher-Yates over the seeded stream, so the ORDER varies but the
  // COUNTS cannot.
  for (let i = fill.length - 1; i > 0; i--) {
    const j = r.int(0, i);
    [fill[i], fill[j]] = [fill[j], fill[i]];
  }

  for (const [i, proc] of fill.entries()) {
    const day = r.int(0, HISTORY_DAYS - 1);
    const when = at(r, day);
    const sessionId = `f${day}-${i}`;

    const product = r.int(1, input.productCount);
    const customer = r.int(1, input.customerCount);
    const order = orderNo(r.int(1, input.orderCount));

    switch (proc) {
      case 'sp_GetProductAvailability':
        calls.push({ proc, method: 'GET', lane: 'read', sessionId, at: when, path: `/api/availability/${product}` });
        break;
      case 'sp_SearchProducts':
        calls.push({
          proc, method: 'GET', lane: 'read', sessionId, at: when,
          path: `/api/products?search=${encodeURIComponent(r.pick(SEARCH_TERMS))}&sort=${r.pick(SORTS)}&page=${r.int(1, 5)}`,
        });
        break;
      case 'sp_GetProductDetail':
        calls.push({ proc, method: 'GET', lane: 'read', sessionId, at: when, path: `/api/products/${product}` });
        break;
      case 'sp_GetCartSummary':
        calls.push({
          proc, method: 'POST', lane: 'read', sessionId, at: when, path: '/api/cart/summary',
          body: { items: [{ productId: product, qty: r.int(1, 4) }], customerId: customer },
        });
        break;
      case 'sp_CalculateOrderTotal':
        calls.push({
          proc, method: 'POST', lane: 'write', sessionId, at: when, path: `/api/orders/${order}/total`,
          body: r.chance(0.4) ? { promoCode: r.pick(['GEEK200', 'DOPRAVA0', 'LETO15']) } : {},
        });
        break;
      case 'sp_PlaceOrder':
        calls.push({
          proc, method: 'POST', lane: 'write', sessionId, at: when, path: '/api/orders',
          body: { customerId: customer, items: [{ productId: product, qty: r.int(1, 3) }], paymentMethod: 'Dobírka' },
        });
        break;
      case 'sp_ApplyPromoCode':
        calls.push({
          proc, method: 'POST', lane: 'write', sessionId, at: when, path: `/api/orders/${order}/promo`,
          body: { code: r.pick(['GEEK200', 'DOPRAVA0', 'TEST']), customerId: customer },
        });
        break;
      case 'sp_ReserveStock':
        calls.push({ proc, method: 'POST', lane: 'write', sessionId, at: when, path: `/api/orders/${order}/reserve` });
        break;
      case 'sp_SyncWarehouseDispatch':
        calls.push({ proc, method: 'POST', lane: 'write', sessionId, at: when, path: `/api/orders/${order}/dispatch` });
        break;
      case 'sp_RecalculateCustomerScore':
        calls.push({ proc, method: 'POST', lane: 'write', sessionId, at: when, path: `/api/customers/${customer}/score` });
        break;
    }
  }

  // --- the cold procedure: exactly four calls in ninety days -------------------
  for (let i = 0; i < PRICE_IMPORT_CALLS; i++) {
    calls.push({
      proc: 'sp_LegacyPriceImport_v2', method: 'POST', lane: 'write',
      sessionId: `import-${i}`, at: at(r, Math.floor((i + 0.5) * (HISTORY_DAYS / PRICE_IMPORT_CALLS))),
      path: '/api/price-import',
      body: { priceData: `PS-1000${i + 1}:${1500 + i * 111}.00;PS-1000${i + 2}:${900 + i * 37}.00`, batchId: `Q-${i + 1}` },
    });
  }

  calls.push(...rareBranchCalls(r, input));

  // Deterministic order: sort by simulated instant. Two runs of the same plan issue the
  // same calls in the same sequence regardless of how the driver schedules them.
  calls.sort((a, b) => a.at.getTime() - b.at.getTime() || a.sessionId.localeCompare(b.sessionId));
  return calls;
}

/**
 * The five rare branches SPEC names. They exist so branch coverage is genuinely
 * incomplete and the adversarial-input step at M4 has something to find — and so M5 has
 * captured invocations of the branch carrying the planted defect.
 */
function rareBranchCalls(r: ReturnType<typeof stream>, input: PlanInput): PlannedCall[] {
  const out: PlannedCall[] = [];
  const day = (d: number): Date => at(r, d);

  // 1. Leap day. No procedure takes a date parameter, so the leap day is carried by the
  //    ORDER being priced — orders 1..3 are pinned to 29 Feb 2024 by the seed.
  for (const order of input.leapDayOrders.slice(0, LEAP_DAY_ORDER_COUNT)) {
    out.push({
      proc: 'sp_CalculateOrderTotal', method: 'POST', lane: 'write', rare: 'leap-day',
      sessionId: `rare-leap-${order}`, at: day(12), path: `/api/orders/${order}/total`, body: {},
    });
  }

  // 2. Negative stock: order far beyond stock on a product that allows backorder.
  for (const productId of input.backorderProductIds.slice(0, 3)) {
    out.push({
      proc: 'sp_PlaceOrder', method: 'POST', lane: 'write', rare: 'negative-stock',
      sessionId: `rare-negstock-${productId}`, at: day(28), path: '/api/orders',
      body: { customerId: input.loyalCustomerIds[0] ?? 1, items: [{ productId, qty: 900 }], paymentMethod: 'Dobírka' },
    });
  }

  // 3. Slovak VAT: SK customers take the 20% path instead of 21%.
  for (const customerId of input.slovakCustomerIds.slice(0, 4)) {
    out.push({
      proc: 'sp_GetCartSummary', method: 'POST', lane: 'read', rare: 'slovak-vat',
      sessionId: `rare-sk-${customerId}`, at: day(41), path: '/api/cart/summary',
      body: { items: [{ productId: 3, qty: 2 }], customerId },
    });
    out.push({
      proc: 'sp_PlaceOrder', method: 'POST', lane: 'write', rare: 'slovak-vat',
      sessionId: `rare-sk-order-${customerId}`, at: day(42), path: '/api/orders',
      body: { customerId, items: [{ productId: 3, qty: 1 }], paymentMethod: 'Karta online', shipCountry: 'SK' },
    });
  }

  // 4. Stacked promo — VERNY20 stacks with loyalty, and this is the branch that carries
  //    the planted promo/VAT defect. M5 replays these, so there must be plenty.
  for (const customerId of input.loyalCustomerIds.slice(0, 40)) {
    const order = `${DEMO_EPOCH.getUTCFullYear()}${String(r.int(1, input.orderCount)).padStart(6, '0')}`;
    out.push({
      proc: 'sp_CalculateOrderTotal', method: 'POST', lane: 'write', rare: 'stacked-promo',
      sessionId: `rare-stack-${customerId}`, at: day(r.int(50, 88)), path: `/api/orders/${order}/total`,
      body: { promoCode: 'VERNY20' },
    });
  }

  // 5. A 40-line order.
  out.push({
    proc: 'sp_PlaceOrder', method: 'POST', lane: 'write', rare: 'forty-lines',
    sessionId: 'rare-40line', at: day(63), path: '/api/orders',
    body: {
      customerId: input.loyalCustomerIds[1] ?? 2,
      items: Array.from({ length: 40 }, (_, i) => ({ productId: i + 1, qty: 1 })),
      paymentMethod: 'Bankovní převod',
    },
  });

  return out;
}
