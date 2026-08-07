import { NavLink } from 'react-router-dom';
import { cs } from '../copy';

/**
 * Estate · Kampaně · Fronta · Provoz. What is not built yet says so and does not navigate —
 * absent is fine, simulated is not. A single faked screen would cost the credibility of
 * every real one next to it.
 *
 * Below the rule, quietly, `Režie` — the presenter's page. It is deliberately not one of the four:
 * those are what a customer is meant to look at, and a fifth item in the same weight announces
 * that the demo is choreographed before the first beat lands. Set in `--text-faint` at 10px and
 * separated by a line, it is findable by someone looking for it and unreadable from the fifth row.
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
        <NavLink to="/kampane" className={({ isActive }) => (isActive ? 'active' : '')}>
          {cs.nav.campaigns}
        </NavLink>
        <NavLink to="/fronta" className={({ isActive }) => (isActive ? 'active' : '')}>
          {cs.nav.queue}
        </NavLink>
        <NavLink to="/provoz" className={({ isActive }) => (isActive ? 'active' : '')}>
          {cs.nav.ops}
        </NavLink>
      </div>
      <div className="nav nav-backstage">
        <NavLink to="/rezie" className={({ isActive }) => (isActive ? 'active' : '')} title={cs.nav.rezieHint}>
          {cs.nav.rezie}
        </NavLink>
      </div>
    </nav>
  );
}
