import { Link, Route, Routes } from 'react-router-dom';
import Products from './pages/Products.js';
import ProductDetail from './pages/ProductDetail.js';
import Cart from './pages/Cart.js';
import Order from './pages/Order.js';

export default function App() {
  return (
    <>
      <header className="top">
        <Link to="/" className="brand">
          Parity<span>Shop</span>
        </Link>
        <nav>
          <Link to="/">Produkty</Link>
          <Link to="/kosik">Košík</Link>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Products />} />
          <Route path="/produkt/:id" element={<ProductDetail />} />
          <Route path="/kosik" element={<Cart />} />
          <Route path="/objednavka/:orderNumber" element={<Order />} />
        </Routes>
      </main>
    </>
  );
}
