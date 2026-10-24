import { beforeEach, describe, expect, it } from 'vitest';
import { CandidateIncident, matchIncident } from '../src/domain/incidents.js';
import { setup } from './helpers.js';

const base: CandidateIncident = {
  id: 'inc_1',
  utility: 'electricity',
  category_family: 'power_outage',
  locality: 'Lakeview',
  group_key: 'F-LV-01',
  status: 'reported_unverified',
  last_report_at: '2026-10-24T10:00:00.000Z',
};
const report = { utility: 'electricity', category: 'power_outage' as const, locality: 'Lakeview', groupKey: 'F-LV-01', reportedAt: '2026-10-24T11:00:00.000Z' };

describe('grouping rules (pure)', () => {
  it('16. related reports group: same utility, issue type, feeder and time window', () => {
    const m = matchIncident(report, [base]);
    expect(m?.incident.id).toBe('inc_1');
    expect(m?.reason).toContain('same feeder F-LV-01');
  });

  it('15a. same locality but different feeder is NOT grouped', () => {
    expect(matchIncident({ ...report, groupKey: 'F-LV-02' }, [base])).toBeNull();
  });

  it('15b. different issue type or utility is NOT grouped', () => {
    expect(matchIncident({ ...report, category: 'low_voltage' }, [base])).toBeNull();
    expect(matchIncident({ ...report, utility: 'water', category: 'low_pressure', groupKey: null }, [base])).toBeNull();
  });

  it('15c. time window boundary: 3 h groups, 3 h + 1 min does not', () => {
    expect(matchIncident({ ...report, reportedAt: '2026-10-24T13:00:00.000Z' }, [base])).not.toBeNull();
    expect(matchIncident({ ...report, reportedAt: '2026-10-24T13:01:00.000Z' }, [base])).toBeNull();
  });

  it('15d. restored or closed incidents do not absorb new reports', () => {
    expect(matchIncident(report, [{ ...base, status: 'service_restored' }])).toBeNull();
    expect(matchIncident(report, [{ ...base, status: 'closed' }])).toBeNull();
  });

  it('falls back to normalised locality only when a network key is missing', () => {
    const m = matchIncident({ ...report, groupKey: null, locality: '  lakeview ' }, [base]);
    expect(m?.reason).toContain('no network identifier');
    expect(matchIncident({ ...report, groupKey: null, locality: 'Mill Road' }, [base])).toBeNull();
  });
});

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});
const incidentByRef = (ref: string) => ctx.db.prepare('SELECT * FROM incidents WHERE ref = ?').get(ref) as any;

describe('incidents API', () => {
  it('seed: three Lakeview West reports form one incident; East feeder and low voltage stay separate', () => {
    expect(incidentByRef('INC-00001')).toMatchObject({ group_key: 'F-LV-01', category_family: 'power_outage', report_count: 3 });
    expect(incidentByRef('INC-00002')).toMatchObject({ group_key: 'F-LV-02', report_count: 1 });
    expect(incidentByRef('INC-00003')).toMatchObject({ category_family: 'low_voltage', report_count: 1 });
  });

  it('17. any number of community reports never verifies an incident', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await ctx.as(i % 2 ? 'asha' : 'ravi').post('/api/reports', { category: 'power_outage', locality: 'Lakeview', infraNodeId: 'T-LV-01A' });
      expect(r.status).toBe(201);
      expect(r.body.grouped).toBe(true);
    }
    const inc = incidentByRef('INC-00001');
    expect(inc.report_count).toBe(13);
    expect(inc.status).toBe('reported_unverified');
    const view = (await ctx.as('asha').get(`/api/incidents/${inc.id}`)).body.incident;
    expect(view.verified).toBe(false);
    expect(view.evidenceSource).toMatch(/unverified/);
    expect(view.eta).toBeNull();
  });

  it('18. only an administrator with an evidence source can publish verified status', async () => {
    const id = incidentByRef('INC-00001').id;
    const body = { status: 'verified_fault', note: 'Crew confirmed cable fault', evidenceSource: 'Demo field crew log #44 (synthetic)' };
    expect((await ctx.as('asha').patch(`/api/admin/incidents/${id}`, body)).status).toBe(403);
    expect((await ctx.as('ravi').patch(`/api/admin/incidents/${id}`, body)).status).toBe(403);
    const noEvidence = await ctx.as('priya').patch(`/api/admin/incidents/${id}`, { ...body, evidenceSource: '' });
    expect(noEvidence.body.error.code).toBe('EVIDENCE_REQUIRED');
    const etaNoSource = await ctx.as('priya').patch(`/api/admin/incidents/${id}`, { ...body, etaAt: '2026-10-24T18:00:00Z' });
    expect(etaNoSource.body.error.code).toBe('ETA_NEEDS_SOURCE');
    const ok = await ctx.as('priya').patch(`/api/admin/incidents/${id}`, { ...body, etaAt: '2026-10-24T18:00:00Z', etaSource: 'Demo control room (synthetic)' });
    expect(ok.status).toBe(200);
    expect(ok.body.incident).toMatchObject({ status: 'verified_fault', verified: true, evidenceSource: 'Demo field crew log #44 (synthetic)' });
    expect(ok.body.incident.eta.source).toBe('Demo control room (synthetic)');
    const audit = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'incident.status_changed' AND entity_id = ?").all(id);
    expect(audit).toHaveLength(1);
  });

  it('incident views never expose reporter identity, and residents do not see report descriptions', async () => {
    const id = incidentByRef('INC-00001').id;
    const asTenant = JSON.stringify((await ctx.as('karthik').get(`/api/incidents/${id}`)).body);
    expect(asTenant).not.toMatch(/u_asha|u_ravi|u_meera|reporter/);
    expect(asTenant).not.toContain('Street lights also off');
    const list = JSON.stringify((await ctx.as('karthik').get('/api/incidents')).body);
    expect(list).not.toMatch(/u_asha|reporter_id/);
  });

  it('rejects unknown network identifiers and future timestamps', async () => {
    expect((await ctx.as('asha').post('/api/reports', { category: 'power_outage', locality: 'Lakeview', infraNodeId: 'WZ-LV' })).status).toBe(422);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect((await ctx.as('asha').post('/api/reports', { category: 'power_outage', locality: 'Lakeview', reportedAt: future })).status).toBe(422);
  });
});
