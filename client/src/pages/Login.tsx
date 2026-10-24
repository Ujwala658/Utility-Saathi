import { FormEvent, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth, User } from '../auth';
import { ErrorBox, Field } from '../components';

interface DemoAccount {
  email: string;
  name: string;
  role: User['role'];
}

const ROLE_HINT: Record<User['role'], string> = {
  tenant: 'Sees only the homes an owner has shared',
  owner: 'Manages properties and tenant access',
  admin: 'Reviews alerts, incidents and complaints',
};

export function LoginPage() {
  const { login } = useAuth();
  const [accounts, setAccounts] = useState<DemoAccount[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ accounts: DemoAccount[] }>('/demo-accounts').then((r) => setAccounts(r.accounts)).catch(setError);
  }, []);

  const signIn = async (e: string, p: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string; user: User }>('/auth/login', { method: 'POST', body: { email: e, password: p } });
      login(r.token, r.user);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    signIn(email, password);
  };

  return (
    <div className="login">
      <div className="login-intro">
        <div className="brand big">
          <svg viewBox="0 0 32 32" width="44" height="44" aria-hidden>
            <rect width="32" height="32" rx="8" fill="currentColor" />
            <path d="M17 5 9 18h6l-2 9 8-13h-6z" fill="#fff" />
          </svg>
          <span>Utility Saathi</span>
        </div>
        <p className="lead">Electricity and water bills, payments, outages and complaints in one place. Every number is explained.</p>
        <ul className="ticks">
          <li>See how each bill is calculated, step by step</li>
          <li>Blocks a second payment while the first one is still unresolved</li>
          <li>Outage reports are grouped, but only an administrator can mark them verified</li>
        </ul>
        <p className="muted small">Hackathon prototype. Not endorsed by any utility or government body.</p>
      </div>
      <div className="card login-card">
        <h1>Sign in</h1>
        <p className="muted">These accounts are fictional and exist only for the demo. They all use the password <code>demo1234</code>.</p>
        <ul className="demo-accounts" aria-label="Demo accounts">
          {accounts.map((a) => (
            <li key={a.email}>
            <button className="demo-account" disabled={busy} onClick={() => signIn(a.email, 'demo1234')}>
              <span className={`role-chip role-${a.role}`}>{a.role}</span>
              <span>
                <strong>{a.name}</strong>
                <small>{ROLE_HINT[a.role]}</small>
              </span>
            </button>
            </li>
          ))}
        </ul>
        <details>
          <summary>Sign in with email</summary>
          <form onSubmit={onSubmit} className="stack">
            <Field label="Email" id="email">
              <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </Field>
            <Field label="Password" id="password">
              <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <button className="btn btn-primary" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </details>
        {!!error && <ErrorBox error={error} />}
      </div>
    </div>
  );
}
