import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchCartSummary, formatCzk, readCart, writeCart, type CartLine } from '../api.js';

export default function Cart() {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLines(readCart());
  }, []);

  useEffect(() => {
    if (lines.length === 0) {
      setSummary(null);
      return;
    }
    fetchCartSummary(lines)
      .then((r) => {
        setSummary(r.summary);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [lines]);

  function setQty(productId: number, qty: number) {
    const next = lines
      .map((l) => (l.productId === productId ? { ...l, qty: Math.max(0, qty) } : l))
      .filter((l) => l.qty > 0);
    setLines(next);
    writeCart(next);
  }

  if (lines.length === 0) {
    return (
      <>
        <h1>Košík</h1>
        <div className="empty">
          Košík je prázdný. <Link to="/" style={{ color: 'var(--accent)' }}>Zpět na výpis</Link>
        </div>
      </>
    );
  }

  const localTotal = lines.reduce((sum, l) => sum + l.priceWithVat * l.qty, 0);
  const num = (key: string): number | null => {
    const v = summary?.[key];
    return typeof v === 'number' ? v : v == null ? null : Number(v);
  };

  return (
    <>
      <h1>Košík</h1>
      <p className="lead">{lines.length} položek v košíku.</p>

      <table className="plain">
        <thead>
          <tr>
            <th>Produkt</th>
            <th className="num">Cena s DPH</th>
            <th className="num">Počet</th>
            <th className="num">Celkem</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.productId}>
              <td>
                <Link to={`/produkt/${l.productId}`}>{l.name}</Link>
              </td>
              <td className="num">{formatCzk(l.priceWithVat)}</td>
              <td className="num">
                <input
                  className="qty"
                  type="number"
                  min={0}
                  value={l.qty}
                  onChange={(e) => setQty(l.productId, Number(e.target.value))}
                />
              </td>
              <td className="num">{formatCzk(l.priceWithVat * l.qty)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {error && <p className="lead" style={{ marginTop: 16 }}>Souhrn košíku se nepodařilo načíst: {error}</p>}

      <div className="summary" style={{ marginTop: 20 }}>
        <div className="row">
          <span>Mezisoučet bez DPH</span>
          <span>{formatCzk(num('TotalNet'))}</span>
        </div>
        <div className="row">
          <span>DPH</span>
          <span>{formatCzk(num('TotalVat'))}</span>
        </div>
        <div className="row">
          <span>Doprava</span>
          <span>{formatCzk(num('ShippingCost'))}</span>
        </div>
        <div className="row total">
          <span>Celkem s DPH</span>
          <span>{formatCzk(num('TotalWithVat') ?? localTotal)}</span>
        </div>
      </div>
    </>
  );
}
