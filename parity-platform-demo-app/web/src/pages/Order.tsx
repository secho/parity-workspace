import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { dispatchOrder, fetchOrder, formatCzk, recalculateOrder, type OrderHead } from '../api.js';

/**
 * What the shop does after an order exists. Each button invokes exactly one stored
 * procedure — that is the point of the screen: the business logic is not here, it is
 * in the database, and this page is a thin trigger for it.
 */
export default function Order() {
  const { orderNumber } = useParams();
  const [order, setOrder] = useState<OrderHead | null>(null);
  const [lines, setLines] = useState<Record<string, unknown>[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orderNumber) return;
    try {
      const r = await fetchOrder(orderNumber);
      setOrder(r.order);
      setLines(r.lines);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [orderNumber]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(label: string, action: () => Promise<unknown>, done: string) {
    setBusy(label);
    setMessage(null);
    setError(null);
    try {
      await action();
      await load();
      setMessage(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (error && !order) return <div className="empty">Objednávku se nepodařilo načíst: {error}</div>;
  if (!order) return <div className="empty">Načítám…</div>;

  return (
    <>
      <Link to="/" className="back">
        ← Zpět na výpis
      </Link>
      <h1>Objednávka {order.orderNumber}</h1>
      <p className="lead">
        {order.customerName} · {order.customerEmail} · {order.countryCode} · sklad {order.warehouseId ?? '—'}
      </p>

      <div className="statuses">
        {order.statuses.map((s, i) => (
          <span className="chip" key={i}>
            {s}
          </span>
        ))}
      </div>

      <h2>Položky</h2>
      <table className="plain">
        <thead>
          <tr>
            <th>#</th>
            <th>Produkt</th>
            <th className="num">Počet</th>
            <th className="num">Cena bez DPH</th>
            <th className="num">DPH</th>
            <th className="num">Celkem</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={String(l.OrderLineID)}>
              <td>{String(l.LineNumber)}</td>
              <td>
                <Link to={`/produkt/${String(l.ProductID)}`}>{String(l.ProductNameSnapshot)}</Link>
                <div className="sku">{String(l.Sku)}</div>
              </td>
              <td className="num">{String(l.Quantity)}</td>
              <td className="num">{formatCzk(Number(l.LineNet))}</td>
              <td className="num">{formatCzk(Number(l.LineVat))}</td>
              <td className="num">{formatCzk(Number(l.LineTotal))}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="summary" style={{ marginTop: 20 }}>
        <div className="row">
          <span>Mezisoučet bez DPH</span>
          <span>{formatCzk(order.totalNet)}</span>
        </div>
        <div className="row">
          <span>DPH</span>
          <span>{formatCzk(order.totalVat)}</span>
        </div>
        {order.promoCodeUsed && (
          <div className="row">
            <span>
              Slevový kód <code>{order.promoCodeUsed}</code>
            </span>
            <span>−{formatCzk(order.promoDiscountAmount)}</span>
          </div>
        )}
        {order.loyaltyDiscountAmount > 0 && (
          <div className="row">
            <span>Věrnostní sleva</span>
            <span>−{formatCzk(order.loyaltyDiscountAmount)}</span>
          </div>
        )}
        <div className="row">
          <span>Doprava {order.shippingMethod ? `(${order.shippingMethod})` : ''}</span>
          <span>{formatCzk(order.shippingCost)}</span>
        </div>
        <div className="row total">
          <span>Celkem s DPH</span>
          <span>{formatCzk(order.totalWithVat)}</span>
        </div>
      </div>

      <h2>Akce</h2>
      <p className="lead">
        Každé tlačítko volá jednu uloženou proceduru. Logika není v aplikaci, je v databázi.
      </p>
      <div className="actions">
        <button
          className="buy"
          disabled={busy !== null}
          onClick={() => run('total', () => recalculateOrder(order.orderNumber), 'Cena přepočítána.')}
        >
          {busy === 'total' ? 'Počítám…' : 'Přepočítat cenu'}
          <em>sp_CalculateOrderTotal</em>
        </button>

        <button
          className="buy"
          disabled={busy !== null}
          onClick={() =>
            run('dispatch', () => dispatchOrder(order.orderNumber), 'Podklady odeslány na sklad e-mailem.')
          }
        >
          {busy === 'dispatch' ? 'Odesílám…' : 'Odeslat do skladu'}
          <em>sp_SyncWarehouseDispatch</em>
        </button>
      </div>

      {order.dispatchRef && (
        <p className="note">
          Expedice <code>{order.dispatchRef}</code>
          {order.trackingNumber ? ` · sledovací číslo ${order.trackingNumber}` : ''}
        </p>
      )}
      {message && <p className="note ok">{message}</p>}
      {error && <p className="note error">{error}</p>}
    </>
  );
}
