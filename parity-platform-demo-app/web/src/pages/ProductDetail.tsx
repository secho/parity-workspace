import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { addToCart, fetchProduct, formatCzk, type Product } from '../api.js';

export default function ProductDetail() {
  const { id } = useParams();
  const [product, setProduct] = useState<Product | null>(null);
  const [availability, setAvailability] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    fetchProduct(Number(id))
      .then((r) => {
        setProduct(r.product);
        setAvailability(r.availability ?? []);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  if (error) return <div className="empty">Produkt se nepodařilo načíst: {error}</div>;
  if (!product) return <div className="empty">Načítám…</div>;

  const columns = availability.length > 0 ? Object.keys(availability[0]) : [];

  return (
    <>
      <Link to="/" className="back">
        ← Zpět na výpis
      </Link>
      <h1>{product.Name}</h1>
      <p className="lead">
        {product.Manufacturer} · <span style={{ fontFamily: 'ui-monospace, monospace' }}>{product.Sku}</span>
      </p>

      <div className="detail">
        <div>
          <p>{product.ShortDescription}</p>

          <h2>Dostupnost na skladech</h2>
          {availability.length === 0 ? (
            <p className="lead">Dostupnost není k dispozici.</p>
          ) : (
            <table className="plain">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c} className={typeof availability[0][c] === 'number' ? 'num' : ''}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {availability.map((row, i) => (
                  <tr key={i}>
                    {columns.map((c) => (
                      <td key={c} className={typeof row[c] === 'number' ? 'num' : ''}>
                        {String(row[c] ?? '—')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <aside className="box">
          <div className="price">{formatCzk(product.PriceWithVat)}</div>
          <div className="vat">{formatCzk(product.PriceNet)} bez DPH</div>
          <div className={product.StockQty > 0 ? 'stock in' : 'stock out'} style={{ marginBottom: 12 }}>
            {product.StockQty > 0 ? `Skladem ${product.StockQty} ks` : 'Momentálně nedostupné'}
          </div>
          <button className="buy" disabled={product.StockQty <= 0} onClick={() => addToCart(product)}>
            Do košíku
          </button>
        </aside>
      </div>
    </>
  );
}
