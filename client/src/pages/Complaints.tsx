import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Badge, Card, DataLabel, Empty, ErrorBox, Field, fieldErrors, Loading, PageHead, useApi } from '../components';
import { ago, dateTime, humanize } from '../format';

const CATEGORIES = ['billing', 'meter', 'payment', 'power', 'water', 'other'];

function NewComplaint() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const props = useApi<{ properties: any[] }>('/properties');
  const bills = useApi<{ bills: any[] }>('/bills');
  const [form, setForm] = useState({ category: params.get('bill') ? 'billing' : 'other', subject: '', description: '', propertyId: '', billId: params.get('bill') ?? '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!form.propertyId && props.data?.properties[0]) setForm((f) => ({ ...f, propertyId: props.data!.properties[0].id }));
  }, [props.data]);
  const set = (k: keyof typeof form) => (e: any) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api('/complaints', { method: 'POST', body: { ...form, billId: form.billId || null, propertyId: form.propertyId || null } });
      navigate(`/complaints/${r.complaint.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const errs = fieldErrors(error);
  return (
    <Card title="Register a complaint">
      <form className="stack" onSubmit={submit}>
        <Field label="Category" id="c-cat" error={errs.category}>
          <select id="c-cat" value={form.category} onChange={set('category')}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {humanize(c)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Property" id="c-prop">
          <select id="c-prop" value={form.propertyId} onChange={set('propertyId')}>
            {(props.data?.properties ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}, {p.locality}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Related bill (optional)" id="c-bill">
          <select id="c-bill" value={form.billId} onChange={set('billId')}>
            <option value="">None</option>
            {(bills.data?.bills ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.billNumber}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Subject" id="c-sub" error={errs.subject}>
          <input id="c-sub" value={form.subject} onChange={set('subject')} maxLength={120} required />
        </Field>
        <Field label="Describe the problem" id="c-desc" error={errs.description}>
          <textarea id="c-desc" rows={4} value={form.description} onChange={set('description')} maxLength={2000} required />
        </Field>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Submitting…' : 'Submit complaint'}
        </button>
        <p className="muted small">Complaints are tracked in Utility Saathi only. They are not sent to the utility (no authorised integration).</p>
      </form>
      {!!error && !Object.keys(errs).length && <ErrorBox error={error} />}
    </Card>
  );
}

export function ComplaintsPage() {
  const { user } = useAuth();
  const { data, error, loading, reload } = useApi<{ complaints: any[] }>('/complaints');
  return (
    <>
      <PageHead title="Complaints" subtitle="Track every complaint from submission to closure.">
        <DataLabel kind="synthetic" />
      </PageHead>
      <div className="grid">
        <Card title={user?.role === 'admin' ? 'All complaints' : 'Your complaints'} className="span-2">
          {loading ? (
            <Loading />
          ) : error ? (
            <ErrorBox error={error} onRetry={reload} />
          ) : data!.complaints.length === 0 ? (
            <Empty>No complaints yet.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>Subject</th>
                    <th>Category</th>
                    <th>Status</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {data!.complaints.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link to={`/complaints/${c.id}`}>{c.ref}</Link>
                      </td>
                      <td>{c.subject}</td>
                      <td>{humanize(c.category)}</td>
                      <td>
                        <Badge value={c.status} />
                        {c.overdue && <Badge value="warning" label="overdue" />}
                      </td>
                      <td>{ago(c.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        {user?.role !== 'admin' && <NewComplaint />}
      </div>
    </>
  );
}

const STEPS = ['submitted', 'acknowledged', 'under_review', 'resolved', 'closed'];

export function ComplaintDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const { data, error, loading, reload } = useApi<{ complaint: any }>(`/complaints/${id}`);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const c = data!.complaint;
  const reached = c.status === 'escalated' ? 2 : STEPS.indexOf(c.status);

  const comment = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api(`/complaints/${c.id}/comments`, { method: 'POST', body: { note } });
      setNote('');
      reload();
    } catch (x) {
      setErr(x);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p>
        <Link to="/complaints">← Complaints</Link>
      </p>
      <PageHead title={`${c.ref}: ${c.subject}`} subtitle={`${humanize(c.category)} · filed ${dateTime(c.createdAt)}`}>
        <Badge value={c.status} />
        {c.overdue && <Badge value="warning" label="overdue" />}
      </PageHead>
      <ol className="stepper" aria-label="Progress">
        {STEPS.map((s, i) => (
          <li key={s} className={i <= reached ? 'done' : ''} aria-current={i === reached ? 'step' : undefined}>
            {humanize(s)}
            {s === 'under_review' && c.status === 'escalated' ? ' (escalated)' : ''}
          </li>
        ))}
      </ol>
      <div className="grid">
        <Card title="Details" className="span-2">
          <p>{c.description}</p>
          <dl className="facts">
            {c.billNumber && (
              <div>
                <dt>Bill</dt>
                <dd>
                  <Link to={`/bills/${c.billId}`}>{c.billNumber}</Link>
                </dd>
              </div>
            )}
            <div>
              <dt>Filed by</dt>
              <dd>{c.filedBy}</dd>
            </div>
            <div>
              <dt>Handler</dt>
              <dd>{c.assignedTo ?? 'Not assigned yet'}</dd>
            </div>
            <div>
              <dt>Sent to utility?</dt>
              <dd>No (simulated, no authorised integration)</dd>
            </div>
          </dl>
          {c.resolutionNote && (
            <div className="alert alert-ok">
              <strong>Resolution:</strong> {c.resolutionNote}
            </div>
          )}
          {user?.role === 'admin' && (
            <Link className="btn" to={`/admin/complaints?focus=${c.id}`}>
              Manage in Administration
            </Link>
          )}
        </Card>
        <Card title="History">
          <ol className="timeline">
            {c.history.map((h: any, i: number) => (
              <li key={i}>
                <span className="dot" aria-hidden />
                <div>
                  <strong>{h.kind === 'status_change' ? `${humanize(h.from_status)} → ${humanize(h.to_status)}` : humanize(h.kind)}</strong>
                  {h.note && <div>{h.note}</div>}
                  <div className="muted small">
                    {dateTime(h.created_at)} · {h.actor}
                  </div>
                </div>
              </li>
            ))}
          </ol>
          {c.status !== 'closed' && (
            <form onSubmit={comment} className="stack">
              <Field label="Add a comment" id="note">
                <textarea id="note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} required />
              </Field>
              <button className="btn" disabled={busy}>
                Add comment
              </button>
              {!!err && <ErrorBox error={err} />}
            </form>
          )}
        </Card>
      </div>
    </>
  );
}
