import { Route, Routes } from 'react-router-dom';
import { ModelBadge } from './components/ModelBadge';
import { Sidebar } from './components/Sidebar';
import { Estate } from './pages/Estate';
import { Procedure } from './pages/Procedure';
import { Provoz } from './pages/Provoz';

export function App(): JSX.Element {
  return (
    <div className="shell">
      <Sidebar />
      <main className="main">
        <ModelBadge />
        <Routes>
          <Route path="/" element={<Estate />} />
          <Route path="/procedura/:name" element={<Procedure />} />
          <Route path="/provoz" element={<Provoz />} />
        </Routes>
      </main>
    </div>
  );
}
