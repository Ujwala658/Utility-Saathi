import { FormEvent, useState } from 'react';
import { api } from '../api';
import { Card, DataLabel, Empty, ErrorBox, Field, Loading, PageHead, useApi } from '../components';
import { date, humanize } from '../format';

function AccessManager({ p, onChange }: { p: any; onChange: () => void }) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const grant = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api(`/properties/${p.id}/members`, { method: 'POST', body: { email } });
      setEmail('');
      onChange();
    } catch (err) {
      setError(err);
    }
  };
  const revoke = async (membershipId: string) => {
    setError(null);
    try {
      await api(`/properties/${p.id}/members/${membershipId}`, { method: 'DELETE' });
      setConfirmRevoke(null);
      onChange();
    } catch (err) {
      setError(err);
    }
  };
  const active = p.members.filter((m: any) => !m.revoked_at);
  const revoked = p.members.filter((m: any) => m.revoked_at);
  return (
    <div className="stack">
      <h3>Tenant access</h3>
      {active.length === 0 ? (
        <Empty>No tenant has access.</Empty>
      ) : (
        <ul className="list">
          {active.map((m: any) => (
            <li key={m.id} className="row spread">
              <span>
                {m.name} <span className="muted small">since {date(m.granted_at)}</span>
              </span>
              {confirmRevoke === m.id ? (
                <span className="row">
                  <button className="btn btn-danger btn-small" onClick={() => revoke(m.id)}>
                    Confirm revoke
                  </button>
                  <button className="btn btn-small" onClick={() => setConfirmRevoke(null)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button className="btn btn-small" onClick={() => setConfirmRevoke(m.id)}>
                  Revoke access
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {revoked.length > 0 && <p className="muted small">Previously revoked: {revoked.map((m: any) => `${m.name} (${date(m.revoked_at)})`).join(', ')}</p>}
      <form onSubmit={grant} className="row">
        <Field label="Share with tenant (email)" id={`grant-${p.id}`}>
          <input id={`grant-${p.id}`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="karthik.tenant@demo.utilitysaathi.in" required />
        </Field>
        <button className="btn btn-primary">Grant access</button>
      </form>
      {!!error && <ErrorBox error={error} />}
    </div>
  );
}

export function PropertiesPage() {
  const { data, error, loading, reload } = useApi<{ properties: any[] }>('/properties');
  return (
    <>
      <PageHead title="Properties" subtitle="Tenants see a property's bills and complaints only while you share it with them.">
        <DataLabel kind="synthetic" />
      </PageHead>
      {loading && !data ? (
        <Loading />
      ) : error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : data!.properties.length === 0 ? (
        <Empty>No properties.</Empty>
      ) : (
        <div className="grid">
          {data!.properties.map((p) => (
            <Card key={p.id} title={p.label}>
              <p className="muted">
                {p.addressLine}, {p.locality}, {p.city}, {p.state}
              </p>
              <ul className="list">
                {p.accounts.map((a: any) => (
                  <li key={a.id}>
                    {humanize(a.utility)} · {a.provider_name} · {a.account_number}
                  </li>
                ))}
              </ul>
              {p.canManage ? <AccessManager p={p} onChange={reload} /> : <p className="muted small">Owner: {p.ownerName}</p>}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
