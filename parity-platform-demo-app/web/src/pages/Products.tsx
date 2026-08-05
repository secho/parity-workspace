import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { addToCart, fetchCategories, fetchProducts, formatCzk, type Category, type Product } from '../api.js';

export default function Products() {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryId, setCategoryId] = useState<number | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchCategories()
      .then((r) => setCategories(r.categories))
      .catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchProducts({ categoryId })
      .then((r) => {
        setProducts(r.products);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [categoryId]);

  return (
    <>
      <h1>Produkty</h1>
      <p className="lead">Hardware a gadgety pro geeky. Skladem v Praze, Brně a Bratislavě.</p>

      <div className="filters">
        <button className={categoryId === undefined ? 'active' : ''} onClick={() => setCategoryId(undefined)}>
          Vše
        </button>
        {categories.map((c) => (
          <button
            key={c.CategoryID}
            className={categoryId === c.CategoryID ? 'active' : ''}
            onClick={() => setCategoryId(c.CategoryID)}
          >
            {c.Name}
          </button>
        ))}
      </div>

      {loading && <div className="empty">Načítám produkty…</div>}
      {error && <div className="empty">Produkty se nepodařilo načíst: {error}</div>}
      {!loading && !error && products.length === 0 && <div className="empty">Žádné produkty neodpovídají výběru.</div>}

      <div className="grid">
        {products.map((p) => (
          <div className="card" key={p.ProductID}>
            <div className="sku">{p.Sku}</div>
            <Link to={`/produkt/${p.ProductID}`} className="name">
              {p.Name}
            </Link>
            <div className={p.StockQty > 0 ? 'stock in' : 'stock out'}>
              {p.StockQty > 0 ? `Skladem ${p.StockQty} ks` : 'Momentálně nedostupné'}
            </div>
            <div className="price">{formatCzk(p.PriceWithVat)}</div>
            <button className="buy" disabled={p.StockQty <= 0} onClick={() => addToCart(p)}>
              Do košíku
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
