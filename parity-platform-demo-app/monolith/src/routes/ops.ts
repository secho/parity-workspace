import type { FastifyInstance } from 'fastify';
import {
  applyPromoCode,
  calculateOrderTotal,
  legacyPriceImport,
  placeOrder,
  recalculateCustomerScore,
  reserveStock,
  syncWarehouseDispatch,
} from '../procs.js';

/**
 * The write side of the estate. M1's traffic generator drives these over HTTP to build
 * 90 days of invocation history, so every live procedure needs exactly one endpoint.
 */
export default async function opsRoutes(app: FastifyInstance): Promise<void> {
  app.post<{
    Body: {
      customerId: number;
      items: { productId: number; qty: number }[];
      promoCode?: string;
      paymentMethod?: string;
      shipStreet?: string;
      shipCity?: string;
      shipZip?: string;
      shipCountry?: string;
    };
  }>('/api/orders', async (req, reply) => {
    const { customerId, items } = req.body ?? {};
    if (!customerId || !items?.length) return reply.code(400).send({ error: 'Chybí zákazník nebo položky' });

    const result = await placeOrder({
      customerId,
      linesRaw: items.map((i) => `${i.productId}:${i.qty}`).join('|'),
      promoCode: req.body.promoCode ?? null,
      paymentMethod: req.body.paymentMethod,
      shipStreet: req.body.shipStreet ?? null,
      shipCity: req.body.shipCity ?? null,
      shipZip: req.body.shipZip ?? null,
      shipCountry: req.body.shipCountry ?? null,
    });

    return reply.code(201).send({ order: result.recordset?.[0] ?? null });
  });

  app.post<{ Params: { orderNumber: string }; Body: { promoCode?: string } }>(
    '/api/orders/:orderNumber/total',
    async (req) => {
      const result = await calculateOrderTotal({
        orderNumber: req.params.orderNumber,
        promoCode: req.body?.promoCode ?? null,
      });
      return { total: result.recordset?.[0] ?? null };
    },
  );

  app.post<{ Params: { orderNumber: string } }>('/api/orders/:orderNumber/reserve', async (req) => {
    const result = await reserveStock(req.params.orderNumber);
    return { reservation: result.recordset?.[0] ?? null };
  });

  app.post<{ Params: { orderNumber: string }; Body: { code: string; customerId: number } }>(
    '/api/orders/:orderNumber/promo',
    async (req, reply) => {
      const { code, customerId } = req.body ?? {};
      if (!code || !customerId) return reply.code(400).send({ error: 'Chybí kód nebo zákazník' });
      const result = await applyPromoCode({ orderNumber: req.params.orderNumber, code, customerId });
      return { promo: result.recordset?.[0] ?? null };
    },
  );

  // Sends a real email to the warehouse. Genuinely external, genuinely not rollback-able.
  app.post<{ Params: { orderNumber: string } }>('/api/orders/:orderNumber/dispatch', async (req) => {
    const result = await syncWarehouseDispatch({ orderNumber: req.params.orderNumber });
    return { dispatch: result.recordset?.[0] ?? null };
  });

  app.post<{ Params: { id: string } }>('/api/customers/:id/score', async (req, reply) => {
    const customerId = Number(req.params.id);
    if (!Number.isInteger(customerId)) return reply.code(400).send({ error: 'Neplatné ID zákazníka' });
    const result = await recalculateCustomerScore(customerId);
    return { score: result.recordset?.[0] ?? null };
  });

  app.post<{ Body: { priceData: string; batchId?: string } }>('/api/price-import', async (req, reply) => {
    if (!req.body?.priceData) return reply.code(400).send({ error: 'Chybí data importu' });
    const result = await legacyPriceImport({
      priceData: req.body.priceData,
      batchId: req.body.batchId ?? `BATCH-${Date.now()}`,
    });
    return { imported: result.recordset?.[0] ?? null, rowsAffected: result.rowsAffected };
  });
}
