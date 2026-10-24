import { FormEvent, useState } from 'react';
import { Link, NavLink, Route, Routes, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Badge, Card, DataLabel, Empty, ErrorBox, Field, Loading, PageHead, useApi } from '../components';
import { ago, dateTime, humanize, rupees } from '../format';

const LINK: Record<string, (id: string) => string> = {
  bill: (id) => `/bills/${id}`,
  payment: () => '/admin/payments',
  incident: (id) => `/admin/incidents?focus=${id}`,
  complaint: (id) => `/admin/complaints?focus=${id}`,
  source: () => '/reports',
};

function Alerts() {
  const { data, error, loading, reload } = useApi<any>('/admin/overview');
  if (loading && !data) return <Loading what="Loading alerts" />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  return (
    <div className="grid">
      <Card title="At a glance" className="span-3">
        <dl className="facts">
          <div>
            <dt>Bill exceptions</dt>
            <dd className="big-num">{data.billExceptions.length}</dd>
          </div>
          <div>
            <dt>Overdue bills</dt>
            <dd className="big-num">{data.overdueBills.length}</dd>
          </div>
          <div>
            <dt>Unresolved payments</dt>
            <dd className="big-num">{data.unresolvedPayments.length}</dd>
          </div>
          <div>
            <dt>Blocked duplicate attempts</dt>
            <dd className="big-num">{data.blockedAttempts.length}</dd>
          </div>
          <div>
            <dt>Incidents</dt>
            <dd>
              {Object.entries(data.incidentsByStatus).map(([k, v]) => (
                <div key={k} className="small">
                  {k}: {String(v)}
                </div>
              ))}
            </dd>
          </div>
          <div>
            <dt>Complaints</dt>
            <dd>
              {Object.entries(data.complaintsByStatus).map(([k, v]) => (
                <div key={k} className="small">
                  {humanize(k)}: {String(v)}
                </div>
              ))}
            </dd>
          </div>
        </dl>
      </Card>
      <Card title={`Alerts (${data.alerts.length})`} className="span-3">
        <p className="muted small">Each alert shows what triggered it, the rule, its limits and what to check. Alerts flag things to review. They are not findings of wrongdoing.</p>
        {data.alerts.length === 0 ? (
          <Empty>No alerts.</Empty>
        ) : (
          data.alerts.map((a: any) => (
            <article key={a.id} className={`anomaly sev-${a.severity}`}>
              <header>
                <Badge value={a.severity} label={a.severity === 'review' ? 'needs review' : a.severity} />
                <h3>{a.title}</h3>
                <DataLabel kind={a.dataBasis === 'real' ? 'real' : a.dataBasis === 'unverified' ? 'unverified' : 'synthetic'} />
              </header>
              <div className="anomaly-grid">
                <div>
                  <h4>Trigger</h4>
                  <p>{a.trigger}</p>
                  <ul>{a.evidence.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul>
                </div>
                <div>
                  <h4>Rule</h4>
                  <p>{a.rule}</p>
                  <h4>Limitations</h4>
                  <p>{a.limitations}</p>
                </div>
                <div>
                  <h4>What to verify</h4>
                  <ul>{a.verify.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul>
                  {a.link?.id && <Link to={LINK[a.link.type](a.link.id)}>Open →</Link>}
                </div>
              </div>
            </article>
          ))
        )}
      </Card>
      <Card title="Overdue bills" className="span-3">
        {data.overdueBills.length === 0 ? (
          <Empty>None.</Empty>
        ) : (
          <ul className="list">
            {data.overdueBills.map((b: any) => (
              <li key={b.billId}>
                <Link to={`/bills/${b.billId}`}>{b.billNumber}</Link> · account {b.account} · {rupees(b.payablePaise)} · due {b.dueOn}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function PaymentsConsole() {
  const { data, error, loading, reload } = useApi<{ payments: any[] }>('/payments');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const send = async (id: string, toState: string) => {
    const source = toState === 'credit_reconciled' ? 'simulated_utility' : 'simulated_gateway';
    try {
      const r = await api(`/admin/payments/${id}/events`, { method: 'POST', body: { toState, source, note: 'Recorded from admin console (simulated callback)' } });
      setMsg({ ok: true, text: `${r.payment.txnRef} is now ${r.payment.stateLabel}.` });
      reload();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    }
  };
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  return (
    <Card title="Payment reconciliation" actions={<DataLabel kind="simulated" />}>
      <p className="muted small">
        No real gateway or utility is connected. These buttons stand in for their callbacks. Only legal next states are offered, and the database rejects anything else.
      </p>
      {msg && <div className={`alert ${msg.ok ? 'alert-ok' : 'alert-danger'}`}>{msg.text}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Transaction</th>
              <th>Bill</th>
              <th className="num">Amount</th>
              <th>State</th>
              <th>Updated</th>
              <th>Record simulated event</th>
            </tr>
          </thead>
          <tbody>
            {data!.payments.map((p) => (
              <tr key={p.id}>
                <td>{p.txnRef}</td>
                <td>{p.billNumber}</td>
                <td className="num">{rupees(p.amountPaise)}</td>
                <td>
                  <Badge value={p.state} label={p.stateLabel} />
                </td>
                <td>{ago(p.updatedAt)}</td>
                <td>
                  <div className="row wrap">
                    {p.allowedNext.length === 0 && <span className="muted small">Final state</span>}
                    {p.allowedNext.map((s: string) => (
                      <button key={s} className={`btn btn-small ${s === 'failed' || s === 'reversed' ? 'btn-danger' : ''}`} onClick={() => send(p.id, s)}>
                        {humanize(s)}
                      </button>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const STATUSES = ['reported_unverified', 'under_investigation', 'verified_fault', 'planned_maintenance', 'restoration_in_progress', 'service_restored', 'closed'];
const NEEDS_EVIDENCE = ['verified_fault', 'planned_maintenance', 'restoration_in_progress', 'service_restored'];

function IncidentUpdater({ i, onDone }: { i: any; onDone: () => void }) {
  const [form, setForm] = useState({ status: i.status === 'reported_unverified' ? 'under_investigation' : i.status, note: '', evidenceSource: '', etaAt: '', etaSource: '' });
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState(false);
  const set = (k: keyof typeof form) => (e: any) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setOk(false);
    try {
      await api(`/admin/incidents/${i.id}`, {
        method: 'PATCH',
        body: { ...form, evidenceSource: form.evidenceSource || null, etaAt: form.etaAt ? new Date(form.etaAt).toISOString() : null, etaSource: form.etaSource || null },
      });
      setOk(true);
      onDone();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <form className="stack" onSubmit={submit}>
      <div className="row wrap">
        <Field label="New status" id={`st-${i.id}`}>
          <select id={`st-${i.id}`} value={form.status} onChange={set('status')}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`Evidence source${NEEDS_EVIDENCE.includes(form.status) ? ' (required)' : ''}`} id={`ev-${i.id}`}>
          <input id={`ev-${i.id}`} value={form.evidenceSource} onChange={set('evidenceSource')} placeholder="e.g. Field crew log #44" required={NEEDS_EVIDENCE.includes(form.status)} />
        </Field>
      </div>
      <Field label="Public note" id={`note-${i.id}`}>
        <input id={`note-${i.id}`} value={form.note} onChange={set('note')} required maxLength={500} />
      </Field>
      <div className="row wrap">
        <Field label="ETA (optional)" id={`eta-${i.id}`}>
          <input id={`eta-${i.id}`} type="datetime-local" value={form.etaAt} onChange={set('etaAt')} />
        </Field>
        <Field label="ETA source (required with ETA)" id={`etas-${i.id}`}>
          <input id={`etas-${i.id}`} value={form.etaSource} onChange={set('etaSource')} required={!!form.etaAt} />
        </Field>
      </div>
      <button className="btn btn-primary">Publish update</button>
      {ok && <div className="alert alert-ok">Update published and recorded in the audit log.</div>}
      {!!error && <ErrorBox error={error} />}
    </form>
  );
}

function IncidentsAdmin() {
  const [params] = useSearchParams();
  const focus = params.get('focus');
  const { data, error, loading, reload } = useApi<{ incidents: any[] }>('/incidents');
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  return (
    <div className="stack">
      {data!.incidents.map((i) => (
        <Card
          key={i.id}
          className={focus === i.id ? 'focus' : ''}
          title={
            <>
              {i.ref} · {humanize(i.categoryFamily)} · {i.locality}
              {i.networkKey ? ` · ${i.networkKey}` : ''}
            </>
          }
          actions={<Badge value={i.status} label={i.statusLabel} />}
        >
          <p className="muted small">
            {i.reportCount} community report(s), last {ago(i.lastReportAt)}. Evidence: {i.evidenceSource}. <Link to={`/service/${i.id}`}>View reports</Link>
          </p>
          {i.status !== 'closed' ? <IncidentUpdater i={i} onDone={reload} /> : <p className="muted">Closed.</p>}
        </Card>
      ))}
    </div>
  );
}

function ComplaintAdminRow({ c, admins, onDone, focus }: { c: any; admins: any[]; onDone: () => void; focus: boolean }) {
  const [status, setStatus] = useState(c.allowedNext[0] ?? '');
  const [assignee, setAssignee] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api(`/admin/complaints/${c.id}`, {
        method: 'PATCH',
        body: { status: status || undefined, assignedTo: assignee || undefined, note: note || undefined, resolutionNote: status === 'resolved' ? note : undefined },
      });
      setNote('');
      onDone();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <Card className={focus ? 'focus' : ''} title={<Link to={`/complaints/${c.id}`}>{`${c.ref}: ${c.subject}`}</Link>} actions={<Badge value={c.status} />}>
      <p className="muted small">
        {humanize(c.category)} · filed by {c.filedBy} {ago(c.createdAt)} · handler {c.assignedTo ?? 'none'} {c.overdue && <Badge value="warning" label="overdue" />}
      </p>
      {c.allowedNext.length > 0 && (
        <form className="row wrap" onSubmit={submit}>
          <Field label="Move to" id={`cs-${c.id}`}>
            <select id={`cs-${c.id}`} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">(no change)</option>
              {c.allowedNext.map((s: string) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Assign to" id={`ca-${c.id}`}>
            <select id={`ca-${c.id}`} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">(no change)</option>
              {admins.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={status === 'resolved' ? 'Resolution note (required)' : 'Note'} id={`cn-${c.id}`}>
            <input id={`cn-${c.id}`} value={note} onChange={(e) => setNote(e.target.value)} required={status === 'resolved'} />
          </Field>
          <button className="btn btn-primary">Save</button>
        </form>
      )}
      {!!error && <ErrorBox error={error} />}
    </Card>
  );
}

function ComplaintsAdmin() {
  const [params] = useSearchParams();
  const { data, error, loading, reload } = useApi<{ complaints: any[] }>('/complaints');
  const users = useApi<{ users: any[] }>('/admin/users');
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const admins = (users.data?.users ?? []).filter((u) => u.role === 'admin');
  return (
    <div className="stack">
      {data!.complaints.length === 0 && <Empty>No complaints.</Empty>}
      {data!.complaints.map((c) => (
        <ComplaintAdminRow key={`${c.id}-${c.status}-${c.updatedAt}`} c={c} admins={admins} onDone={reload} focus={params.get('focus') === c.id} />
      ))}
    </div>
  );
}

function AuditLog() {
  const { data, error, loading, reload } = useApi<{ events: any[] }>('/admin/audit');
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  return (
    <Card title="Audit log (append-only)">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {data!.events.map((e) => (
              <tr key={e.id}>
                <td>{dateTime(e.created_at)}</td>
                <td>{e.actor ?? 'system'}</td>
                <td>
                  <code>{e.action}</code>
                </td>
                <td>
                  {e.entity_type} <span className="muted small">{e.entity_id}</span>
                </td>
                <td className="small">
                  <code>{JSON.stringify(e.detail)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function AdminPage() {
  const { logout } = useAuth();
  const [confirm, setConfirm] = useState(false);
  const reset = async () => {
    await api('/admin/demo/reset', { method: 'POST' });
    logout();
  };
  return (
    <>
      <PageHead title="Administration" subtitle="Explainable alerts, reconciliation, incidents, complaints and audit.">
        <DataLabel kind="synthetic" />
        {confirm ? (
          <span className="row">
            <button className="btn btn-danger btn-small" onClick={reset}>
              Confirm: reset all demo data
            </button>
            <button className="btn btn-small" onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button className="btn btn-small" onClick={() => setConfirm(true)}>
            Reset demo data
          </button>
        )}
      </PageHead>
      <nav className="tabs" aria-label="Administration sections">
        <NavLink to="/admin" end>
          Alerts
        </NavLink>
        <NavLink to="/admin/payments">Payments</NavLink>
        <NavLink to="/admin/incidents">Incidents</NavLink>
        <NavLink to="/admin/complaints">Complaints</NavLink>
        <NavLink to="/admin/audit">Audit log</NavLink>
      </nav>
      <Routes>
        <Route index element={<Alerts />} />
        <Route path="payments" element={<PaymentsConsole />} />
        <Route path="incidents" element={<IncidentsAdmin />} />
        <Route path="complaints" element={<ComplaintsAdmin />} />
        <Route path="audit" element={<AuditLog />} />
      </Routes>
    </>
  );
}
