import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Badge, Card, DataLabel, Empty, ErrorBox, Loading, PageHead, useApi } from '../components';
import { date, humanize, rupees, units } from '../format';
import { PaymentTimeline } from './Payments';

const PAY_LABEL: Record<string, string> = {
  paid: 'Paid',
  payment_in_progress: 'Payment in progress',
  unpaid: 'Unpaid',
  nothing_due: 'Nothing due',
  on_hold_review: 'On hold for review',
};

export function BillsPage() {
  const { data, error, loading, reload } = useApi<{ bills: any[] }>('/bills');
  const [filter, setFilter] = useState<'all' | 'electricity' | 'water'>('all');
  const bills = (data?.bills ?? []).filter((b) => filter === 'all' || b.utility === filter);
  return (
    <>
      <PageHead title="Bills" subtitle="Every bill can be reconstructed from its readings and tariff.">
        <DataLabel kind="synthetic" />
      </PageHead>
      <div className="segmented" role="group" aria-label="Filter by utility">
        {(['all', 'electricity', 'water'] as const).map((f) => (
          <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {humanize(f)}
          </button>
        ))}
      </div>
      <Card>
        {loading ? (
          <Loading what="Loading bills" />
        ) : error ? (
          <ErrorBox error={error} onRetry={reload} />
        ) : bills.length === 0 ? (
          <Empty>No bills to show.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Bill</th>
                  <th>Period</th>
                  <th>Usage</th>
                  <th className="num">Amount</th>
                  <th>Due</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {bills.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <Link to={`/bills/${b.id}`}>
                        {b.utility === 'electricity' ? '⚡' : '💧'} {b.billNumber}
                      </Link>
                      <div className="muted small">Account {b.account}</div>
                    </td>
                    <td>
                      {date(b.periodStart)} – {date(b.periodEnd)}
                      {b.readingType === 'estimated' && (
                        <div>
                          <Badge value="warning" label="estimated reading" />
                        </div>
                      )}
                    </td>
                    <td>{units(b.units, b.utility === 'electricity' ? 'kWh' : 'kL')}</td>
                    <td className="num">{rupees(b.payablePaise)}</td>
                    <td>{date(b.dueOn)}</td>
                    <td>
                      <Badge value={b.paymentStatus} label={PAY_LABEL[b.paymentStatus]} />
                      {b.calcStatus === 'needs_review' && <Badge value="needs_review" label="needs review" />}
                      {b.anomalyCodes.length > 0 && b.calcStatus !== 'needs_review' && <Badge value="info" label={`${b.anomalyCodes.length} note(s)`} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function AnomalyCard({ a }: { a: any }) {
  return (
    <article className={`anomaly sev-${a.severity}`}>
      <header>
        <Badge value={a.severity} label={a.severity === 'review' ? 'needs review' : a.severity} />
        <h3>{a.title}</h3>
      </header>
      <div className="anomaly-grid">
        <div>
          <h4>What we observed</h4>
          <ul>{a.evidence.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul>
        </div>
        <div>
          <h4>Possible explanations</h4>
          <ul>{a.explanations.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul>
        </div>
        <div>
          <h4>Safe checks</h4>
          <ul>{a.checks.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul>
        </div>
      </div>
      <p className="muted small">
        <strong>Confidence: {a.confidence}.</strong> {a.limitations}
      </p>
    </article>
  );
}

function PayPanel({ bill, onDone }: { bill: any; onDone: () => void }) {
  const { user } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: 'ok' | 'blocked' | 'error'; message: string } | null>(null);
  // One idempotency key per confirmation, so double-clicks and retries of the same request are safe.
  const keyRef = useRef<string | null>(null);

  if (user?.role === 'admin') return null;
  const status = bill.paymentStatus;
  const pay = async () => {
    keyRef.current ??= crypto.randomUUID();
    setBusy(true);
    try {
      const r = await api(`/bills/${bill.id}/payments`, { method: 'POST', body: { idempotencyKey: keyRef.current } });
      setResult({ kind: 'ok', message: `${r.replayed ? 'Already submitted' : 'Submitted'}: ${r.payment.txnRef} is ${r.payment.stateLabel.toLowerCase()}.` });
      onDone();
    } catch (e) {
      const err = e as ApiError;
      setResult({ kind: err.code === 'DUPLICATE_PAYMENT_BLOCKED' ? 'blocked' : 'error', message: err.message });
    } finally {
      setBusy(false);
      setConfirming(false);
      keyRef.current = null;
    }
  };

  return (
    <Card title="Pay this bill" actions={<DataLabel kind="simulated" />}>
      <p className="muted">
        This demo has no payment provider connected. Starting a payment creates a simulated transaction only. We never ask for OTPs, PINs, CVVs or bank passwords.
      </p>
      {status === 'paid' && <p className="alert alert-ok">This bill is paid and credited to the (simulated) utility account.</p>}
      {status === 'on_hold_review' && <p className="alert alert-warn">This bill needs review before it can be paid. You can raise a billing complaint below.</p>}
      {status === 'nothing_due' && <p className="alert alert-ok">Nothing is payable on this bill.</p>}
      {(status === 'unpaid' || status === 'payment_in_progress') && (
        <>
          {status === 'payment_in_progress' && (
            <p className="alert alert-warn">
              A payment for this bill is still unresolved. Trying again will be blocked so you are not charged twice.
            </p>
          )}
          {!confirming ? (
            <button className="btn btn-primary" onClick={() => setConfirming(true)}>
              Pay {rupees(bill.payablePaise)} (simulated)
            </button>
          ) : (
            <div className="confirm" role="alertdialog" aria-labelledby="confirm-title">
              <p id="confirm-title">
                Start a simulated payment of <strong>{rupees(bill.payablePaise)}</strong> for bill {bill.billNumber}?
              </p>
              <div className="row">
                <button className="btn btn-primary" onClick={pay} disabled={busy} autoFocus>
                  {busy ? 'Submitting…' : 'Yes, start payment'}
                </button>
                <button className="btn" onClick={() => setConfirming(false)} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {result && (
        <div className={`alert ${result.kind === 'ok' ? 'alert-ok' : result.kind === 'blocked' ? 'alert-warn' : 'alert-danger'}`} role="status">
          {result.kind === 'blocked' && <strong>Second payment blocked. </strong>}
          {result.message}
        </div>
      )}
    </Card>
  );
}

export function BillDetailPage() {
  const { id } = useParams();
  const { data, error, loading, reload } = useApi<any>(`/bills/${id}`);
  if (loading && !data) return <Loading what="Loading bill" />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const { bill, calculation: calc, readings, history, payments, statedTotalPaise } = data;
  const unit = calc.unit;

  return (
    <>
      <p>
        <Link to="/bills">← All bills</Link>
      </p>
      <PageHead
        title={`${bill.utility === 'electricity' ? 'Electricity' : 'Water'} bill ${bill.billNumber}`}
        subtitle={`${bill.provider} · Account ${bill.account} · ${date(bill.periodStart)} to ${date(bill.periodEnd)}`}
      >
        <DataLabel kind="synthetic" />
      </PageHead>

      <div className="grid">
        <Card title="Summary" className="span-2">
          <dl className="facts">
            <div>
              <dt>Amount payable</dt>
              <dd className="big-num">{calc.totals ? rupees(calc.totals.payablePaise) : 'Not calculated'}</dd>
            </div>
            <div>
              <dt>Due date</dt>
              <dd>{date(bill.dueOn)}</dd>
            </div>
            <div>
              <dt>Payment</dt>
              <dd>
                <Badge value={bill.paymentStatus} label={PAY_LABEL[bill.paymentStatus]} />
              </dd>
            </div>
            <div>
              <dt>Usage</dt>
              <dd>
                {units(calc.consumption, unit)} over {calc.periodDays} days
              </dd>
            </div>
            <div>
              <dt>Readings</dt>
              <dd>
                {readings.previous ?? '—'} → {readings.current ?? '—'} <Badge value={readings.type === 'actual' ? 'ok' : 'warning'} label={readings.type} />
              </dd>
            </div>
            <div>
              <dt>Tariff</dt>
              <dd>
                {calc.tariff.code} v{calc.tariff.version}
                <div className="muted small">{calc.tariff.source.label}</div>
              </dd>
            </div>
            {statedTotalPaise !== null && (
              <div>
                <dt>Printed total</dt>
                <dd>{rupees(statedTotalPaise)}</dd>
              </div>
            )}
          </dl>
        </Card>

        {calc.anomalies.length > 0 && (
          <Card title={`Why this bill may look different (${calc.anomalies.length})`} className="span-2">
            <p className="muted">
              These are explanations to check, not conclusions. An unusual bill alone does not prove an error, a leak, a meter fault or misconduct.
            </p>
            {calc.anomalies.map((a: any) => (
              <AnomalyCard key={a.code} a={a} />
            ))}
            <Link className="btn" to={`/complaints?bill=${bill.id}`}>
              Raise a billing complaint about this bill
            </Link>
          </Card>
        )}

        <Card title="Bill reconstruction" className="span-2">
          {calc.lineItems.length === 0 ? (
            <Empty>Charges are not reconstructed because this bill needs review (see above).</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Quantity</th>
                    <th className="num">Rate</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {calc.lineItems.map((l: any, i: number) => (
                    <tr key={i} className={`li-${l.kind}`}>
                      <td>{l.label}</td>
                      <td className="num">{l.quantity !== undefined ? units(l.quantity, unit) : ''}</td>
                      <td className="num">{l.ratePaise !== undefined ? `${rupees(l.ratePaise)}/${unit}` : ''}</td>
                      <td className="num">{rupees(l.amountPaise)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th colSpan={3}>Total payable</th>
                    <th className="num">{rupees(calc.totals.payablePaise)}</th>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          <details className="steps" open>
            <summary>Calculation steps</summary>
            <ol>
              {calc.steps.map((s: string, i: number) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </details>
        </Card>

        <PayPanel bill={bill} onDone={reload} />

        <Card title="Payments for this bill" actions={<DataLabel kind="simulated" />}>
          {payments.length === 0 ? <Empty>No payments yet.</Empty> : payments.map((p: any) => <PaymentTimeline key={p.id} p={p} />)}
        </Card>

        <Card title="Earlier bills on this account" className="span-2">
          {history.length === 0 ? (
            <Empty>No earlier bills.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Reading</th>
                    <th className="num">Usage</th>
                    <th className="num">Per day</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h: any) => {
                    const days = Math.round((Date.parse(h.periodEnd) - Date.parse(h.periodStart)) / 86400000);
                    return (
                      <tr key={h.periodEnd}>
                        <td>
                          {date(h.periodStart)} – {date(h.periodEnd)}
                        </td>
                        <td>{h.readingType}</td>
                        <td className="num">{units(h.units, unit)}</td>
                        <td className="num">{(h.units / days).toFixed(2)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small">Bill issued {date(bill.issuedOn)}.</p>
        </Card>
      </div>
    </>
  );
}
