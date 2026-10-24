import { FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Badge, Card, DataLabel, Empty, ErrorBox, Field, fieldErrors, Loading, PageHead, useApi } from '../components';
import { ago, dateTime, humanize } from '../format';

const CATEGORIES = [
  { value: 'power_outage', utility: 'electricity', label: 'Power outage' },
  { value: 'low_voltage', utility: 'electricity', label: 'Low voltage' },
  { value: 'water_interruption', utility: 'water', label: 'No water supply' },
  { value: 'low_pressure', utility: 'water', label: 'Low water pressure' },
  { value: 'irregular_supply', utility: 'water', label: 'Irregular supply timings' },
  { value: 'suspected_leak', utility: 'water', label: 'Suspected leak' },
];
const LOCALITIES = ['Lakeview', 'Mill Road', 'Riverside'];

function ReportForm({ onSubmitted }: { onSubmitted: () => void }) {
  const nodes = useApi<{ nodes: any[] }>('/infra-nodes');
  const [category, setCategory] = useState('power_outage');
  const [locality, setLocality] = useState('Lakeview');
  const [node, setNode] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<any>(null);
  const utility = CATEGORIES.find((c) => c.value === category)!.utility;
  const options = (nodes.data?.nodes ?? []).filter((n) => n.utility === utility && n.locality === locality);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api('/reports', { method: 'POST', body: { category, locality, infraNodeId: node || null, description: description || undefined } });
      setDone(r);
      setDescription('');
      onSubmitted();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const errs = fieldErrors(error);

  return (
    <Card title="Report a problem">
      <form onSubmit={submit} className="stack">
        <Field label="What is happening?" id="cat">
          <select id="cat" value={category} onChange={(e) => (setCategory(e.target.value), setNode(''))}>
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.utility === 'electricity' ? '⚡' : '💧'} {c.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Locality" id="loc" error={errs.locality}>
          <select id="loc" value={locality} onChange={(e) => (setLocality(e.target.value), setNode(''))}>
            {LOCALITIES.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </Field>
        <Field label="Transformer / feeder / zone (optional)" id="node" hint="Printed on the pole or on your bill. Helps us avoid grouping unrelated problems.">
          <select id="node" value={node} onChange={(e) => setNode(e.target.value)} aria-describedby="node-hint">
            <option value="">I don't know</option>
            {options.map((n) => (
              <option key={n.id} value={n.id}>
                {n.id} · {n.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Details (optional)" id="desc" hint="Please don't include phone numbers or other personal details.">
          <textarea id="desc" rows={3} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} aria-describedby="desc-hint" />
        </Field>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Sending…' : 'Submit report'}
        </button>
      </form>
      {!!error && !Object.keys(errs).length && <ErrorBox error={error} />}
      {done && (
        <div className="alert alert-ok" role="status">
          Thanks. {done.reason} <Link to={`/service/${done.incidentId}`}>View incident</Link>. It stays <strong>unverified</strong> until an authorised administrator confirms it.
        </div>
      )}
    </Card>
  );
}

function IncidentRow({ i }: { i: any }) {
  return (
    <li className="incident">
      <div>
        <Link to={`/service/${i.id}`}>
          <strong>
            {i.utility === 'electricity' ? '⚡' : '💧'} {i.ref}
          </strong>{' '}
          · {humanize(i.categoryFamily)} · {i.locality}
          {i.networkKey ? ` · ${i.networkKey}` : ''}
        </Link>
        <div className="muted small">
          {i.reportCount} community report(s) · last report {ago(i.lastReportAt)} · updated {ago(i.updatedAt)}
        </div>
        <div className="muted small">Evidence: {i.evidenceSource}</div>
      </div>
      <div className="incident-badges">
        <Badge value={i.status} label={i.statusLabel} />
        <DataLabel kind={i.verified ? 'verified' : 'unverified'} />
      </div>
    </li>
  );
}

export function ServicePage() {
  const { user } = useAuth();
  const incidents = useApi<{ incidents: any[] }>('/incidents');
  const mine = useApi<{ reports: any[] }>(user?.role === 'admin' ? null : '/reports/mine');
  const open = (incidents.data?.incidents ?? []).filter((i) => !['service_restored', 'closed'].includes(i.status));
  const past = (incidents.data?.incidents ?? []).filter((i) => ['service_restored', 'closed'].includes(i.status));
  return (
    <>
      <PageHead title="Service reports" subtitle="Power and water interruptions reported by residents, grouped into incidents.">
        <DataLabel kind="synthetic" />
      </PageHead>
      <div className="grid">
        <div className="span-2 stack">
          <Card title="Open incidents">
            <p className="muted small">
              Reports are grouped only when the utility, issue type, network location (or locality if unknown) and a 3-hour time window all match. The number of reports never
              verifies an incident. No live utility outage feed is connected, so there are no official ETAs unless an administrator adds one with a source.
            </p>
            {incidents.loading ? <Loading /> : incidents.error ? <ErrorBox error={incidents.error} /> : open.length === 0 ? <Empty>No open incidents.</Empty> : <ul className="incidents">{open.map((i) => <IncidentRow key={i.id} i={i} />)}</ul>}
          </Card>
          {past.length > 0 && (
            <Card title="Recently restored">
              <ul className="incidents">{past.map((i) => <IncidentRow key={i.id} i={i} />)}</ul>
            </Card>
          )}
        </div>
        {user?.role !== 'admin' && (
          <div className="stack">
            <ReportForm onSubmitted={() => (incidents.reload(), mine.reload())} />
            <Card title="Your reports">
              {(mine.data?.reports ?? []).length === 0 ? (
                <Empty>You have not reported anything yet.</Empty>
              ) : (
                <ul className="list">
                  {mine.data!.reports.map((r) => (
                    <li key={r.id}>
                      <Link to={`/service/${r.incident_id}`}>{r.incident_ref}</Link> <Badge value={r.status} label={r.statusLabel} />
                      <div className="muted small">
                        {humanize(r.category)} · {r.locality} · {ago(r.reported_at)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}
      </div>
    </>
  );
}

export function IncidentDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const { data, error, loading, reload } = useApi<{ incident: any }>(`/incidents/${id}`);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const i = data!.incident;
  return (
    <>
      <p>
        <Link to="/service">← Service reports</Link>
      </p>
      <PageHead title={`${i.ref}: ${humanize(i.categoryFamily)} in ${i.locality}`} subtitle={i.networkKey ? `Network: ${i.networkKey} (synthetic topology)` : 'Grouped by locality'}>
        <Badge value={i.status} label={i.statusLabel} />
        <DataLabel kind={i.verified ? 'verified' : 'unverified'} />
      </PageHead>
      <div className="grid">
        <Card title="Status" className="span-2">
          <dl className="facts">
            <div>
              <dt>Reports</dt>
              <dd>{i.reportCount}</dd>
            </div>
            <div>
              <dt>First reported</dt>
              <dd>{dateTime(i.firstReportedAt)}</dd>
            </div>
            <div>
              <dt>Last update</dt>
              <dd>{dateTime(i.updatedAt)}</dd>
            </div>
            <div>
              <dt>Evidence source</dt>
              <dd>{i.evidenceSource}</dd>
            </div>
            <div>
              <dt>Expected restoration</dt>
              <dd>{i.eta ? `${dateTime(i.eta.at)} (source: ${i.eta.source})` : 'No grounded ETA available'}</dd>
            </div>
          </dl>
          {user?.role === 'admin' && (
            <Link className="btn" to={`/admin/incidents?focus=${i.id}`}>
              Publish an update
            </Link>
          )}
        </Card>
        <Card title="Official updates">
          {i.updates.length === 0 ? (
            <Empty>No administrator update yet. This incident is based on community reports only.</Empty>
          ) : (
            <ol className="timeline">
              {i.updates.map((u: any, k: number) => (
                <li key={k}>
                  <span className="dot" aria-hidden />
                  <div>
                    <strong>{humanize(u.to_status)}</strong>
                    <div>{u.note}</div>
                    <div className="muted small">
                      {dateTime(u.created_at)} · evidence: {u.evidence_source ?? 'none given'}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Card>
        <Card title="Grouped reports" className="span-3">
          <p className="muted small">Reporter identities are never shown.</p>
          <ul className="list">
            {i.reports.map((r: any) => (
              <li key={r.id}>
                <strong>{humanize(r.category)}</strong> · {r.locality}
                {r.infra_node_id ? ` · ${r.infra_node_id}` : ''} · {dateTime(r.reported_at)}
                <div className="muted small">{r.grouping_reason}</div>
                {r.description && <div className="small">“{r.description}”</div>}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
