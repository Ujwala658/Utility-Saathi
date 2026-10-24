import { ReactNode, useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';

/** Provenance label shown wherever data appears. */
export function DataLabel({ kind }: { kind: 'synthetic' | 'simulated' | 'real' | 'unverified' | 'verified' }) {
  const text = {
    synthetic: 'SYNTHETIC DEMO DATA',
    simulated: 'SIMULATED — NO MONEY MOVES',
    real: 'REAL / HISTORICAL',
    unverified: 'UNVERIFIED',
    verified: 'VERIFIED BY ADMIN',
  }[kind];
  return <span className={`label label-${kind}`}>{text}</span>;
}

const TONES: Record<string, string> = {
  paid: 'ok', credit_reconciled: 'ok', service_restored: 'ok', resolved: 'ok', closed: 'muted', nothing_due: 'muted', fresh: 'ok',
  unpaid: 'warn', payment_in_progress: 'info', pending: 'info', initiated: 'info', debit_confirmed: 'warn', on_hold_review: 'danger',
  failed: 'danger', reversed: 'muted', needs_review: 'danger', ok: 'ok', review: 'danger', warning: 'warn', info: 'info',
  reported_unverified: 'warn', under_investigation: 'info', verified_fault: 'danger', planned_maintenance: 'info', restoration_in_progress: 'info',
  submitted: 'info', acknowledged: 'info', under_review: 'info', escalated: 'warn', stale: 'warn', never_refreshed: 'warn', not_applicable: 'muted',
};

export function Badge({ value, label }: { value: string; label?: string }) {
  return <span className={`badge tone-${TONES[value] ?? 'muted'}`}>{label ?? value.replace(/_/g, ' ')}</span>;
}

export function Loading({ what = 'Loading' }: { what?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden /> {what}…
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof ApiError ? error.message : 'Something went wrong.';
  return (
    <div className="alert alert-danger alert-row" role="alert">
      <span>{msg}</span>
      {onRetry && (
        <button className="btn btn-small" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="state empty">{children}</div>;
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHead({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {children && <div className="page-head-actions">{children}</div>}
    </div>
  );
}

/** Fetch helper with loading/error state and a reload function. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    if (!path) return;
    setLoading(true);
    setError(null);
    api<T>(path)
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [path]);
  useEffect(load, [load]);
  return { data, error, loading, reload: load };
}

export function Field({ label, hint, error, children, id }: { label: string; hint?: string; error?: string; children: ReactNode; id: string }) {
  return (
    <div className={`field ${error ? 'has-error' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <small id={`${id}-hint`} className="muted">{hint}</small>}
      {error && (
        <small className="field-error" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}

export const fieldErrors = (e: unknown): Record<string, string> =>
  e instanceof ApiError && Array.isArray(e.details) ? Object.fromEntries(e.details.map((d: any) => [d.path, d.message])) : {};
