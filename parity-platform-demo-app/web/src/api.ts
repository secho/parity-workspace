export interface Product {
  ProductID: number;
  Sku: string;
  Name: string;
  ShortDescription: string | null;
  CategoryID: number;
  Manufacturer: string | null;
  PriceNet: number;
  PriceWithVat: number;
  StockQty: number;
  SeoSlug: string | null;
}

export interface Category {
  CategoryID: number;
  Code: string;
  Name: string;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchProducts = (params: { categoryId?: number; search?: string; page?: number }) => {
  const q = new URLSearchParams();
  if (params.categoryId) q.set('categoryId', String(params.categoryId));
  if (params.search) q.set('search', params.search);
  if (params.page) q.set('page', String(params.page));
  return get<{ products: Product[] }>(`/api/products?${q}`);
};

export const fetchCategories = () => get<{ categories: Category[] }>('/api/categories');

export interface Customer {
  CustomerID: number;
  FirstName: string;
  LastName: string;
  Email: string;
  City: string | null;
  CountryCode: string;
  LoyaltyTier: number;
}

export const fetchCustomers = () => get<{ customers: Customer[] }>('/api/customers');

export interface OrderHead {
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  countryCode: string;
  totalNet: number;
  totalVat: number;
  totalWithVat: number;
  shippingCost: number;
  shippingMethod: string | null;
  discountAmount: number;
  promoCodeUsed: string | null;
  promoDiscountAmount: number;
  loyaltyDiscountAmount: number;
  paymentMethod: string | null;
  paymentStatus: string | null;
  warehouseId: number | null;
  reservationId: number | null;
  dispatchRef: string | null;
  trackingNumber: string | null;
  orderedAt: string;
  statuses: string[];
}

export const fetchOrder = (orderNumber: string) =>
  get<{ order: OrderHead; lines: Record<string, unknown>[] }>(`/api/orders/${orderNumber}`);

async function post<T>(path: string, body?: unknown): Promise<T> {
  // Only declare a JSON content-type when there actually is a body — Fastify rejects
  // an empty body that claims to be JSON, and several of these actions take no payload.
  const res = await fetch(path, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const detail = await res.text();
    let message = `${res.status}`;
    try {
      message = (JSON.parse(detail) as { message?: string; error?: string }).message ?? message;
    } catch {
      /* keep the status */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

/** sp_PlaceOrder — orchestrates pricing, promo and stock reservation. */
export const placeOrder = (body: {
  customerId: number;
  items: { productId: number; qty: number }[];
  promoCode?: string;
  paymentMethod?: string;
}) => post<{ order: { OrderNumber: string; OrderID: number } | null }>('/api/orders', body);

/** sp_CalculateOrderTotal — recomputes and re-caches the order total. */
export const recalculateOrder = (orderNumber: string, promoCode?: string) =>
  post<{ total: unknown }>(`/api/orders/${orderNumber}/total`, { promoCode });

/** sp_SyncWarehouseDispatch — really sends mail to the warehouse. */
export const dispatchOrder = (orderNumber: string) =>
  post<{ dispatch: unknown }>(`/api/orders/${orderNumber}/dispatch`);

export const fetchProduct = (id: number) =>
  get<{ product: Product; availability: Record<string, unknown>[] }>(`/api/products/${id}`);

export interface CartLine {
  productId: number;
  name: string;
  priceWithVat: number;
  qty: number;
}

export async function fetchCartSummary(lines: CartLine[], customerId?: number | null, promoCode?: string | null) {
  const res = await fetch('/api/cart/summary', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      items: lines.map((l) => ({ productId: l.productId, qty: l.qty })),
      customerId: customerId ?? undefined,
      promoCode: promoCode || undefined,
    }),
  });
  if (!res.ok) throw new Error(`/api/cart/summary → ${res.status}`);
  return res.json() as Promise<{ lines: Record<string, unknown>[]; summary: Record<string, unknown> | null }>;
}

// --- cart, kept in localStorage ---------------------------------------------
const CART_KEY = 'parityshop.kosik';

export function readCart(): CartLine[] {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY) ?? '[]') as CartLine[];
  } catch {
    return [];
  }
}

export function writeCart(lines: CartLine[]): void {
  localStorage.setItem(CART_KEY, JSON.stringify(lines));
}

export function addToCart(product: Product): void {
  const cart = readCart();
  const existing = cart.find((l) => l.productId === product.ProductID);
  if (existing) existing.qty += 1;
  else
    cart.push({
      productId: product.ProductID,
      name: product.Name,
      priceWithVat: product.PriceWithVat,
      qty: 1,
    });
  writeCart(cart);
}

export const formatCzk = (value: number | null | undefined): string =>
  value == null ? '—' : `${new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 }).format(value)} Kč`;
