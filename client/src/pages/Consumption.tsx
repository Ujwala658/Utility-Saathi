import { Card, DataLabel, Empty, ErrorBox, Loading, PageHead, useApi } from '../components';
import { date, units } from '../format';

/** P0 shows billed usage history only. Charts, thresholds and the savings calculator are P1. */
export function ConsumptionPage() {
  const { data, error, loading, reload } = useApi<{ bills: any[] }>('/bills');
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const groups = new Map<string, any[]>();
  for (const b of [...data!.bills].reverse()) {
    if (b.units === null) continue;
    const k = `${b.account} · ${b.utility}`;
    groups.set(k, [...(groups.get(k) ?? []), b]);
  }
  return (
    <>
      <PageHead title="Consumption & Savings" subtitle="Billed usage per period, compared with your own history only.">
        <DataLabel kind="synthetic" />
      </PageHead>
      <Card>
        <p className="alert alert-info">
          Coming in the next stage (P1): consumption charts with thresholds, a savings calculator with visible formulas, and emissions estimates using the CEA grid factor of 0.727 tCO₂/MWh (FY 2023-24).
        </p>
      </Card>
      {groups.size === 0 && <Empty>No usage history yet.</Empty>}
      {[...groups.entries()].map(([k, bills]) => {
        const unit = bills[0].utility === 'electricity' ? 'kWh' : 'kL';
        const perDay = bills.map((b) => b.units / Math.max(1, Math.round((Date.parse(b.periodEnd) - Date.parse(b.periodStart)) / 86400000)));
        const max = Math.max(...perDay);
        return (
          <Card key={k} title={`${bills[0].utility === 'electricity' ? '⚡ Electricity' : '💧 Water'} · account ${bills[0].account}`}>
            <ul className="bars" aria-label={`Average daily use in ${unit}`}>
              {bills.map((b, i) => (
                <li key={b.id}>
                  <span className="bar-label">{date(b.periodEnd)}</span>
                  <span className="bar-track">
                    <span className={`bar ${b.readingType === 'estimated' ? 'est' : ''}`} style={{ width: `${(perDay[i] / max) * 100}%` }} />
                  </span>
                  <span className="bar-value">
                    {perDay[i].toFixed(2)} {unit}/day · {units(b.units, unit)}
                    {b.readingType === 'estimated' ? ' (estimated)' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        );
      })}
    </>
  );
}
