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

export const fetchProduct = (id: number) =>
  get<{ product: Product; availability: Record<string, unknown>[] }>(`/api/products/${id}`);

export interface CartLine {
  productId: number;
  name: string;
  priceWithVat: number;
  qty: number;
}

export async function fetchCartSummary(lines: CartLine[]) {
  const res = await fetch('/api/cart/summary', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: lines.map((l) => ({ productId: l.productId, qty: l.qty })) }),
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
