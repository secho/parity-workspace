import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  fetchCartSummary,
  fetchCustomers,
  formatCzk,
  placeOrder,
  readCart,
  writeCart,
  type CartLine,
  type Customer,
} from '../api.js';

const PAYMENT_METHODS = ['Karta online', 'Bankovní převod', 'Dobírka', 'Apple Pay'];

export default function Cart() {
  const navigate = useNavigate();
  const [lines, setLines] = useState<CartLine[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [promoCode, setPromoCode] = useState('');
  const [appliedPromo, setAppliedPromo] = useState('');
  const [paymentMethod, setPaymentMethod] = useState(PAYMENT_METHODS[0]);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);

  useEffect(() => {
    setLines(readCart());
    fetchCustomers()
      .then((r) => {
        setCustomers(r.customers);
        if (r.customers.length > 0) setCustomerId(r.customers[0].CustomerID);
      })
      .catch(() => setCustomers([]));
  }, []);

  useEffect(() => {
    if (lines.length === 0) {
      setSummary(null);
      return;
    }
    fetchCartSummary(lines, customerId, appliedPromo)
      .then((r) => {
        setSummary(r.summary);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [lines, customerId, appliedPromo]);

  function setQty(productId: number, qty: number) {
    const next = lines
      .map((l) => (l.productId === productId ? { ...l, qty: Math.max(0, qty) } : l))
      .filter((l) => l.qty > 0);
    setLines(next);
    writeCart(next);
  }

  async function submit() {
    if (!customerId) return;
    setPlacing(true);
    setError(null);
    try {
      const result = await placeOrder({
        customerId,
        items: lines.map((l) => ({ productId: l.productId, qty: l.qty })),
        promoCode: appliedPromo || undefined,
        paymentMethod,
      });
      const orderNumber = result.order?.OrderNumber;
      if (!orderNumber) throw new Error('Objednávka se nevytvořila');
      writeCart([]);
      navigate(`/objednavka/${orderNumber}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPlacing(false);
    }
  }

  if (lines.length === 0) {
    return (
      <>
        <h1>Košík</h1>
        <div className="empty">
          Košík je prázdný.{' '}
          <Link to="/" style={{ color: 'var(--accent)' }}>
            Zpět na výpis
          </Link>
        </div>
      </>
    );
  }

  const num = (key: string): number | null => {
    const v = summary?.[key];
    return typeof v === 'number' ? v : v == null ? null : Number(v);
  };
  const selected = customers.find((c) => c.CustomerID === customerId);

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

      <div className="checkout">
        <div className="box">
          <h2 style={{ marginTop: 0 }}>Objednávka</h2>

          {/* Shop has no login, so checkout picks an existing customer. Loyalty tier and
              country are what make the pricing branches differ, so both are shown. */}
          <label className="field">
            <span>Zákazník</span>
            <select value={customerId ?? ''} onChange={(e) => setCustomerId(Number(e.target.value))}>
              {customers.map((c) => (
                <option key={c.CustomerID} value={c.CustomerID}>
                  {c.FirstName} {c.LastName} · {c.CountryCode} · tier {c.LoyaltyTier}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Způsob platby</span>
            <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Slevový kód</span>
            <div className="promo-row">
              <input
                value={promoCode}
                onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
                placeholder="např. GEEK200"
              />
              <button type="button" onClick={() => setAppliedPromo(promoCode.trim())}>
                Použít
              </button>
            </div>
          </label>
          {appliedPromo && (
            <p className="note">
              Uplatněn kód <code>{appliedPromo}</code>
              {num('DiscountAmount') === 0 && ' — na tuto objednávku neplatí'}
            </p>
          )}
        </div>

        <div className="summary">
          <div className="row">
            <span>Mezisoučet bez DPH</span>
            <span>{formatCzk(num('NetSubtotal') ?? num('TotalNet'))}</span>
          </div>
          <div className="row">
            <span>DPH {selected?.CountryCode === 'SK' ? '20 %' : '21 %'}</span>
            <span>{formatCzk(num('VatAmount') ?? num('TotalVat'))}</span>
          </div>
          <div className="row">
            <span>Sleva</span>
            <span>{formatCzk(num('DiscountAmount'))}</span>
          </div>
          <div className="row">
            <span>Doprava</span>
            <span>{formatCzk(num('ShippingCost'))}</span>
          </div>
          <div className="row total">
            <span>Celkem s DPH</span>
            <span>{formatCzk(num('TotalWithVat'))}</span>
          </div>

          <button className="buy wide" onClick={submit} disabled={placing || !customerId}>
            {placing ? 'Odesílám…' : 'Objednat'}
          </button>
          {error && <p className="note error">Objednávku se nepodařilo vytvořit: {error}</p>}
        </div>
      </div>
    </>
  );
}
