import { Badge, Card, DataLabel, ErrorBox, Loading, PageHead, useApi } from '../components';
import { date, humanize } from '../format';

const TYPE_LABEL: Record<string, 'real' | 'synthetic' | 'unverified'> = {
  official_live: 'real',
  official_historical: 'real',
  public_third_party: 'real',
  synthetic_demo: 'synthetic',
  manual: 'unverified',
};

export function ReportsPage() {
  const { data, error, loading, reload } = useApi<{ sources: any[] }>('/sources');
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  return (
    <>
      <PageHead title="Reports & Data" subtitle="Where every number in Utility Saathi comes from." />
      <Card>
        <p>
          Public datasets support aggregate context such as grid emission factors. They do not provide private bills, live outages or payment confirmations, so those are simulated in this
          demo and labelled as such. Exportable reports and sustainability summaries are planned for P1.
        </p>
      </Card>
      <div className="grid">
        {data!.sources.map((s) => (
          <Card key={s.id} title={s.name} actions={<DataLabel kind={TYPE_LABEL[s.source_type]} />} className="span-3">
            <dl className="facts">
              <div>
                <dt>Publisher</dt>
                <dd>{s.publisher}</dd>
              </div>
              <div>
                <dt>Type</dt>
                <dd>{humanize(s.source_type)}</dd>
              </div>
              <div>
                <dt>Coverage</dt>
                <dd>
                  {s.geography} · {s.time_period}
                </dd>
              </div>
              <div>
                <dt>Licence</dt>
                <dd>{s.licence}</dd>
              </div>
              <div>
                <dt>Freshness</dt>
                <dd>
                  <Badge value={s.freshness.state} label={humanize(s.freshness.state)} />
                  {s.freshness.last && <div className="muted small">last checked {date(s.freshness.last)}</div>}
                </dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{s.integration_status}</dd>
              </div>
            </dl>
            <p>
              <strong>Fields:</strong> {s.fields}
            </p>
            <p>
              <strong>Used for:</strong> {s.used_for}
            </p>
            <p className="muted small">
              <strong>Limitations:</strong> {s.limitations}
            </p>
            {s.url && (
              <p className="small">
                <a href={s.url} target="_blank" rel="noreferrer noopener">
                  {s.url}
                </a>
              </p>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
