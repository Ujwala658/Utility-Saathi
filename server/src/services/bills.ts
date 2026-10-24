import type { BillRow } from '../access.js';
import { maskAccount } from '../access.js';
import { BillInput, calculateBill } from '../domain/billing.js';
import type { DB } from '../db/index.js';

const BILL_SELECT = `SELECT b.*, a.property_id, a.utility, a.account_number, a.provider_name, a.tariff_code, a.meter_digits, a.meter_multiplier
  FROM bills b JOIN utility_accounts a ON a.id = b.account_id`;

export function billInput(db: DB, row: BillRow): BillInput {
  const history = db
    .prepare(`SELECT period_start, period_end, units, reading_type, tariff_version FROM bills
              WHERE account_id = ? AND period_end <= ? AND units IS NOT NULL ORDER BY period_end`)
    .all(row.account_id, row.period_start) as { period_start: string; period_end: string; units: number; reading_type: 'actual' | 'estimated'; tariff_version: string | null }[];
  return {
    utility: row.utility,
    tariffCode: row.tariff_code,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    previousReading: row.previous_reading,
    currentReading: row.current_reading,
    readingType: row.reading_type,
    meter: { digits: row.meter_digits, multiplier: row.meter_multiplier },
    credits: JSON.parse(row.credits_json),
    arrearsPaise: row.arrears_paise,
    adjustments: JSON.parse(row.adjustments_json),
    statedTotalPaise: row.stated_total_paise ?? undefined,
    history: history.map((h) => ({
      periodStart: h.period_start,
      periodEnd: h.period_end,
      units: h.units,
      readingType: h.reading_type,
      tariffVersion: h.tariff_version ?? undefined,
    })),
  };
}

export function getBillRow(db: DB, id: string) {
  return db.prepare(`${BILL_SELECT} WHERE b.id = ?`).get(id) as BillRow | undefined;
}

/** Recalculate and cache a bill's computed fields. Bills are recomputed in period order so history is ready. */
export function recomputeBill(db: DB, id: string) {
  const row = getBillRow(db, id)!;
  const result = calculateBill(billInput(db, row));
  db.prepare('UPDATE bills SET units = ?, tariff_version = ?, payable_paise = ?, calc_status = ?, anomaly_codes = ? WHERE id = ?').run(
    result.consumption,
    result.tariff.version,
    result.totals?.payablePaise ?? null,
    result.status,
    result.anomalies.map((a) => a.code).join(','),
    id,
  );
  return result;
}

export type BillPaymentStatus = 'paid' | 'payment_in_progress' | 'unpaid' | 'nothing_due' | 'on_hold_review';

export function billPaymentStatus(db: DB, row: Pick<BillRow, 'id' | 'payable_paise' | 'calc_status'>): BillPaymentStatus {
  const states = (db.prepare('SELECT state FROM payment_transactions WHERE bill_id = ?').all(row.id) as { state: string }[]).map((s) => s.state);
  if (states.includes('credit_reconciled')) return 'paid';
  if (states.some((s) => ['initiated', 'pending', 'debit_confirmed'].includes(s))) return 'payment_in_progress';
  if (row.payable_paise === null) return 'on_hold_review';
  if (row.payable_paise === 0) return 'nothing_due';
  return 'unpaid';
}

export function billSummary(db: DB, row: BillRow) {
  return {
    id: row.id,
    billNumber: row.bill_number,
    utility: row.utility,
    provider: row.provider_name,
    account: maskAccount(row.account_number),
    propertyId: row.property_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    issuedOn: row.issued_on,
    dueOn: row.due_on,
    readingType: row.reading_type,
    units: row.units,
    tariffVersion: row.tariff_version,
    payablePaise: row.payable_paise,
    calcStatus: row.calc_status,
    anomalyCodes: row.anomaly_codes ? row.anomaly_codes.split(',') : [],
    paymentStatus: billPaymentStatus(db, row),
    dataLabel: row.data_label,
  };
}

export function listBillsForProperties(db: DB, propertyIds: string[]) {
  if (propertyIds.length === 0) return [];
  const rows = db
    .prepare(`${BILL_SELECT} WHERE a.property_id IN (${propertyIds.map(() => '?').join(',')}) ORDER BY b.period_end DESC, a.utility`)
    .all(...propertyIds) as BillRow[];
  return rows.map((r) => billSummary(db, r));
}
