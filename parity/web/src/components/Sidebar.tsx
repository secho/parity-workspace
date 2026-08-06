import { NavLink } from 'react-router-dom';
import { cs } from '../copy';

/**
 * Estate · Kampaně · Fronta · Provoz. What is not built yet says so and does not navigate —
 * absent is fine, simulated is not. A single faked screen would cost the credibility of
 * every real one next to it.
 */
export function Sidebar(): JSX.Element {
  return (
    <nav className="sidebar">
      <div className="brand">
        {cs.brand}
        <small>{cs.brandSub}</small>
      </div>
      <div className="nav">
        <NavLink to="/" className={({ isActive }) => (isActive ? 'active' : '')}>
          {cs.nav.estate}
        </NavLink>
        <a className="disabled later-m7">{cs.nav.campaigns}</a>
        <NavLink to="/fronta" className={({ isActive }) => (isActive ? 'active' : '')}>
          {cs.nav.queue}
        </NavLink>
        <NavLink to="/provoz" className={({ isActive }) => (isActive ? 'active' : '')}>
          {cs.nav.ops}
        </NavLink>
      </div>
    </nav>
  );
}
