import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { Badge, Card, DataLabel, Empty, ErrorBox, Loading, PageHead, useApi } from '../components';
import { ago, date, rupees } from '../format';

export function OverviewPage() {
  const { user } = useAuth();
  const bills = useApi<{ bills: any[] }>('/bills');
  const payments = useApi<{ payments: any[] }>('/payments');
  const incidents = useApi<{ incidents: any[] }>('/incidents');
  const complaints = useApi<{ complaints: any[] }>('/complaints');

  if (user?.role === 'admin') {
    return (
      <>
        <PageHead title="Overview" subtitle="Administrator workspace" />
        <Card>
          <p>
            Review explainable alerts, reconcile simulated payments, publish incident updates and manage complaints in{' '}
            <Link to="/admin">Administration</Link>.
          </p>
        </Card>
      </>
    );
  }

  const latest = new Map<string, any>();
  for (const b of bills.data?.bills ?? []) {
    const key = `${b.propertyId}-${b.utility}`;
    if (!latest.has(key)) latest.set(key, b);
  }
  const unresolved = (payments.data?.payments ?? []).filter((p) => ['initiated', 'pending', 'debit_confirmed'].includes(p.state));
  const openIncidents = (incidents.data?.incidents ?? []).filter((i) => !['service_restored', 'closed'].includes(i.status));
  const openComplaints = (complaints.data?.complaints ?? []).filter((c) => !['resolved', 'closed'].includes(c.status));

  return (
    <>
      <PageHead title={`Hello, ${user?.name.split(' (')[0]}`} subtitle="Your homes at a glance">
        <DataLabel kind="synthetic" />
      </PageHead>
      <div className="grid">
        <Card title="Latest bills" className="span-2">
          {bills.loading ? (
            <Loading />
          ) : bills.error ? (
            <ErrorBox error={bills.error} onRetry={bills.reload} />
          ) : latest.size === 0 ? (
            <Empty>No bills yet. If you are a tenant, ask your owner to share the property with you.</Empty>
          ) : (
            <ul className="tiles">
              {[...latest.values()].map((b) => (
                <li key={b.id}>
                  <Link to={`/bills/${b.id}`} className="tile">
                    <span className={`utility-icon ${b.utility}`} aria-hidden>
                      {b.utility === 'electricity' ? '⚡' : '💧'}
                    </span>
                    <span className="tile-main">
                      <strong>{rupees(b.payablePaise)}</strong>
                      <small>
                        {b.utility === 'electricity' ? 'Electricity' : 'Water'} · due {date(b.dueOn)}
                      </small>
                    </span>
                    <span className="tile-badges">
                      <Badge value={b.paymentStatus} />
                      {b.anomalyCodes.some((c: string) => c !== 'TARIFF_VERSION_CHANGE') && <Badge value="warning" label="explained" />}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Payments in progress">
          {unresolved.length === 0 ? (
            <Empty>No unresolved payments.</Empty>
          ) : (
            <ul className="list">
              {unresolved.map((p) => (
                <li key={p.id}>
                  <Link to="/payments">{p.txnRef}</Link> <Badge value={p.state} label={p.stateLabel} />
                  <div className="muted small">
                    {rupees(p.amountPaise)} · bill {p.billNumber}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <DataLabel kind="simulated" />
        </Card>
        <Card title="Service interruptions near you">
          {openIncidents.length === 0 ? (
            <Empty>No open incidents.</Empty>
          ) : (
            <ul className="list">
              {openIncidents.slice(0, 4).map((i) => (
                <li key={i.id}>
                  <Link to={`/service/${i.id}`}>
                    {i.ref} · {i.locality}
                  </Link>{' '}
                  <Badge value={i.status} label={i.statusLabel} />
                  <div className="muted small">
                    {i.reportCount} report(s) · last {ago(i.lastReportAt)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Your complaints">
          {openComplaints.length === 0 ? (
            <Empty>No open complaints.</Empty>
          ) : (
            <ul className="list">
              {openComplaints.map((c) => (
                <li key={c.id}>
                  <Link to={`/complaints/${c.id}`}>{c.ref}</Link> <Badge value={c.status} />
                  <div className="muted small">{c.subject}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
