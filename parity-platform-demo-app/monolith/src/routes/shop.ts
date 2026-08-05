import type { FastifyInstance } from 'fastify';
import { getPool } from '../db.js';
import { getCartSummary, getProductAvailability, getProductDetail, searchProducts } from '../procs.js';

export default async function shopRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { search?: string; categoryId?: string; page?: string; pageSize?: string; sort?: string } }>(
    '/api/products',
    async (req) => {
      const result = await searchProducts({
        search: req.query.search ?? null,
        categoryId: req.query.categoryId ? Number(req.query.categoryId) : null,
        sortMode: req.query.sort ?? null,
        pageNumber: req.query.page ? Number(req.query.page) : 1,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : 24,
      });
      return { products: result.recordset ?? [] };
    },
  );

  // Reference data, read directly. Not everything in a 2011 estate got its own procedure.
  app.get('/api/categories', async () => {
    const pool = await getPool();
    const result = await pool
      .request()
      .query('SELECT CategoryID, Code, Name, SortOrder FROM dbo.Category WHERE IsActive = 1 ORDER BY SortOrder');
    return { categories: result.recordset };
  });

  app.get<{ Params: { id: string } }>('/api/products/:id', async (req, reply) => {
    const productId = Number(req.params.id);
    if (!Number.isInteger(productId)) return reply.code(400).send({ error: 'Neplatné ID produktu' });

    try {
      const [detail, availability] = await Promise.all([
        getProductDetail(productId),
        getProductAvailability(productId),
      ]);
      const product = detail.recordset?.[0];
      if (!product) return reply.code(404).send({ error: 'Produkt nenalezen' });
      return { product, availability: availability.recordset ?? [] };
    } catch (err) {
      // sp_GetProductDetail raises rather than returning an empty set.
      if (err instanceof Error && /neexistuje/i.test(err.message)) {
        return reply.code(404).send({ error: 'Produkt nenalezen' });
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/api/availability/:id', async (req, reply) => {
    const productId = Number(req.params.id);
    if (!Number.isInteger(productId)) return reply.code(400).send({ error: 'Neplatné ID produktu' });
    const result = await getProductAvailability(productId);
    return { availability: result.recordset ?? [] };
  });

  app.post<{ Body: { items?: { productId: number; qty: number }[]; customerId?: number; promoCode?: string } }>(
    '/api/cart/summary',
    async (req, reply) => {
      const items = req.body?.items ?? [];
      if (items.length === 0) return reply.code(400).send({ error: 'Košík je prázdný' });

      // sp_GetCartSummary splits on commas; sp_PlaceOrder splits on pipes. Same idea,
      // two authors, two delimiters. Left as-is — normalising it here would hide the
      // kind of inconsistency the spec is supposed to surface.
      const cartItems = items.map((i) => `${i.productId}:${i.qty}`).join(',');
      const result = await getCartSummary({
        cartItems,
        customerId: req.body?.customerId ?? null,
        promoCode: req.body?.promoCode ?? null,
      });

      return {
        lines: result.recordsets[0] ?? [],
        summary: result.recordsets[1]?.[0] ?? null,
      };
    },
  );
}
