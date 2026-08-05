import { Route, Routes } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { Estate } from './pages/Estate';
import { Procedure } from './pages/Procedure';

export function App(): JSX.Element {
  return (
    <div className="shell">
      <Sidebar />
      <main className="main">
        <Routes>
          <Route path="/" element={<Estate />} />
          <Route path="/procedura/:name" element={<Procedure />} />
        </Routes>
      </main>
    </div>
  );
}
