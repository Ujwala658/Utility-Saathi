import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshness } from '../src/services/sources.js';
import { setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});
const billIds = async (who: Parameters<typeof ctx.as>[0]) => (await ctx.as(who).get('/api/bills')).body.bills.map((b: any) => b.id).sort();

describe('authentication', () => {
  it('rejects wrong passwords and missing tokens; stores only hashes', async () => {
    const bad = await request(ctx.app).post('/api/auth/login').send({ email: 'asha.tenant@demo.utilitysaathi.in', password: 'wrong' });
    expect(bad.status).toBe(401);
    expect((await request(ctx.app).get('/api/bills')).status).toBe(401);
    expect((await request(ctx.app).get('/api/bills').set('Authorization', 'Bearer forged')).status).toBe(401);
    const hashes = ctx.db.prepare('SELECT password_hash FROM users').all() as { password_hash: string }[];
    expect(hashes.every((h) => h.password_hash.startsWith('scrypt$') && !h.password_hash.includes('demo1234'))).toBe(true);
    const sessions = ctx.db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
    expect(sessions.every((s) => /^[0-9a-f]{64}$/.test(s.token_hash))).toBe(true);
  });
});

describe('19. property authorization', () => {
  it('tenants see only their authorised property', async () => {
    const asha = await billIds('asha');
    expect(asha.length).toBeGreaterThan(0);
    expect(asha.every((id: string) => id.startsWith('bill_lv_'))).toBe(true);
    expect((await ctx.as('asha').get('/api/bills/bill_mr_el_10')).status).toBe(404);
    expect((await ctx.as('asha').get('/api/bills/bill_rs_el_10')).status).toBe(404);
    expect((await ctx.as('karthik').get('/api/bills/bill_lv_el_09')).status).toBe(404);
  });

  it("tenants cannot see another tenant's complaints", async () => {
    const karthiks = ctx.db.prepare("SELECT id FROM complaints WHERE user_id = 'u_karthik'").get() as { id: string };
    expect((await ctx.as('asha').get(`/api/complaints/${karthiks.id}`)).status).toBe(404);
    const list = (await ctx.as('asha').get('/api/complaints')).body.complaints;
    expect(list.map((c: any) => c.id)).not.toContain(karthiks.id);
    expect((await ctx.as('asha').post(`/api/complaints/${karthiks.id}/comments`, { note: 'hi' })).status).toBe(404);
  });

  it('owners see only properties they own', async () => {
    const ravi = await billIds('ravi');
    expect(ravi.some((id: string) => id.startsWith('bill_lv_'))).toBe(true);
    expect(ravi.some((id: string) => id.startsWith('bill_mr_'))).toBe(true);
    expect(ravi.some((id: string) => id.startsWith('bill_rs_'))).toBe(false);
    expect((await billIds('meera')).every((id: string) => id.startsWith('bill_rs_'))).toBe(true);
    expect((await ctx.as('meera').get('/api/bills/bill_lv_el_09')).status).toBe(404);
  });

  it('owners grant and revoke tenant access; revocation takes effect immediately', async () => {
    const add = await ctx.as('ravi').post('/api/properties/prop_millroad/members', { email: 'asha.tenant@demo.utilitysaathi.in' });
    expect(add.status).toBe(201);
    expect((await ctx.as('asha').get('/api/bills/bill_mr_el_10')).status).toBe(200);
    expect((await ctx.as('ravi').del(`/api/properties/prop_millroad/members/${add.body.id}`)).status).toBe(200);
    expect((await ctx.as('asha').get('/api/bills/bill_mr_el_10')).status).toBe(404);
    expect((await ctx.as('ravi').del('/api/properties/prop_lakeview/members/mem_asha_lv')).status).toBe(200);
    expect(await billIds('asha')).toEqual([]);
    const actions = (ctx.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'property.%'").all() as any[]).map((a) => a.action);
    expect(actions).toEqual(['property.access_granted', 'property.access_revoked', 'property.access_revoked']);
  });

  it("owners cannot manage someone else's property and tenants cannot grant access", async () => {
    expect((await ctx.as('meera').post('/api/properties/prop_lakeview/members', { email: 'karthik.tenant@demo.utilitysaathi.in' })).status).toBe(404);
    expect((await ctx.as('asha').post('/api/properties/prop_lakeview/members', { email: 'karthik.tenant@demo.utilitysaathi.in' })).status).toBe(403);
  });

  it('administration endpoints are admin-only', async () => {
    for (const who of ['asha', 'ravi'] as const) {
      expect((await ctx.as(who).get('/api/admin/overview')).status).toBe(403);
      expect((await ctx.as(who).get('/api/admin/audit')).status).toBe(403);
      expect((await ctx.as(who).post('/api/admin/demo/reset')).status).toBe(403);
    }
    expect((await ctx.as('priya').get('/api/admin/overview')).status).toBe(200);
  });

  it('account numbers are masked in bill lists', async () => {
    const bills = (await ctx.as('asha').get('/api/bills')).body.bills;
    expect(bills.every((b: any) => /^•+\d{4}$/.test(b.account))).toBe(true);
  });
});

describe('21. complaint lifecycle and audit history', () => {
  it('runs submitted → acknowledged → under review → escalated → resolved → closed', async () => {
    const created = await ctx.as('asha').post('/api/complaints', { category: 'billing', subject: 'High bill', description: 'Please check readings', billId: 'bill_lv_el_09' });
    expect(created.status).toBe(201);
    const c = created.body.complaint;
    expect(c.ref).toMatch(/^US-\d{4}-\d{6}$/);
    expect(c.providerSubmission).toBe('simulated_not_submitted');
    expect(c.propertyId).toBe('prop_lakeview');

    const step = (body: object) => ctx.as('priya').patch(`/api/admin/complaints/${c.id}`, body);
    expect((await step({ status: 'resolved', resolutionNote: 'x' })).status).toBe(409);
    expect((await step({ status: 'acknowledged', assignedTo: 'u_arjun' })).status).toBe(200);
    expect((await step({ status: 'under_review' })).status).toBe(200);
    expect((await step({ status: 'escalated', note: 'Sent to metering team' })).status).toBe(200);
    expect((await step({ status: 'resolved' })).body.error.code).toBe('RESOLUTION_NOTE_REQUIRED');
    expect((await step({ status: 'resolved', resolutionNote: 'Catch-up after two estimates confirmed.' })).status).toBe(200);
    expect((await ctx.as('asha').patch(`/api/admin/complaints/${c.id}`, { status: 'closed' })).status).toBe(403);
    const closed = await step({ status: 'closed' });
    expect(closed.body.complaint.status).toBe('closed');
    expect((await ctx.as('asha').post(`/api/complaints/${c.id}/comments`, { note: 'thanks' })).status).toBe(409);

    const view = (await ctx.as('asha').get(`/api/complaints/${c.id}`)).body.complaint;
    expect(view.history.filter((h: any) => h.kind === 'status_change').map((h: any) => h.to_status)).toEqual(['acknowledged', 'under_review', 'escalated', 'resolved', 'closed']);
    expect(view.history.some((h: any) => h.kind === 'assignment')).toBe(true);
    expect(view.resolutionNote).toContain('Catch-up');
    const audit = ctx.db.prepare("SELECT action FROM audit_log WHERE entity_id = ? ORDER BY id").all(c.id) as any[];
    expect(audit.map((a) => a.action)).toEqual(['complaint.created', 'complaint.assigned', ...Array(5).fill('complaint.status_changed')]);
    expect(() => ctx.db.prepare('DELETE FROM complaint_events').run()).toThrow(/append-only/);
    expect(() => ctx.db.prepare('UPDATE audit_log SET action = ?').run('x')).toThrow(/append-only/);
  });

  it("cannot attach a complaint to another property's bill", async () => {
    expect((await ctx.as('asha').post('/api/complaints', { category: 'billing', subject: 'x', description: 'y', billId: 'bill_mr_el_10' })).status).toBe(404);
  });

  it('validates input on the server', async () => {
    const res = await ctx.as('asha').post('/api/complaints', { category: 'nonsense', subject: '', description: 'y' });
    expect(res.status).toBe(422);
    expect(res.body.error.details.map((d: any) => d.path).sort()).toEqual(['category', 'subject']);
  });
});

describe('admin alerts', () => {
  it('explains each alert and avoids accusatory wording', async () => {
    const o = (await ctx.as('priya').get('/api/admin/overview')).body;
    const kinds = new Set(o.alerts.map((a: any) => a.kind));
    for (const k of ['bill_exception', 'reconciliation', 'incident_verification', 'complaint_overdue', 'stale_data']) expect(kinds).toContain(k);
    for (const a of o.alerts) {
      expect(a.trigger && a.rule && a.limitations && a.verify.length && a.dataBasis).toBeTruthy();
      expect(a.title.toLowerCase()).not.toContain('fraud');
    }
    const recon = o.alerts.find((a: any) => a.kind === 'reconciliation');
    expect(recon.severity).toBe('warning');
    expect(o.alerts.find((a: any) => a.link.id === 'bill_mr_el_10').severity).toBe('review');
    expect(o.overdueBills.map((b: any) => b.billId)).toContain('bill_lv_el_09');
  });

  it('records blocked duplicate attempts for review', async () => {
    await ctx.as('asha').post('/api/bills/bill_lv_el_10/payments', { idempotencyKey: 'dup-for-admin-1' });
    const o = (await ctx.as('priya').get('/api/admin/overview')).body;
    expect(o.blockedAttempts).toHaveLength(1);
    expect(o.alerts.find((a: any) => a.kind === 'duplicate_attempt').title).toMatch(/^Potential duplicate transaction/);
  });
});

describe('23. dataset provenance and staleness', () => {
  const now = new Date('2026-10-24T00:00:00Z');
  it('computes fresh, stale, never-refreshed and not-applicable states', () => {
    expect(freshness({ last_refresh_at: '2026-10-01T00:00:00Z', verified_at: null, stale_after_days: 30 }, now).state).toBe('fresh');
    expect(freshness({ last_refresh_at: '2026-09-23T00:00:00Z', verified_at: null, stale_after_days: 30 }, now).state).toBe('stale');
    expect(freshness({ last_refresh_at: '2026-09-24T00:00:00Z', verified_at: null, stale_after_days: 30 }, now).state).toBe('fresh');
    expect(freshness({ last_refresh_at: null, verified_at: null, stale_after_days: 30 }, now).state).toBe('never_refreshed');
    expect(freshness({ last_refresh_at: null, verified_at: null, stale_after_days: null }, now).state).toBe('not_applicable');
  });

  it('registry labels every source by type', async () => {
    const sources = (await ctx.as('asha').get('/api/sources')).body.sources;
    const types = sources.map((s: any) => s.source_type);
    expect(types).toContain('official_historical');
    expect(types).toContain('synthetic_demo');
    expect(sources.every((s: any) => s.limitations && s.integration_status)).toBe(true);
    expect((await ctx.as('asha').get('/api/bills')).body.dataLabel).toBe('synthetic_demo');
  });
});
