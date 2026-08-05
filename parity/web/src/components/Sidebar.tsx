import { NavLink } from 'react-router-dom';
import { cs } from '../copy';

/**
 * Estate · Kampaně · Fronta · Provoz. The last three are not built yet and say so —
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
        <a className="disabled">{cs.nav.campaigns}</a>
        <a className="disabled">{cs.nav.queue}</a>
        <a className="disabled">{cs.nav.ops}</a>
      </div>
    </nav>
  );
}
