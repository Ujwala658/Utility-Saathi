import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api, getToken, setToken, setUnauthorizedHandler } from './api';
import { AuthContext, useAuth, User } from './auth';
import { Loading } from './components';
import { AdminPage } from './pages/Admin';
import { BillDetailPage, BillsPage } from './pages/Bills';
import { ComplaintDetailPage, ComplaintsPage } from './pages/Complaints';
import { ConsumptionPage } from './pages/Consumption';
import { LoginPage } from './pages/Login';
import { OverviewPage } from './pages/Overview';
import { PaymentsPage } from './pages/Payments';
import { PropertiesPage } from './pages/Properties';
import { ReportsPage } from './pages/Reports';
import { IncidentDetailPage, ServicePage } from './pages/Service';
import './styles.css';



const ROLE_LABEL = { tenant: 'Tenant', owner: 'Owner', admin: 'Administrator' };

function Shell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const nav = [
    { to: '/', label: 'Overview', end: true },
    { to: '/bills', label: 'Bills' },
    { to: '/payments', label: 'Payments' },
    { to: '/service', label: 'Service Reports' },
    { to: '/complaints', label: 'Complaints' },
    { to: '/consumption', label: 'Consumption & Savings' },
    { to: '/reports', label: 'Reports & Data' },
    ...(user?.role !== 'tenant' ? [{ to: '/properties', label: user?.role === 'admin' ? 'Properties' : 'My Properties' }] : []),
    ...(user?.role === 'admin' ? [{ to: '/admin', label: 'Administration' }] : []),
  ];
  return (
    <div className="shell">
      <a href="#main" className="skip">
        Skip to content
      </a>
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            <svg viewBox="0 0 32 32" width="28" height="28">
              <rect width="32" height="32" rx="8" fill="currentColor" />
              <path d="M17 5 9 18h6l-2 9 8-13h-6z" fill="#fff" />
            </svg>
          </span>
          <span>
            Utility Saathi <small>hackathon prototype</small>
          </span>
        </div>
        <button className="menu-btn" aria-expanded={open} aria-controls="sidenav" onClick={() => setOpen(!open)}>
          Menu
        </button>
        {user && (
          <div className="who">
            <span>
              {user.name} · <strong>{ROLE_LABEL[user.role]}</strong>
            </span>
            <button className="btn btn-ghost btn-small" onClick={logout}>
              Sign out
            </button>
          </div>
        )}
      </header>
      <div className="demo-banner" role="note">
        Demo build. All people, accounts, bills, payments and reports are fictional. Payments are simulated and no money moves.
      </div>
      <div className="body">
        <nav id="sidenav" className={`sidenav ${open ? 'open' : ''}`} aria-label="Main">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setOpen(false)}>
              {n.label}
            </NavLink>
          ))}
          <button className="btn btn-small nav-signout" onClick={logout}>
            Sign out ({user?.name.split(' (')[0]})
          </button>
        </nav>
        <main id="main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(!!getToken());
  const navigate = useNavigate();

  const logout = () => {
    api('/auth/logout', { method: 'POST' }).catch(() => {});
    setToken(null);
    setUser(null);
    navigate('/login');
  };
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setToken(null);
      setUser(null);
    });
    if (getToken()) {
      api<{ user: User }>('/me')
        .then((r) => setUser(r.user))
        .catch(() => setToken(null))
        .finally(() => setChecking(false));
    }
  }, []);

  if (checking) return <Loading what="Checking your session" />;
  const login = (token: string, u: User) => {
    setToken(token);
    setUser(u);
    navigate('/');
  };

  return (
    <AuthContext.Provider value={{ user, login, logout }}>
      {!user ? (
        <Routes>
          <Route path="*" element={<LoginPage />} />
        </Routes>
      ) : (
        <Shell>
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/bills" element={<BillsPage />} />
            <Route path="/bills/:id" element={<BillDetailPage />} />
            <Route path="/payments" element={<PaymentsPage />} />
            <Route path="/service" element={<ServicePage />} />
            <Route path="/service/:id" element={<IncidentDetailPage />} />
            <Route path="/complaints" element={<ComplaintsPage />} />
            <Route path="/complaints/:id" element={<ComplaintDetailPage />} />
            <Route path="/consumption" element={<ConsumptionPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/properties" element={user.role === 'tenant' ? <Navigate to="/" /> : <PropertiesPage />} />
            <Route path="/admin/*" element={user.role === 'admin' ? <AdminPage /> : <Navigate to="/" />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </Shell>
      )}
    </AuthContext.Provider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
