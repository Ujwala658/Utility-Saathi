import type { SessionUser } from '../auth.js';
import { audit, DB, newId, nextCounter } from '../db/index.js';
import {
  AUTHORITATIVE_STATUSES,
  CandidateIncident,
  groupKeyFor,
  InfraNode,
  IncidentStatus,
  matchIncident,
  REPORT_CATEGORIES,
  ReportCategory,
  STATUS_LABELS,
} from '../domain/incidents.js';
import { AppError, notFound } from '../errors.js';

export function loadNodes(db: DB) {
  const rows = db.prepare('SELECT id, utility, kind, parent_id, locality FROM infra_nodes').all() as InfraNode[];
  return new Map(rows.map((r) => [r.id, r]));
}

export function submitReport(
  db: DB,
  user: SessionUser,
  input: { category: ReportCategory; locality: string; infraNodeId?: string | null; description?: string; reportedAt?: string },
  now = new Date(),
) {
  const cat = REPORT_CATEGORIES[input.category];
  const reportedAt = input.reportedAt ?? now.toISOString();
  if (Date.parse(reportedAt) > now.getTime() + 5 * 60_000) throw new AppError(422, 'VALIDATION', 'Report time cannot be in the future');
  const nodes = loadNodes(db);
  if (input.infraNodeId) {
    const node = nodes.get(input.infraNodeId);
    if (!node || node.utility !== cat.utility) throw new AppError(422, 'VALIDATION', 'Unknown network identifier for this utility');
  }
  const groupKey = groupKeyFor(input.infraNodeId, nodes);
  return db.transaction(() => {
    const candidates = db.prepare('SELECT id, utility, category_family, locality, group_key, status, last_report_at FROM incidents').all() as CandidateIncident[];
    const match = matchIncident({ utility: cat.utility, category: input.category, locality: input.locality, groupKey, reportedAt }, candidates);
    let incidentId: string;
    let reason: string;
    if (match) {
      incidentId = match.incident.id;
      reason = match.reason;
      // Volume changes the count only; status stays whatever an administrator last set.
      db.prepare('UPDATE incidents SET report_count = report_count + 1, last_report_at = MAX(last_report_at, ?), updated_at = ? WHERE id = ?').run(reportedAt, now.toISOString(), incidentId);
    } else {
      incidentId = newId('inc');
      reason = 'New incident: no open incident matched on utility, issue type, location and time window.';
      const refNo = `INC-${String(nextCounter(db, 'incident')).padStart(5, '0')}`;
      db.prepare(
        `INSERT INTO incidents (id, ref, utility, category_family, locality, group_key, status, report_count, first_reported_at, last_report_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'reported_unverified', 1, ?, ?, ?)`,
      ).run(incidentId, refNo, cat.utility, cat.family, input.locality.trim(), groupKey, reportedAt, reportedAt, now.toISOString());
    }
    const id = newId('rep');
    db.prepare(
      `INSERT INTO service_reports (id, reporter_id, utility, category, locality, infra_node_id, description, reported_at, incident_id, grouping_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, user.id, cat.utility, input.category, input.locality.trim(), input.infraNodeId ?? null, input.description ?? '', reportedAt, incidentId, reason);
    audit(db, user.id, 'report.submitted', 'service_report', id, { incidentId, grouped: !!match }, now.toISOString());
    return { reportId: id, incidentId, grouped: !!match, reason };
  })();
}

/** Public incident view. Never includes reporter identities or descriptions. */
export function presentIncident(db: DB, row: Record<string, any>, opts: { withReports?: boolean; admin?: boolean } = {}) {
  const updates = db
    .prepare('SELECT from_status, to_status, note, evidence_source, eta_at, eta_source, created_at FROM incident_updates WHERE incident_id = ? ORDER BY id')
    .all(row.id) as any[];
  const latest = updates.at(-1);
  const out: Record<string, unknown> = {
    id: row.id,
    ref: row.ref,
    utility: row.utility,
    categoryFamily: row.category_family,
    locality: row.locality,
    networkKey: row.group_key,
    status: row.status,
    statusLabel: STATUS_LABELS[row.status as IncidentStatus],
    verified: AUTHORITATIVE_STATUSES.includes(row.status),
    reportCount: row.report_count,
    firstReportedAt: row.first_reported_at,
    lastReportAt: row.last_report_at,
    updatedAt: row.updated_at,
    evidenceSource: latest?.evidence_source ?? 'Community reports only (unverified)',
    eta: row.eta_at ? { at: row.eta_at, source: row.eta_source } : null,
    updates,
    dataLabel: row.data_label,
  };
  if (opts.withReports) {
    out.reports = (
      db.prepare('SELECT id, category, locality, infra_node_id, reported_at, grouping_reason, description FROM service_reports WHERE incident_id = ? ORDER BY reported_at').all(row.id) as any[]
    ).map((r) => (opts.admin ? r : { ...r, description: undefined }));
  }
  return out;
}

export function updateIncidentStatus(
  db: DB,
  actor: SessionUser,
  incidentId: string,
  input: { status: IncidentStatus; note: string; evidenceSource?: string | null; etaAt?: string | null; etaSource?: string | null },
  now = new Date(),
) {
  if (actor.role !== 'admin') throw new AppError(403, 'FORBIDDEN', 'Only an authorised administrator can change incident status');
  const inc = db.prepare('SELECT * FROM incidents WHERE id = ?').get(incidentId) as any;
  if (!inc) throw notFound('Incident');
  if (inc.status === 'closed') throw new AppError(409, 'INCIDENT_CLOSED', 'Closed incidents cannot be changed');
  if (AUTHORITATIVE_STATUSES.includes(input.status) && !input.evidenceSource?.trim()) {
    throw new AppError(422, 'EVIDENCE_REQUIRED', `"${STATUS_LABELS[input.status]}" needs an evidence source (for example a field crew log or utility notice)`);
  }
  if (!!input.etaAt !== !!input.etaSource?.trim()) {
    throw new AppError(422, 'ETA_NEEDS_SOURCE', 'An ETA must have both a time and a source');
  }
  const at = now.toISOString();
  db.transaction(() => {
    db.prepare('UPDATE incidents SET status = ?, eta_at = ?, eta_source = ?, updated_at = ? WHERE id = ?').run(
      input.status, input.etaAt ?? null, input.etaSource?.trim() || null, at, incidentId,
    );
    db.prepare(
      'INSERT INTO incident_updates (incident_id, author_id, from_status, to_status, note, evidence_source, eta_at, eta_source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(incidentId, actor.id, inc.status, input.status, input.note, input.evidenceSource?.trim() || null, input.etaAt ?? null, input.etaSource?.trim() || null, at);
    audit(db, actor.id, 'incident.status_changed', 'incident', incidentId, { from: inc.status, to: input.status, evidence: input.evidenceSource ?? null }, at);
  })();
  return db.prepare('SELECT * FROM incidents WHERE id = ?').get(incidentId);
}
