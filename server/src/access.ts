// Property-level authorization. Every protected query goes through these
// helpers so the rule lives in one place:
// - admin: all properties
// - owner: properties they own
// - tenant: properties with an active (unrevoked) membership
import type { SessionUser } from './auth.js';
import type { DB } from './db/index.js';
import { notFound } from './errors.js';

export function accessiblePropertyIds(db: DB, user: SessionUser): string[] {
  if (user.role === 'admin') return (db.prepare('SELECT id FROM properties').all() as { id: string }[]).map((r) => r.id);
  if (user.role === 'owner') return (db.prepare('SELECT id FROM properties WHERE owner_id = ?').all(user.id) as { id: string }[]).map((r) => r.id);
  return (
    db.prepare('SELECT property_id AS id FROM property_memberships WHERE user_id = ? AND revoked_at IS NULL').all(user.id) as { id: string }[]
  ).map((r) => r.id);
}

export function canAccessProperty(db: DB, user: SessionUser, propertyId: string): boolean {
  return accessiblePropertyIds(db, user).includes(propertyId);
}

/** Loads a bill the user may see, or throws 404 (we do not reveal that other bills exist). */
export function getAccessibleBill(db: DB, user: SessionUser, billId: string) {
  const bill = db
    .prepare(
      `SELECT b.*, a.property_id, a.utility, a.account_number, a.provider_name, a.tariff_code, a.meter_digits, a.meter_multiplier
       FROM bills b JOIN utility_accounts a ON a.id = b.account_id WHERE b.id = ?`,
    )
    .get(billId) as BillRow | undefined;
  if (!bill || !canAccessProperty(db, user, bill.property_id)) throw notFound('Bill');
  return bill;
}

/** Shows the last four characters only, e.g. "••••••4521". */
export const maskAccount = (n: string) => `${'•'.repeat(Math.max(0, n.length - 4))}${n.slice(-4)}`;

export interface BillRow {
  id: string;
  account_id: string;
  bill_number: string;
  period_start: string;
  period_end: string;
  previous_reading: number | null;
  current_reading: number | null;
  reading_type: 'actual' | 'estimated';
  credits_json: string;
  arrears_paise: number;
  adjustments_json: string;
  stated_total_paise: number | null;
  issued_on: string;
  due_on: string;
  units: number | null;
  tariff_version: string | null;
  payable_paise: number | null;
  calc_status: string;
  anomaly_codes: string;
  data_label: string;
  property_id: string;
  utility: 'electricity' | 'water';
  account_number: string;
  provider_name: string;
  tariff_code: string;
  meter_digits: number;
  meter_multiplier: number;
}
