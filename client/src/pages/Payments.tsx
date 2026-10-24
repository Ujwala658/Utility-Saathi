import { Link } from 'react-router-dom';
import { Badge, Card, DataLabel, Empty, ErrorBox, Loading, PageHead, useApi } from '../components';
import { dateTime, humanize, rupees } from '../format';

const SOURCE_LABEL: Record<string, string> = {
  user: 'You (in Utility Saathi)',
  simulated_gateway: 'Payment gateway (simulated)',
  simulated_utility: 'Utility billing system (simulated)',
};

export function PaymentTimeline({ p }: { p: any }) {
  return (
    <article className="txn">
      <header>
        <div>
          <strong>{p.txnRef}</strong> · {rupees(p.amountPaise)}
          <div className="muted small">
            Bill <Link to={`/bills/${p.billId}`}>{p.billNumber}</Link>
          </div>
        </div>
        <Badge value={p.state} label={p.stateLabel} />
      </header>
      <ol className="timeline">
        {p.events.map((e: any, i: number) => (
          <li key={i}>
            <span className="dot" aria-hidden />
            <div>
              <strong>{humanize(e.to_state)}</strong> <span className="muted small">· {SOURCE_LABEL[e.source] ?? e.source}</span>
              <div className="muted small">
                {dateTime(e.created_at)}
                {e.note ? ` · ${e.note}` : ''}
              </div>
            </div>
          </li>
        ))}
      </ol>
      {p.state === 'debit_confirmed' && (
        <p className="alert alert-warn small">
          Your bank reports the money as debited, but the utility has not confirmed receiving it yet. Please don't pay again. This usually settles within a working day.
        </p>
      )}
      {p.receiptRef && (
        <div className="receipt">
          <strong>Simulated receipt {p.receiptRef}</strong>
          <span className="muted small">Not a real receipt. No money moved.</span>
        </div>
      )}
    </article>
  );
}

export function PaymentsPage() {
  const { data, error, loading, reload } = useApi<{ payments: any[] }>('/payments');
  return (
    <>
      <PageHead title="Payments" subtitle="Bank debit and utility credit are tracked as separate steps.">
        <DataLabel kind="simulated" />
      </PageHead>
      <Card>
        <p className="muted small">
          States: initiated → pending → bank debit confirmed → credited to utility. A payment can also fail (no debit) or be reversed (money returned). While a payment is unresolved, a
          second payment for the same bill is blocked.
        </p>
        {loading ? (
          <Loading />
        ) : error ? (
          <ErrorBox error={error} onRetry={reload} />
        ) : data!.payments.length === 0 ? (
          <Empty>No payments yet.</Empty>
        ) : (
          <div className="txn-list">
            {data!.payments.map((p) => (
              <PaymentTimeline key={p.id} p={p} />
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
