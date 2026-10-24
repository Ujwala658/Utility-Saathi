import express, { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { accessiblePropertyIds, canAccessProperty, getAccessibleBill, maskAccount } from './access.js';
import { createSession, deleteSession, rateLimit, requireAuth, requireRole, verifyPassword } from './auth.js';
import { audit, DB, newId } from './db/index.js';
import { resetDemoData } from './db/seed.js';
import { BillValidationError, calculateBill } from './domain/billing.js';
import { COMPLAINT_CATEGORIES, COMPLAINT_STATUSES } from './domain/complaints.js';
import { INCIDENT_STATUSES, REPORT_CATEGORIES, STATUS_LABELS } from './domain/incidents.js';
import { PAYMENT_STATES } from './domain/payments.js';
import { AppError, notFound } from './errors.js';
import { adminOverview, auditLog } from './services/admin.js';
import { billInput, billSummary, listBillsForProperties } from './services/bills.js';
import { adminUpdateComplaint, commentOnComplaint, createComplaint, getVisibleComplaint, listComplaints, presentComplaint } from './services/complaints.js';
import { presentIncident, submitReport, updateIncidentStatus } from './services/incidents.js';
import { getTxn, initiatePayment, presentTxn, recordPaymentEvent, SIMULATION_NOTICE } from './services/payments.js';
import { listSources } from './services/sources.js';

function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new AppError(422, 'VALIDATION', 'Please check the highlighted fields', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

const text = (max: number) => z.string().trim().min(1).max(max);
const isoDateTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Not a valid date-time');

export interface AppOptions {
  allowDemoReset?: boolean;
  /** Disable rate limiting (tests make many requests quickly). */
  rateLimits?: boolean;
}

export function createApp(db: DB, opts: AppOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Cache-Control', 'no-store');
    next();
  });

  const limits = opts.rateLimits ?? true;
  const passthrough = (_req: Request, _res: Response, next: NextFunction) => next();
  const loginLimiter = limits ? rateLimit({ windowMs: 60_000, max: 10, key: (r) => `login:${r.ip}` }) : passthrough;
  const payLimiter = limits ? rateLimit({ windowMs: 60_000, max: 20, key: (r) => `pay:${r.user?.id}` }) : passthrough;
  const auth = requireAuth(db);
  const admin = requireRole('admin');

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // Demo accounts are fictional and listed publicly so judges can sign in.
  app.get('/api/demo-accounts', (_req, res) => {
    res.json({
      notice: 'Fictional demo accounts. Password for all: demo1234',
      accounts: db.prepare('SELECT email, name, role FROM users WHERE is_demo = 1 ORDER BY role, name').all(),
    });
  });

  app.post('/api/auth/login', loginLimiter, (req, res) => {
    const body = parse(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) }), req.body);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(body.email) as any;
    if (!user || !verifyPassword(body.password, user.password_hash)) throw new AppError(401, 'BAD_CREDENTIALS', 'Email or password is incorrect');
    const token = createSession(db, user.id);
    audit(db, user.id, 'auth.login', 'user', user.id, {}, new Date().toISOString());
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, isDemo: !!user.is_demo } });
  });

  app.post('/api/auth/logout', auth, (req, res) => {
    deleteSession(db, req.token!);
    res.json({ ok: true });
  });

  app.get('/api/me', auth, (req, res) => {
    res.json({ user: { ...req.user, isDemo: !!req.user!.is_demo } });
  });

  // Properties and access ---------------------------------------------------
  app.get('/api/properties', auth, (req, res) => {
    const ids = accessiblePropertyIds(db, req.user!);
    const props = ids.map((id) => {
      const p = db.prepare('SELECT p.*, u.name AS owner_name FROM properties p JOIN users u ON u.id = p.owner_id WHERE p.id = ?').get(id) as any;
      const accounts = (db.prepare('SELECT id, utility, account_number, provider_name, tariff_code FROM utility_accounts WHERE property_id = ?').all(id) as any[]).map((a) => ({
        ...a,
        account_number: maskAccount(a.account_number),
      }));
      const isOwner = req.user!.role === 'admin' || p.owner_id === req.user!.id;
      const members = isOwner
        ? db
            .prepare(`SELECT m.id, m.granted_at, m.revoked_at, u.name, u.email FROM property_memberships m JOIN users u ON u.id = m.user_id
                      WHERE m.property_id = ? ORDER BY m.granted_at`)
            .all(id)
        : undefined;
      return { id: p.id, label: p.label, addressLine: p.address_line, locality: p.locality, city: p.city, state: p.state, ownerName: p.owner_name, accounts, members, canManage: isOwner && req.user!.role === 'owner' };
    });
    res.json({ properties: props, dataLabel: 'synthetic_demo' });
  });

  const ownerOf = (req: Request, propertyId: string) => {
    const p = db.prepare('SELECT owner_id FROM properties WHERE id = ?').get(propertyId) as { owner_id: string } | undefined;
    if (!p || !canAccessProperty(db, req.user!, propertyId)) throw notFound('Property');
    if (req.user!.role !== 'owner' || p.owner_id !== req.user!.id) throw new AppError(403, 'FORBIDDEN', 'Only the property owner can manage access');
  };

  app.post('/api/properties/:id/members', auth, (req, res) => {
    const propertyId = String(req.params.id);
    ownerOf(req, propertyId);
    const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email() }), req.body);
    const tenant = db.prepare("SELECT id FROM users WHERE email = ? AND role = 'tenant'").get(email) as { id: string } | undefined;
    if (!tenant) throw new AppError(422, 'VALIDATION', 'No tenant account with that email');
    const at = new Date().toISOString();
    const id = newId('mem');
    try {
      db.prepare('INSERT INTO property_memberships (id, property_id, user_id, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)').run(id, propertyId, tenant.id, req.user!.id, at);
    } catch (e: any) {
      if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw new AppError(409, 'ALREADY_MEMBER', 'This tenant already has access');
      throw e;
    }
    audit(db, req.user!.id, 'property.access_granted', 'property', propertyId, { membershipId: id, tenantId: tenant.id }, at);
    res.status(201).json({ id });
  });

  app.delete('/api/properties/:id/members/:membershipId', auth, (req, res) => {
    const propertyId = String(req.params.id);
    ownerOf(req, propertyId);
    const at = new Date().toISOString();
    const r = db
      .prepare('UPDATE property_memberships SET revoked_at = ?, revoked_by = ? WHERE id = ? AND property_id = ? AND revoked_at IS NULL')
      .run(at, req.user!.id, String(req.params.membershipId), propertyId);
    if (r.changes === 0) throw notFound('Active membership');
    audit(db, req.user!.id, 'property.access_revoked', 'property', propertyId, { membershipId: req.params.membershipId }, at);
    res.json({ ok: true });
  });

  // Bills -------------------------------------------------------------------
  app.get('/api/bills', auth, (req, res) => {
    res.json({ bills: listBillsForProperties(db, accessiblePropertyIds(db, req.user!)), dataLabel: 'synthetic_demo' });
  });

  app.get('/api/bills/:id', auth, (req, res) => {
    const row = getAccessibleBill(db, req.user!, String(req.params.id));
    const input = billInput(db, row);
    const calculation = calculateBill(input);
    const payments = (db.prepare('SELECT * FROM payment_transactions WHERE bill_id = ? ORDER BY created_at').all(row.id) as any[]).map((t) => presentTxn(db, t));
    res.json({
      bill: billSummary(db, row),
      readings: { previous: input.previousReading, current: input.currentReading, type: input.readingType, meterDigits: input.meter.digits, multiplier: input.meter.multiplier },
      statedTotalPaise: row.stated_total_paise,
      calculation,
      history: input.history,
      payments,
      dataLabel: 'synthetic_demo',
    });
  });

  // Payments (SIMULATED) ----------------------------------------------------
  app.post('/api/bills/:id/payments', auth, payLimiter, (req, res) => {
    const { idempotencyKey } = parse(z.object({ idempotencyKey: z.string().trim().min(8).max(100) }), req.body);
    const { replayed, txn } = initiatePayment(db, req.user!, String(req.params.id), idempotencyKey);
    res.status(replayed ? 200 : 201).json({ replayed, payment: presentTxn(db, txn), notice: SIMULATION_NOTICE });
  });

  const visibleTxnIds = (req: Request) => {
    if (req.user!.role === 'admin') return null;
    const props = accessiblePropertyIds(db, req.user!);
    if (props.length === 0) return [];
    return (
      db
        .prepare(`SELECT t.id FROM payment_transactions t JOIN bills b ON b.id = t.bill_id JOIN utility_accounts a ON a.id = b.account_id
                  WHERE a.property_id IN (${props.map(() => '?').join(',')})`)
        .all(...props) as { id: string }[]
    ).map((r) => r.id);
  };

  app.get('/api/payments', auth, (req, res) => {
    const ids = visibleTxnIds(req);
    const rows = (ids === null ? db.prepare('SELECT * FROM payment_transactions ORDER BY created_at DESC').all() : ids.map((id) => getTxn(db, id))) as any[];
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    res.json({ payments: rows.map((t) => presentTxn(db, t)), notice: SIMULATION_NOTICE });
  });

  app.get('/api/payments/:id', auth, (req, res) => {
    const ids = visibleTxnIds(req);
    const id = String(req.params.id);
    if (ids !== null && !ids.includes(id)) throw notFound('Transaction');
    const t = getTxn(db, id);
    if (!t) throw notFound('Transaction');
    res.json({ payment: presentTxn(db, t), notice: SIMULATION_NOTICE });
  });

  // Service reports and incidents --------------------------------------------
  app.get('/api/infra-nodes', auth, (_req, res) => {
    res.json({ nodes: db.prepare('SELECT id, utility, kind, parent_id, locality, label, data_label FROM infra_nodes ORDER BY id').all(), dataLabel: 'synthetic_demo' });
  });

  app.post('/api/reports', auth, (req, res) => {
    if (req.user!.role === 'admin') throw new AppError(403, 'FORBIDDEN', 'Administrators publish incident updates instead of community reports');
    const body = parse(
      z.object({
        category: z.enum(Object.keys(REPORT_CATEGORIES) as [keyof typeof REPORT_CATEGORIES]),
        locality: text(80),
        infraNodeId: z.string().trim().max(40).optional().nullable(),
        description: z.string().trim().max(500).optional(),
        reportedAt: isoDateTime.optional(),
      }),
      req.body,
    );
    res.status(201).json(submitReport(db, req.user!, body));
  });

  app.get('/api/reports/mine', auth, (req, res) => {
    res.json({
      reports: db
        .prepare('SELECT r.id, r.category, r.locality, r.reported_at, r.grouping_reason, i.ref AS incident_ref, i.id AS incident_id, i.status FROM service_reports r JOIN incidents i ON i.id = r.incident_id WHERE reporter_id = ? ORDER BY reported_at DESC')
        .all(req.user!.id)
        .map((r: any) => ({ ...r, statusLabel: STATUS_LABELS[r.status as keyof typeof STATUS_LABELS] })),
    });
  });

  app.get('/api/incidents', auth, (_req, res) => {
    const rows = db.prepare('SELECT * FROM incidents ORDER BY last_report_at DESC').all() as any[];
    res.json({ incidents: rows.map((r) => presentIncident(db, r)), dataLabel: 'synthetic_demo' });
  });

  app.get('/api/incidents/:id', auth, (req, res) => {
    const row = db.prepare('SELECT * FROM incidents WHERE id = ?').get(String(req.params.id));
    if (!row) throw notFound('Incident');
    res.json({ incident: presentIncident(db, row as any, { withReports: true, admin: req.user!.role === 'admin' }) });
  });

  // Complaints ----------------------------------------------------------------
  app.get('/api/complaints', auth, (req, res) => res.json({ complaints: listComplaints(db, req.user!) }));

  app.post('/api/complaints', auth, (req, res) => {
    const body = parse(
      z.object({
        category: z.enum(COMPLAINT_CATEGORIES),
        subject: text(120),
        description: text(2000),
        propertyId: z.string().optional().nullable(),
        billId: z.string().optional().nullable(),
      }),
      req.body,
    );
    const c = createComplaint(db, req.user!, body);
    res.status(201).json({ complaint: presentComplaint(db, c, req.user!) });
  });

  app.get('/api/complaints/:id', auth, (req, res) => {
    const c = getVisibleComplaint(db, req.user!, String(req.params.id));
    res.json({ complaint: presentComplaint(db, c, req.user!) });
  });

  app.post('/api/complaints/:id/comments', auth, (req, res) => {
    const { note } = parse(z.object({ note: text(1000) }), req.body);
    const c = commentOnComplaint(db, req.user!, String(req.params.id), note);
    res.status(201).json({ complaint: presentComplaint(db, c, req.user!) });
  });

  // Data provenance -----------------------------------------------------------
  app.get('/api/sources', auth, (_req, res) => res.json({ sources: listSources(db) }));

  // Administration --------------------------------------------------------------
  app.get('/api/admin/overview', auth, admin, (_req, res) => res.json(adminOverview(db)));
  app.get('/api/admin/audit', auth, admin, (_req, res) => res.json({ events: auditLog(db) }));
  app.get('/api/admin/users', auth, admin, (_req, res) => res.json({ users: db.prepare('SELECT id, name, role FROM users ORDER BY role, name').all() }));

  app.post('/api/admin/payments/:id/events', auth, admin, (req, res) => {
    const body = parse(
      z.object({ toState: z.enum(PAYMENT_STATES), source: z.enum(['simulated_gateway', 'simulated_utility']), note: z.string().trim().max(300).optional() }),
      req.body,
    );
    const t = recordPaymentEvent(db, req.user!, String(req.params.id), body.toState, body.source, body.note ?? null);
    res.json({ payment: presentTxn(db, t), notice: SIMULATION_NOTICE });
  });

  app.patch('/api/admin/incidents/:id', auth, admin, (req, res) => {
    const body = parse(
      z.object({
        status: z.enum(INCIDENT_STATUSES),
        note: text(500),
        evidenceSource: z.string().trim().max(200).optional().nullable(),
        etaAt: isoDateTime.optional().nullable(),
        etaSource: z.string().trim().max(200).optional().nullable(),
      }),
      req.body,
    );
    const row = updateIncidentStatus(db, req.user!, String(req.params.id), body);
    res.json({ incident: presentIncident(db, row as any, { withReports: true, admin: true }) });
  });

  app.patch('/api/admin/complaints/:id', auth, admin, (req, res) => {
    const body = parse(
      z.object({
        status: z.enum(COMPLAINT_STATUSES).optional(),
        assignedTo: z.string().nullable().optional(),
        note: z.string().trim().max(1000).optional(),
        resolutionNote: z.string().trim().max(1000).optional(),
      }),
      req.body,
    );
    const c = adminUpdateComplaint(db, req.user!, String(req.params.id), body);
    res.json({ complaint: presentComplaint(db, c, req.user!) });
  });

  app.post('/api/admin/demo/reset', auth, admin, (_req, res) => {
    if (!opts.allowDemoReset) throw new AppError(403, 'FORBIDDEN', 'Demo reset is disabled on this server');
    resetDemoData(db);
    res.json({ ok: true, message: 'Synthetic demo data restored. Please sign in again.' });
  });

  app.use('/api', (_req, _res, next) => next(notFound('Endpoint')));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof BillValidationError) return res.status(422).json({ error: { code: 'BILL_INVALID', message: err.message, details: err.issues } });
    if ((err as any)?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON' } });
    const code = String((err as any)?.code ?? '');
    if (code.startsWith('SQLITE_CONSTRAINT')) {
      // A database rule fired that the application checks did not catch (e.g. a race).
      return res.status(409).json({ error: { code: 'CONFLICT', message: 'This change conflicts with the current state. Please refresh and try again.' } });
    }
    console.error('[error]', (err as Error)?.message);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong on our side' } });
  });

  return app;
}
