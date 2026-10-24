// Resettable SYNTHETIC demo fixtures. Every person, property, account, bill,
// payment, report and complaint here is fictional. Incident report times are
// relative to "now" so the live grouping demo works whenever it is run.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SessionUser } from '../auth.js';
import { hashPassword } from '../auth.js';
import { DB } from './index.js';
import { recomputeBill } from '../services/bills.js';
import { adminUpdateComplaint, commentOnComplaint, createComplaint } from '../services/complaints.js';
import { submitReport, updateIncidentStatus } from '../services/incidents.js';

export const DEMO_PASSWORD = 'demo1234';
const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url));

const USERS = [
  { id: 'u_asha', email: 'asha.tenant@demo.utilitysaathi.in', name: 'Asha Raman (demo tenant)', role: 'tenant' },
  { id: 'u_karthik', email: 'karthik.tenant@demo.utilitysaathi.in', name: 'Karthik Iyer (demo tenant)', role: 'tenant' },
  { id: 'u_ravi', email: 'ravi.owner@demo.utilitysaathi.in', name: 'Ravi Menon (demo owner)', role: 'owner' },
  { id: 'u_meera', email: 'meera.owner@demo.utilitysaathi.in', name: 'Meera Das (demo owner)', role: 'owner' },
  { id: 'u_priya', email: 'priya.admin@demo.utilitysaathi.in', name: 'Priya Nair (demo administrator)', role: 'admin' },
  { id: 'u_arjun', email: 'arjun.admin@demo.utilitysaathi.in', name: 'Arjun Rao (demo administrator)', role: 'admin' },
] as const;

const PROPERTIES = [
  { id: 'prop_lakeview', owner: 'u_ravi', label: 'Flat 3B, Lotus Residency', address: '12 Lake Road', locality: 'Lakeview' },
  { id: 'prop_millroad', owner: 'u_ravi', label: 'House 7A', address: '7A Mill Road', locality: 'Mill Road' },
  { id: 'prop_riverside', owner: 'u_meera', label: 'Villa 12, Riverside Enclave', address: '12 River Street', locality: 'Riverside' },
];

const ACCOUNTS = [
  { id: 'acc_lv_el', property: 'prop_lakeview', utility: 'electricity', number: 'DEMO-EL-0040213', provider: 'Demo Power Distribution Co. (synthetic)', tariff: 'SYN-ELEC-DOM', digits: 5 },
  { id: 'acc_lv_wa', property: 'prop_lakeview', utility: 'water', number: 'DEMO-WA-7781190', provider: 'Demo City Water Board (synthetic)', tariff: 'SYN-WATER-DOM', digits: 6 },
  { id: 'acc_mr_el', property: 'prop_millroad', utility: 'electricity', number: 'DEMO-EL-0040877', provider: 'Demo Power Distribution Co. (synthetic)', tariff: 'SYN-ELEC-DOM', digits: 5 },
  { id: 'acc_mr_wa', property: 'prop_millroad', utility: 'water', number: 'DEMO-WA-7781522', provider: 'Demo City Water Board (synthetic)', tariff: 'SYN-WATER-DOM', digits: 6 },
  { id: 'acc_rs_el', property: 'prop_riverside', utility: 'electricity', number: 'DEMO-EL-0051290', provider: 'Demo Power Distribution Co. (synthetic)', tariff: 'SYN-ELEC-DOM', digits: 5 },
];

type BillSeed = {
  id: string;
  account: string;
  start: string;
  end: string;
  prev: number | null;
  curr: number | null;
  type: 'actual' | 'estimated';
  due: string;
  stated?: number;
  credits?: { label: string; amountPaise: number; kind: 'credit' | 'subsidy' }[];
  arrears?: number;
};

const BILLS: BillSeed[] = [
  // Lakeview electricity: two actual, two estimated, then an actual catch-up bill.
  { id: 'bill_lv_el_05', account: 'acc_lv_el', start: '2026-04-05', end: '2026-05-05', prev: 12000, curr: 12150, type: 'actual', due: '2026-05-25' },
  { id: 'bill_lv_el_06', account: 'acc_lv_el', start: '2026-05-05', end: '2026-06-04', prev: 12150, curr: 12305, type: 'actual', due: '2026-06-24' },
  { id: 'bill_lv_el_07', account: 'acc_lv_el', start: '2026-06-04', end: '2026-07-04', prev: 12305, curr: 12405, type: 'estimated', due: '2026-07-24' },
  { id: 'bill_lv_el_08', account: 'acc_lv_el', start: '2026-07-04', end: '2026-08-03', prev: 12405, curr: 12505, type: 'estimated', due: '2026-08-23' },
  { id: 'bill_lv_el_09', account: 'acc_lv_el', start: '2026-08-03', end: '2026-09-02', prev: 12505, curr: 12855, type: 'actual', due: '2026-09-22' },
  { id: 'bill_lv_el_10', account: 'acc_lv_el', start: '2026-09-02', end: '2026-10-02', prev: 12855, curr: 13010, type: 'actual', due: '2026-10-22' },
  // Lakeview water: normal.
  { id: 'bill_lv_wa_08', account: 'acc_lv_wa', start: '2026-07-04', end: '2026-08-03', prev: 1200, curr: 1215.5, type: 'actual', due: '2026-08-23' },
  { id: 'bill_lv_wa_09', account: 'acc_lv_wa', start: '2026-08-03', end: '2026-09-02', prev: 1215.5, curr: 1231, type: 'actual', due: '2026-09-22' },
  { id: 'bill_lv_wa_10', account: 'acc_lv_wa', start: '2026-09-02', end: '2026-10-02', prev: 1231, curr: 1249.25, type: 'actual', due: '2026-11-05' },
  // Mill Road electricity: printed total does not match the reconstruction.
  { id: 'bill_mr_el_09', account: 'acc_mr_el', start: '2026-08-03', end: '2026-09-02', prev: 45000, curr: 45210, type: 'actual', due: '2026-09-22' },
  { id: 'bill_mr_el_10', account: 'acc_mr_el', start: '2026-09-02', end: '2026-10-02', prev: 45210, curr: 45390, type: 'actual', due: '2026-11-05', stated: 89900 },
  // Mill Road water: current reading below previous (needs review, not billed).
  { id: 'bill_mr_wa_10', account: 'acc_mr_wa', start: '2026-09-02', end: '2026-10-02', prev: 1500.25, curr: 1490, type: 'actual', due: '2026-11-05' },
  // Riverside electricity: 45-day period, subsidy and arrears.
  { id: 'bill_rs_el_08', account: 'acc_rs_el', start: '2026-07-04', end: '2026-08-18', prev: 7000, curr: 7290, type: 'actual', due: '2026-09-07' },
  {
    id: 'bill_rs_el_10', account: 'acc_rs_el', start: '2026-08-18', end: '2026-10-02', prev: 7290, curr: 7550, type: 'actual', due: '2026-11-05',
    credits: [{ label: 'State domestic subsidy (synthetic)', amountPaise: 10000, kind: 'subsidy' }], arrears: 4550,
  },
];

const INFRA = [
  { id: 'F-LV-01', utility: 'electricity', kind: 'feeder', parent: null, locality: 'Lakeview', label: '11 kV Feeder Lakeview West' },
  { id: 'T-LV-01A', utility: 'electricity', kind: 'transformer', parent: 'F-LV-01', locality: 'Lakeview', label: 'DT Lake Road North' },
  { id: 'T-LV-01B', utility: 'electricity', kind: 'transformer', parent: 'F-LV-01', locality: 'Lakeview', label: 'DT Lotus Residency' },
  { id: 'F-LV-02', utility: 'electricity', kind: 'feeder', parent: null, locality: 'Lakeview', label: '11 kV Feeder Lakeview East' },
  { id: 'T-LV-02A', utility: 'electricity', kind: 'transformer', parent: 'F-LV-02', locality: 'Lakeview', label: 'DT Temple Street' },
  { id: 'F-MR-01', utility: 'electricity', kind: 'feeder', parent: null, locality: 'Mill Road', label: '11 kV Feeder Mill Road' },
  { id: 'T-MR-01A', utility: 'electricity', kind: 'transformer', parent: 'F-MR-01', locality: 'Mill Road', label: 'DT Mill Road Junction' },
  { id: 'F-RS-01', utility: 'electricity', kind: 'feeder', parent: null, locality: 'Riverside', label: '11 kV Feeder Riverside' },
  { id: 'WZ-LV', utility: 'water', kind: 'zone', parent: null, locality: 'Lakeview', label: 'Water Zone Lakeview' },
  { id: 'V-LV-03', utility: 'water', kind: 'valve', parent: 'WZ-LV', locality: 'Lakeview', label: 'Valve LV-03 Lake Road' },
  { id: 'WZ-MR', utility: 'water', kind: 'zone', parent: null, locality: 'Mill Road', label: 'Water Zone Mill Road' },
  { id: 'WZ-RS', utility: 'water', kind: 'zone', parent: null, locality: 'Riverside', label: 'Water Zone Riverside' },
];

const SOURCES = [
  {
    id: 'cea-co2-v20',
    name: 'CO2 Baseline Database for the Indian Power Sector, Version 20.0',
    publisher: 'Central Electricity Authority (CEA), Government of India',
    url: 'https://cea.nic.in/wp-content/uploads/2021/03/User_Guide_Version_20.0.pdf',
    access_method: 'Published PDF user guide and Excel database (manual download)',
    licence: 'Government of India publication; reuse terms not confirmed',
    fields: 'Weighted average grid emission rate (tCO2/MWh), operating/build/combined margin',
    geography: 'India, national grid',
    time_period: 'FY 2023-24',
    publisher_updated: '2024-12',
    last_refresh_at: null,
    verified_at: '2026-10-24T00:00:00.000Z',
    stale_after_days: 400,
    source_type: 'official_historical',
    used_for: 'Emission factor 0.727 tCO2/MWh for consumption-based estimates (P1 sustainability summary)',
    limitations: 'National annual average; not state-, hour- or supplier-specific. Value read from the published user guide via web search tools because cea.nic.in is blocked from the build sandbox; not ingested automatically.',
    integration_status: 'Manual constant (0.727 tCO2/MWh); verified against the user guide on 2026-10-24',
  },
  {
    id: 'ogd-consumption-pattern',
    name: 'Pattern of Electricity Consumption (Utilities)',
    publisher: 'Open Government Data Platform India (data.gov.in)',
    url: 'https://www.data.gov.in/catalog/pattern-electricity-consumption-utilities',
    access_method: 'Catalog page; resources downloadable from data.gov.in',
    licence: 'National Data Sharing and Accessibility Policy (NDSAP)',
    fields: 'Percentage share of consumption: Domestic, Commercial, Industry, Traction, Agriculture, Others',
    geography: 'India, national aggregate',
    time_period: 'Various years (catalog dated 2013–2014)',
    publisher_updated: '2014-02-13',
    last_refresh_at: null,
    verified_at: '2026-10-24T00:00:00.000Z',
    stale_after_days: 365,
    source_type: 'official_historical',
    used_for: 'Context only. Not used in any bill or household calculation.',
    limitations: 'National aggregate shares, old; cannot support household bills, live outages or local comparisons.',
    integration_status: 'Not integrated (candidate for an aggregate context chart)',
  },
  {
    id: 'state-tariff-order',
    name: 'State Electricity Regulatory Commission tariff order (to be chosen)',
    publisher: 'Relevant SERC / distribution company',
    url: null,
    access_method: 'Tariff order PDF',
    licence: 'To verify',
    fields: 'Slab rates, fixed charges, duty, subsidies by consumer category',
    geography: 'One state',
    time_period: 'Tariff year',
    publisher_updated: null,
    last_refresh_at: null,
    verified_at: null,
    stale_after_days: 365,
    source_type: 'manual',
    used_for: 'Would replace the synthetic tariff for that state',
    limitations: 'Each state differs; never apply one state tariff elsewhere.',
    integration_status: 'Not integrated. Synthetic tariffs are used until a specific order is verified.',
  },
  {
    id: 'synthetic-tariffs',
    name: 'Synthetic electricity and water tariffs',
    publisher: 'Utility Saathi demo',
    url: null,
    access_method: 'Code configuration (server/src/domain/tariffs.ts)',
    licence: 'Project licence',
    fields: 'Versioned slabs, fixed charges, duty/sewerage',
    geography: 'Demo State / Demo City (fictional)',
    time_period: '2025-04 onward',
    publisher_updated: null,
    last_refresh_at: null,
    verified_at: null,
    stale_after_days: null,
    source_type: 'synthetic_demo',
    used_for: 'All bill reconstructions in this demo',
    limitations: 'Invented numbers shaped like Indian block tariffs. Not any real tariff.',
    integration_status: 'Active (synthetic)',
  },
  {
    id: 'synthetic-customers',
    name: 'Synthetic customers, properties, bills, payments, reports and complaints',
    publisher: 'Utility Saathi demo',
    url: null,
    access_method: 'Seed script (server/src/db/seed.ts)',
    licence: 'Project licence',
    fields: 'All customer-level records',
    geography: 'Saathipur (fictional)',
    time_period: '2026',
    publisher_updated: null,
    last_refresh_at: null,
    verified_at: null,
    stale_after_days: null,
    source_type: 'synthetic_demo',
    used_for: 'Every customer record, payment and incident shown',
    limitations: 'Fictional. No real person, account or payment.',
    integration_status: 'Active (synthetic, resettable)',
  },
  {
    id: 'synthetic-infra',
    name: 'Synthetic feeder/transformer and water-zone topology',
    publisher: 'Utility Saathi demo',
    url: null,
    access_method: 'Seed script',
    licence: 'Project licence',
    fields: 'Feeder → transformer, zone → valve',
    geography: 'Saathipur (fictional)',
    time_period: 'n/a',
    publisher_updated: null,
    last_refresh_at: null,
    verified_at: null,
    stale_after_days: null,
    source_type: 'synthetic_demo',
    used_for: 'Incident grouping by network location',
    limitations: 'Real topology is not public; a utility would need to provide it.',
    integration_status: 'Active (synthetic)',
  },
];

function rebuildSchema(db: DB) {
  db.pragma('foreign_keys = OFF');
  const objects = db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'trigger') AND name NOT LIKE 'sqlite_%'").all() as { type: string; name: string }[];
  for (const o of objects.filter((o) => o.type === 'trigger')) db.exec(`DROP TRIGGER IF EXISTS "${o.name}"`);
  for (const o of objects.filter((o) => o.type === 'table')) db.exec(`DROP TABLE IF EXISTS "${o.name}"`);
  db.exec(readFileSync(schemaPath, 'utf8'));
  db.pragma('foreign_keys = ON');
}

// Hashing is deliberately slow; cache per process so test resets stay quick.
let cachedHash: string | null = null;

export function resetDemoData(db: DB, now = new Date()) {
  rebuildSchema(db);
  cachedHash ??= hashPassword(DEMO_PASSWORD);
  const created = '2026-04-01T09:00:00.000Z';
  const user = (id: string) => {
    const u = USERS.find((x) => x.id === id)!;
    return { id: u.id, email: u.email, name: u.name, role: u.role, is_demo: 1 } as SessionUser;
  };
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

  db.transaction(() => {
    const insUser = db.prepare('INSERT INTO users (id, email, name, role, password_hash, is_demo, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)');
    for (const u of USERS) insUser.run(u.id, u.email, u.name, u.role, cachedHash, created);

    const insProp = db.prepare("INSERT INTO properties (id, owner_id, label, address_line, locality, city, state, created_at) VALUES (?, ?, ?, ?, ?, 'Saathipur (demo city)', 'Demo State', ?)");
    for (const p of PROPERTIES) insProp.run(p.id, p.owner, p.label, p.address, p.locality, created);

    const insMem = db.prepare('INSERT INTO property_memberships (id, property_id, user_id, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)');
    insMem.run('mem_asha_lv', 'prop_lakeview', 'u_asha', 'u_ravi', created);
    insMem.run('mem_karthik_mr', 'prop_millroad', 'u_karthik', 'u_ravi', created);

    const insAcc = db.prepare('INSERT INTO utility_accounts (id, property_id, utility, account_number, provider_name, tariff_code, meter_digits, meter_multiplier) VALUES (?, ?, ?, ?, ?, ?, ?, 1)');
    for (const a of ACCOUNTS) insAcc.run(a.id, a.property, a.utility, a.number, a.provider, a.tariff, a.digits);

    const insBill = db.prepare(
      `INSERT INTO bills (id, account_id, bill_number, period_start, period_end, previous_reading, current_reading, reading_type, credits_json, arrears_paise, stated_total_paise, issued_on, due_on, calc_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    );
    for (const b of BILLS) {
      const issued = new Date(Date.parse(`${b.end}T00:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10);
      const number = `SIM-${b.account.toUpperCase().replace('ACC_', '').replace('_', '')}-${b.end.replaceAll('-', '')}`;
      insBill.run(b.id, b.account, number, b.start, b.end, b.prev, b.curr, b.type, JSON.stringify(b.credits ?? []), b.arrears ?? 0, b.stated ?? null, issued, b.due);
    }
    for (const b of [...BILLS].sort((x, y) => x.end.localeCompare(y.end))) recomputeBill(db, b.id);

    // Payments: walk each through legal transitions with its own event history.
    const insTxn = db.prepare("INSERT INTO payment_transactions (id, txn_ref, bill_id, user_id, idempotency_key, amount_paise, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'initiated', ?, ?)");
    const setState = db.prepare('UPDATE payment_transactions SET state = ?, updated_at = ?, receipt_ref = COALESCE(?, receipt_ref) WHERE id = ?');
    const insEvt = db.prepare('INSERT INTO payment_events (txn_id, from_state, to_state, source, note, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const seedTxn = (id: string, billId: string, userId: string, start: Date, path: [string, string, number][]) => {
      const amount = (db.prepare('SELECT payable_paise FROM bills WHERE id = ?').get(billId) as { payable_paise: number }).payable_paise;
      const t0 = start.toISOString();
      insTxn.run(id, `SIMTXN-${id.slice(4).toUpperCase()}`, billId, userId, `seed-${id}`, amount, t0, t0);
      insEvt.run(id, null, 'initiated', 'user', 'Payment started in Utility Saathi (simulated)', userId, t0);
      let prev = 'initiated';
      for (const [state, source, minutesAfter] of path) {
        const at = new Date(start.getTime() + minutesAfter * 60_000).toISOString();
        setState.run(state, at, state === 'credit_reconciled' ? `SIM-RCPT-${id.slice(4).toUpperCase()}` : null, id);
        insEvt.run(id, prev, state, source, null, null, at);
        prev = state;
      }
    };
    const settled: [string, string, number][] = [['pending', 'simulated_gateway', 0], ['debit_confirmed', 'simulated_gateway', 2], ['credit_reconciled', 'simulated_utility', 180]];
    seedTxn('txn_lv05', 'bill_lv_el_05', 'u_asha', new Date('2026-05-20T10:00:00Z'), settled);
    seedTxn('txn_lv06', 'bill_lv_el_06', 'u_asha', new Date('2026-06-20T10:00:00Z'), settled);
    seedTxn('txn_lv07', 'bill_lv_el_07', 'u_asha', new Date('2026-07-20T10:00:00Z'), settled);
    seedTxn('txn_lv08', 'bill_lv_el_08', 'u_asha', new Date('2026-08-20T10:00:00Z'), settled);
    seedTxn('txn_lvw08', 'bill_lv_wa_08', 'u_asha', new Date('2026-08-20T10:05:00Z'), settled);
    seedTxn('txn_lvw09', 'bill_lv_wa_09', 'u_asha', new Date('2026-09-18T10:05:00Z'), settled);
    // Demo journey 2: bank debit confirmed three hours ago, utility credit still pending.
    seedTxn('txn_lv10', 'bill_lv_el_10', 'u_asha', ago(185), [['pending', 'simulated_gateway', 0], ['debit_confirmed', 'simulated_gateway', 5]]);
    // Mill Road: first attempt failed, safe retry succeeded.
    seedTxn('txn_mr09a', 'bill_mr_el_09', 'u_karthik', new Date('2026-09-15T08:00:00Z'), [['pending', 'simulated_gateway', 0], ['failed', 'simulated_gateway', 3]]);
    seedTxn('txn_mr09b', 'bill_mr_el_09', 'u_karthik', new Date('2026-09-15T08:10:00Z'), settled);
    seedTxn('txn_rs08', 'bill_rs_el_08', 'u_meera', new Date('2026-09-01T12:00:00Z'), settled);

    const insNode = db.prepare('INSERT INTO infra_nodes (id, utility, kind, parent_id, locality, label) VALUES (?, ?, ?, ?, ?, ?)');
    for (const n of INFRA) insNode.run(n.id, n.utility, n.kind, n.parent, n.locality, n.label);

    const insSrc = db.prepare(
      `INSERT INTO dataset_sources (id, name, publisher, url, access_method, licence, fields, geography, time_period, publisher_updated, last_refresh_at, verified_at, stale_after_days, source_type, used_for, limitations, integration_status)
       VALUES (@id, @name, @publisher, @url, @access_method, @licence, @fields, @geography, @time_period, @publisher_updated, @last_refresh_at, @verified_at, @stale_after_days, @source_type, @used_for, @limitations, @integration_status)`,
    );
    for (const s of SOURCES) insSrc.run(s);
  })();

  // Incidents, via the same service code the API uses.
  const report = (who: string, category: any, locality: string, node: string | null, minutesAgo: number, description = '') =>
    submitReport(db, user(who), { category, locality, infraNodeId: node, reportedAt: ago(minutesAgo).toISOString(), description }, now);
  report('u_asha', 'power_outage', 'Lakeview', 'T-LV-01B', 50, 'No power in the building since about an hour.');
  report('u_ravi', 'power_outage', 'Lakeview', 'T-LV-01A', 35);
  report('u_meera', 'power_outage', 'Lakeview', 'T-LV-01A', 20, 'Street lights also off.');
  report('u_karthik', 'power_outage', 'Lakeview', 'T-LV-02A', 30, 'Visiting a friend on Temple Street, power is off here.');
  report('u_asha', 'low_voltage', 'Lakeview', 'T-LV-01A', 600, 'Lights dim in the evening.');
  report('u_karthik', 'low_pressure', 'Mill Road', null, 120, 'Very low pressure on upper floor taps.');
  const old = report('u_meera', 'water_interruption', 'Riverside', 'WZ-RS', 2 * 24 * 60, 'No water supply this morning.');
  const priya = user('u_priya');
  updateIncidentStatus(db, priya, old.incidentId, { status: 'planned_maintenance', note: 'Scheduled pipeline work in Riverside zone.', evidenceSource: 'Demo Water Board notice WB-114 (synthetic)', etaAt: ago(2 * 24 * 60 - 360).toISOString(), etaSource: 'Demo Water Board notice WB-114 (synthetic)' }, ago(2 * 24 * 60 - 30));
  updateIncidentStatus(db, priya, old.incidentId, { status: 'service_restored', note: 'Supply restored after pipeline work.', evidenceSource: 'Demo Water Board field crew log (synthetic)' }, ago(2 * 24 * 60 - 400));

  // Complaints.
  const c1 = createComplaint(db, user('u_asha'), { category: 'billing', subject: 'September electricity bill is much higher than usual', description: 'My bill for August–September is more than double my normal bill. The previous two bills were estimated.', billId: 'bill_lv_el_09' }, ago(9 * 24 * 60));
  adminUpdateComplaint(db, priya, c1.id, { status: 'acknowledged', assignedTo: 'u_arjun', note: 'Received. Checking reading history.' }, ago(8 * 24 * 60));
  const c2 = createComplaint(db, user('u_karthik'), { category: 'water', subject: 'Low water pressure for three days', description: 'Upper floor taps barely run in the mornings.', propertyId: 'prop_millroad' }, ago(24 * 60));
  commentOnComplaint(db, user('u_karthik'), c2.id, 'Still the same today.', ago(60));
}
