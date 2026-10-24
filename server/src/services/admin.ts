import { maskAccount } from '../access.js';
import type { BillRow } from '../access.js';
import { calculateBill } from '../domain/billing.js';
import { STATUS_LABELS as INCIDENT_LABELS } from '../domain/incidents.js';
import { COMPLAINT_SLA_DAYS } from '../domain/complaints.js';
import { formatINR } from '../domain/money.js';
import type { DB } from '../db/index.js';
import { billInput, billPaymentStatus } from './bills.js';
import { listSources } from './sources.js';

export interface Alert {
  id: string;
  kind: 'bill_exception' | 'reconciliation' | 'duplicate_attempt' | 'incident_verification' | 'complaint_overdue' | 'stale_data';
  severity: 'info' | 'warning' | 'review';
  title: string;
  trigger: string;
  rule: string;
  evidence: string[];
  limitations: string;
  verify: string[];
  dataBasis: 'synthetic_demo' | 'real' | 'unverified';
  link: { type: string; id: string };
}

/** Debit-confirmed payments older than this are escalated from info to warning. */
export const RECONCILIATION_WARN_HOURS = 2;

export function adminOverview(db: DB, now = new Date()) {
  const alerts: Alert[] = [];
  const bills = db
    .prepare(`SELECT b.*, a.property_id, a.utility, a.account_number, a.provider_name, a.tariff_code, a.meter_digits, a.meter_multiplier
              FROM bills b JOIN utility_accounts a ON a.id = b.account_id ORDER BY b.period_end DESC`)
    .all() as BillRow[];

  const exceptions = [];
  const overdue = [];
  const today = now.toISOString().slice(0, 10);
  for (const b of bills) {
    const status = billPaymentStatus(db, b);
    if (status === 'unpaid' && b.due_on < today) overdue.push({ billId: b.id, billNumber: b.bill_number, account: maskAccount(b.account_number), dueOn: b.due_on, payablePaise: b.payable_paise });
    if (!b.anomaly_codes) continue;
    const result = calculateBill(billInput(db, b));
    const flagged = result.anomalies.filter((a) => a.severity !== 'info');
    if (flagged.length === 0) continue;
    exceptions.push({ billId: b.id, billNumber: b.bill_number, account: maskAccount(b.account_number), utility: b.utility, calcStatus: result.status, anomalies: result.anomalies.map((a) => ({ code: a.code, severity: a.severity, title: a.title })) });
    alerts.push({
      id: `bill-${b.id}`,
      kind: 'bill_exception',
      severity: flagged.some((a) => a.severity === 'review') ? 'review' : 'warning',
      title: `Needs review: bill ${b.bill_number}`,
      trigger: flagged.map((a) => a.title).join('; '),
      rule: 'Bill engine anomaly rules (catch-up, usage vs own baseline, slab crossing, period length, reading decrease, arithmetic mismatch).',
      evidence: flagged.flatMap((a) => a.evidence),
      limitations: 'An unusual bill does not by itself show an error, leak, meter fault or misconduct.',
      verify: [...new Set(flagged.flatMap((a) => a.checks))],
      dataBasis: 'synthetic_demo',
      link: { type: 'bill', id: b.id },
    });
  }

  const unresolved = db
    .prepare(`SELECT t.*, b.bill_number FROM payment_transactions t JOIN bills b ON b.id = t.bill_id
              WHERE t.state IN ('initiated', 'pending', 'debit_confirmed') ORDER BY t.updated_at`)
    .all() as any[];
  for (const t of unresolved.filter((t) => t.state === 'debit_confirmed')) {
    const hours = (now.getTime() - Date.parse(t.updated_at)) / 3_600_000;
    alerts.push({
      id: `recon-${t.id}`,
      kind: 'reconciliation',
      severity: hours > RECONCILIATION_WARN_HOURS ? 'warning' : 'info',
      title: `Utility credit pending for ${t.txn_ref}`,
      trigger: `Bank debit confirmed ${hours.toFixed(1)} h ago; no utility credit recorded.`,
      rule: `Debit-confirmed payments without utility credit; warning after ${RECONCILIATION_WARN_HOURS} h.`,
      evidence: [`Bill ${t.bill_number}, amount ${formatINR(t.amount_paise)}, state debit_confirmed since ${t.updated_at}.`],
      limitations: 'Simulated transactions. Delay may be normal settlement time.',
      verify: ['Check the (simulated) utility settlement file for this reference.', 'Record credit_reconciled or reversed once confirmed.'],
      dataBasis: 'synthetic_demo',
      link: { type: 'payment', id: t.id },
    });
  }

  const blocked = db
    .prepare(`SELECT a.*, b.bill_number, t.txn_ref FROM blocked_payment_attempts a JOIN bills b ON b.id = a.bill_id
              LEFT JOIN payment_transactions t ON t.id = a.existing_txn_id ORDER BY a.id DESC LIMIT 50`)
    .all() as any[];
  for (const a of blocked.slice(0, 10)) {
    alerts.push({
      id: `dup-${a.id}`,
      kind: 'duplicate_attempt',
      severity: 'info',
      title: `Potential duplicate transaction blocked on bill ${a.bill_number}`,
      trigger: `A second payment was attempted while ${a.txn_ref} was unresolved.`,
      rule: 'One unresolved payment per bill (enforced by the database).',
      evidence: [`Attempt at ${a.created_at}. Existing transaction ${a.txn_ref}.`],
      limitations: 'Usually a resident retrying after a slow confirmation. This is not evidence of fraud.',
      verify: ['Resolve the existing transaction so the resident gets a clear answer.'],
      dataBasis: 'synthetic_demo',
      link: { type: 'payment', id: a.existing_txn_id },
    });
  }

  const incidents = db.prepare('SELECT * FROM incidents ORDER BY last_report_at DESC').all() as any[];
  for (const i of incidents.filter((i) => i.status === 'reported_unverified')) {
    alerts.push({
      id: `inc-${i.id}`,
      kind: 'incident_verification',
      severity: i.report_count >= 3 ? 'warning' : 'info',
      title: `${i.ref}: ${i.report_count} community report(s) in ${i.locality} need verification`,
      trigger: `${i.report_count} grouped report(s); latest at ${i.last_report_at}.`,
      rule: 'Unverified incidents are listed for review; 3 or more reports raise priority.',
      evidence: [`Utility ${i.utility}, issue ${i.category_family}, network key ${i.group_key ?? 'none (locality match)'}.`],
      limitations: 'Report volume alone never verifies a fault. Confirm with a field crew or utility notice.',
      verify: ['Check the feeder/zone status with the utility control room.', 'Publish an update with an evidence source.'],
      dataBasis: 'synthetic_demo',
      link: { type: 'incident', id: i.id },
    });
  }

  const complaints = db.prepare('SELECT id, ref, category, status, created_at FROM complaints').all() as any[];
  for (const c of complaints) {
    const age = (now.getTime() - Date.parse(c.created_at)) / 86_400_000;
    if (!['resolved', 'closed'].includes(c.status) && age > COMPLAINT_SLA_DAYS) {
      alerts.push({
        id: `cmp-${c.id}`,
        kind: 'complaint_overdue',
        severity: 'warning',
        title: `Complaint ${c.ref} open for ${Math.floor(age)} days`,
        trigger: `Status "${c.status}" after ${Math.floor(age)} days.`,
        rule: `Complaints unresolved after ${COMPLAINT_SLA_DAYS} days (demo service level).`,
        evidence: [`Category ${c.category}, filed ${c.created_at}.`],
        limitations: 'Demo service level, not a regulatory timeline.',
        verify: ['Assign a handler and record progress.'],
        dataBasis: 'synthetic_demo',
        link: { type: 'complaint', id: c.id },
      });
    }
  }

  const sources = listSources(db, now);
  for (const s of sources.filter((s) => s.freshness.state === 'stale' || s.freshness.state === 'never_refreshed')) {
    alerts.push({
      id: `src-${s.id}`,
      kind: 'stale_data',
      severity: 'info',
      title: `Data source "${s.name}" is ${s.freshness.state === 'stale' ? 'stale' : 'not yet refreshed'}`,
      trigger: s.freshness.last ? `Last refreshed/verified ${s.freshness.last}.` : 'No refresh recorded.',
      rule: `Sources older than ${s.stale_after_days} days are stale.`,
      evidence: [s.integration_status],
      limitations: s.limitations,
      verify: ['Re-check the publisher page and update the registry.'],
      dataBasis: s.source_type.startsWith('official') || s.source_type === 'public_third_party' ? 'real' : 'unverified',
      link: { type: 'source', id: s.id },
    });
  }

  const order = { review: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => order[a.severity] - order[b.severity]);

  const count = (rows: any[], key: string) => rows.reduce<Record<string, number>>((m, r) => ((m[r[key]] = (m[r[key]] ?? 0) + 1), m), {});
  return {
    dataLabel: 'synthetic_demo',
    alerts,
    billExceptions: exceptions,
    overdueBills: overdue,
    unresolvedPayments: unresolved.map((t) => ({ id: t.id, txnRef: t.txn_ref, billNumber: t.bill_number, state: t.state, amountPaise: t.amount_paise, updatedAt: t.updated_at })),
    blockedAttempts: blocked.map((a) => ({ id: a.id, billNumber: a.bill_number, existingTxnRef: a.txn_ref, reason: a.reason, createdAt: a.created_at })),
    incidentsByStatus: Object.fromEntries(Object.entries(count(incidents, 'status')).map(([k, v]) => [INCIDENT_LABELS[k as keyof typeof INCIDENT_LABELS] ?? k, v])),
    complaintsByStatus: count(complaints, 'status'),
    sources: sources.map((s) => ({ id: s.id, name: s.name, sourceType: s.source_type, freshness: s.freshness })),
  };
}

export function auditLog(db: DB, limit = 100) {
  return db
    .prepare('SELECT l.id, l.action, l.entity_type, l.entity_id, l.detail_json, l.created_at, u.name AS actor, u.role AS actor_role FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id ORDER BY l.id DESC LIMIT ?')
    .all(limit)
    .map((r: any) => ({ ...r, detail: JSON.parse(r.detail_json), detail_json: undefined }));
}
