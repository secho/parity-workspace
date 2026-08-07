import { Route, Routes } from 'react-router-dom';
import { ModelBadge } from './components/ModelBadge';
import { Sidebar } from './components/Sidebar';
import { Estate } from './pages/Estate';
import { Kampane } from './pages/Kampane';
import Fronta from './pages/Fronta';
import { Procedure } from './pages/Procedure';
import { Provoz } from './pages/Provoz';
import { Rezie } from './pages/Rezie';

export function App(): JSX.Element {
  return (
    <div className="shell">
      <Sidebar />
      <main className="main">
        <ModelBadge />
        <Routes>
          <Route path="/" element={<Estate />} />
          <Route path="/procedura/:name" element={<Procedure />} />
          <Route path="/kampane" element={<Kampane />} />
          <Route path="/fronta" element={<Fronta />} />
          <Route path="/provoz" element={<Provoz />} />
          {/* Deliberately absent from the sidebar — see pages/Rezie.tsx. */}
          <Route path="/rezie" element={<Rezie />} />
        </Routes>
      </main>
    </div>
  );
}
