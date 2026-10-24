import type { SessionUser } from '../auth.js';
import { accessiblePropertyIds, canAccessProperty, getAccessibleBill } from '../access.js';
import { audit, DB, newId, nextCounter } from '../db/index.js';
import { COMPLAINT_SLA_DAYS, COMPLAINT_TRANSITIONS, ComplaintCategory, ComplaintStatus } from '../domain/complaints.js';
import { AppError, notFound } from '../errors.js';

interface ComplaintRow {
  id: string;
  ref: string;
  user_id: string;
  property_id: string | null;
  bill_id: string | null;
  category: ComplaintCategory;
  subject: string;
  description: string;
  status: ComplaintStatus;
  assigned_to: string | null;
  resolution_note: string | null;
  provider_submission: string;
  created_at: string;
  updated_at: string;
}

function addEvent(db: DB, complaintId: string, actorId: string, kind: string, from: string | null, to: string | null, note: string | null, at: string) {
  db.prepare('INSERT INTO complaint_events (complaint_id, actor_id, kind, from_status, to_status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    complaintId, actorId, kind, from, to, note, at,
  );
}

export function createComplaint(
  db: DB,
  user: SessionUser,
  input: { category: ComplaintCategory; subject: string; description: string; propertyId?: string | null; billId?: string | null },
  now = new Date(),
) {
  if (user.role === 'admin') throw new AppError(403, 'FORBIDDEN', 'Administrators manage complaints but do not file them');
  let propertyId = input.propertyId ?? null;
  if (input.billId) {
    const bill = getAccessibleBill(db, user, input.billId);
    propertyId = bill.property_id;
  }
  if (propertyId && !canAccessProperty(db, user, propertyId)) throw notFound('Property');
  const at = now.toISOString();
  return db.transaction(() => {
    const id = newId('cmp');
    const refNo = `US-${now.getUTCFullYear()}-${String(nextCounter(db, `complaint-${now.getUTCFullYear()}`)).padStart(6, '0')}`;
    db.prepare(
      `INSERT INTO complaints (id, ref, user_id, property_id, bill_id, category, subject, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?)`,
    ).run(id, refNo, user.id, propertyId, input.billId ?? null, input.category, input.subject, input.description, at, at);
    addEvent(db, id, user.id, 'created', null, 'submitted', 'Complaint registered in Utility Saathi. Not sent to the utility (simulated).', at);
    audit(db, user.id, 'complaint.created', 'complaint', id, { ref: refNo, category: input.category }, at);
    return getComplaintRow(db, id)!;
  })();
}

const getComplaintRow = (db: DB, id: string) => db.prepare('SELECT * FROM complaints WHERE id = ?').get(id) as ComplaintRow | undefined;

function canSee(db: DB, user: SessionUser, c: ComplaintRow) {
  if (user.role === 'admin' || c.user_id === user.id) return true;
  return !!c.property_id && canAccessProperty(db, user, c.property_id);
}

export function getVisibleComplaint(db: DB, user: SessionUser, id: string) {
  const c = getComplaintRow(db, id);
  if (!c || !canSee(db, user, c)) throw notFound('Complaint');
  return c;
}

export function listComplaints(db: DB, user: SessionUser) {
  let rows: ComplaintRow[];
  if (user.role === 'admin') rows = db.prepare('SELECT * FROM complaints ORDER BY created_at DESC').all() as ComplaintRow[];
  else {
    const props = accessiblePropertyIds(db, user);
    rows = db
      .prepare(`SELECT * FROM complaints WHERE user_id = ? ${props.length ? `OR property_id IN (${props.map(() => '?').join(',')})` : ''} ORDER BY created_at DESC`)
      .all(user.id, ...props) as ComplaintRow[];
  }
  return rows.map((r) => presentComplaint(db, r, user, false));
}

export function presentComplaint(db: DB, c: ComplaintRow, viewer: SessionUser, withHistory = true, now = new Date()) {
  const ageDays = (now.getTime() - Date.parse(c.created_at)) / 86_400_000;
  const open = !['resolved', 'closed'].includes(c.status);
  const names = (id: string | null) => (id ? ((db.prepare('SELECT name FROM users WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? null) : null);
  const bill = c.bill_id ? (db.prepare('SELECT bill_number FROM bills WHERE id = ?').get(c.bill_id) as { bill_number: string }) : null;
  return {
    id: c.id,
    ref: c.ref,
    category: c.category,
    subject: c.subject,
    description: c.description,
    status: c.status,
    allowedNext: viewer.role === 'admin' ? COMPLAINT_TRANSITIONS[c.status] : [],
    propertyId: c.property_id,
    billId: c.bill_id,
    billNumber: bill?.bill_number ?? null,
    filedBy: viewer.role === 'admin' || c.user_id === viewer.id ? names(c.user_id) : 'Another authorised resident',
    assignedTo: names(c.assigned_to),
    resolutionNote: c.resolution_note,
    providerSubmission: c.provider_submission,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    overdue: open && ageDays > COMPLAINT_SLA_DAYS,
    history: withHistory
      ? db
          .prepare('SELECT e.kind, e.from_status, e.to_status, e.note, e.created_at, u.name AS actor, u.role AS actor_role FROM complaint_events e JOIN users u ON u.id = e.actor_id WHERE complaint_id = ? ORDER BY e.id')
          .all(c.id)
      : undefined,
  };
}

export function commentOnComplaint(db: DB, user: SessionUser, id: string, note: string, now = new Date()) {
  const c = getVisibleComplaint(db, user, id);
  if (c.status === 'closed') throw new AppError(409, 'COMPLAINT_CLOSED', 'This complaint is closed');
  const at = now.toISOString();
  db.transaction(() => {
    addEvent(db, id, user.id, 'comment', null, null, note, at);
    db.prepare('UPDATE complaints SET updated_at = ? WHERE id = ?').run(at, id);
  })();
  return getComplaintRow(db, id)!;
}

export function adminUpdateComplaint(
  db: DB,
  admin: SessionUser,
  id: string,
  input: { status?: ComplaintStatus; assignedTo?: string | null; note?: string; resolutionNote?: string },
  now = new Date(),
) {
  if (admin.role !== 'admin') throw new AppError(403, 'FORBIDDEN', 'Only administrators can update complaints');
  const c = getComplaintRow(db, id);
  if (!c) throw notFound('Complaint');
  const at = now.toISOString();
  db.transaction(() => {
    if (input.assignedTo !== undefined && input.assignedTo !== c.assigned_to) {
      if (input.assignedTo) {
        const assignee = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'admin'").get(input.assignedTo);
        if (!assignee) throw new AppError(422, 'VALIDATION', 'Complaints can only be assigned to administrators');
      }
      db.prepare('UPDATE complaints SET assigned_to = ?, updated_at = ? WHERE id = ?').run(input.assignedTo, at, id);
      addEvent(db, id, admin.id, 'assignment', null, null, input.assignedTo ? 'Assigned to a case handler' : 'Unassigned', at);
      audit(db, admin.id, 'complaint.assigned', 'complaint', id, { assignedTo: input.assignedTo }, at);
    }
    if (input.status && input.status !== c.status) {
      if (!COMPLAINT_TRANSITIONS[c.status].includes(input.status)) {
        throw new AppError(409, 'ILLEGAL_TRANSITION', `A complaint that is "${c.status}" cannot move to "${input.status}"`);
      }
      if (input.status === 'resolved' && !input.resolutionNote?.trim()) {
        throw new AppError(422, 'RESOLUTION_NOTE_REQUIRED', 'Add a resolution note before resolving');
      }
      db.prepare('UPDATE complaints SET status = ?, resolution_note = COALESCE(?, resolution_note), updated_at = ? WHERE id = ?').run(
        input.status, input.resolutionNote?.trim() || null, at, id,
      );
      addEvent(db, id, admin.id, 'status_change', c.status, input.status, input.resolutionNote ?? input.note ?? null, at);
      audit(db, admin.id, 'complaint.status_changed', 'complaint', id, { from: c.status, to: input.status }, at);
    } else if (input.note?.trim()) {
      addEvent(db, id, admin.id, 'comment', null, null, input.note, at);
    }
  })();
  return getComplaintRow(db, id)!;
}
