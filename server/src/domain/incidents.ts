// Explainable grouping of community reports into incidents.
//
// A report joins an open incident only if ALL of these hold:
//  1. Same utility.
//  2. Same category family (an outage is not grouped with low voltage; a leak
//     is not grouped with a supply interruption).
//  3. Reported within GROUP_WINDOW_HOURS of the incident's latest report.
//  4. Same network location: if both sides have a (synthetic) infrastructure
//     key, the feeder/zone must match; otherwise the normalised locality must match.
// Report volume never changes an incident's verification status.

export const GROUP_WINDOW_HOURS = 3;

export const REPORT_CATEGORIES = {
  power_outage: { utility: 'electricity', family: 'power_outage', label: 'Power outage' },
  low_voltage: { utility: 'electricity', family: 'low_voltage', label: 'Low voltage' },
  water_interruption: { utility: 'water', family: 'water_supply', label: 'Water supply interruption' },
  low_pressure: { utility: 'water', family: 'water_supply', label: 'Low water pressure' },
  irregular_supply: { utility: 'water', family: 'water_supply', label: 'Irregular water supply' },
  suspected_leak: { utility: 'water', family: 'water_leak', label: 'Suspected leak' },
} as const;
export type ReportCategory = keyof typeof REPORT_CATEGORIES;

export const INCIDENT_STATUSES = [
  'reported_unverified',
  'under_investigation',
  'verified_fault',
  'planned_maintenance',
  'restoration_in_progress',
  'service_restored',
  'closed',
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/** Statuses that assert something about the real network and need an evidence source. */
export const AUTHORITATIVE_STATUSES: IncidentStatus[] = ['verified_fault', 'planned_maintenance', 'restoration_in_progress', 'service_restored'];
export const OPEN_STATUSES: IncidentStatus[] = ['reported_unverified', 'under_investigation', 'verified_fault', 'planned_maintenance', 'restoration_in_progress'];

export const STATUS_LABELS: Record<IncidentStatus, string> = {
  reported_unverified: 'Reported — unverified',
  under_investigation: 'Under investigation',
  verified_fault: 'Verified fault',
  planned_maintenance: 'Planned maintenance',
  restoration_in_progress: 'Restoration in progress',
  service_restored: 'Service restored',
  closed: 'Closed',
};

export const normaliseLocality = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export interface InfraNode {
  id: string;
  utility: string;
  kind: string;
  parent_id: string | null;
  locality: string;
}

/** Feeder (electricity) or zone (water) that a node belongs to. */
export function groupKeyFor(nodeId: string | null | undefined, nodes: Map<string, InfraNode>): string | null {
  if (!nodeId) return null;
  let node = nodes.get(nodeId);
  while (node && node.parent_id) node = nodes.get(node.parent_id);
  return node ? node.id : null;
}

export interface CandidateIncident {
  id: string;
  utility: string;
  category_family: string;
  locality: string;
  group_key: string | null;
  status: IncidentStatus;
  last_report_at: string;
}

export interface NewReport {
  utility: string;
  category: ReportCategory;
  locality: string;
  groupKey: string | null;
  reportedAt: string;
}

export function matchIncident(report: NewReport, candidates: CandidateIncident[]): { incident: CandidateIncident; reason: string } | null {
  const family = REPORT_CATEGORIES[report.category].family;
  const t = Date.parse(report.reportedAt);
  const windowMs = GROUP_WINDOW_HOURS * 3_600_000;
  for (const c of candidates) {
    if (!OPEN_STATUSES.includes(c.status)) continue;
    if (c.utility !== report.utility || c.category_family !== family) continue;
    if (Math.abs(t - Date.parse(c.last_report_at)) > windowMs) continue;
    let where: string;
    if (report.groupKey && c.group_key) {
      if (report.groupKey !== c.group_key) continue;
      where = `same ${report.utility === 'electricity' ? 'feeder' : 'supply zone'} ${c.group_key}`;
    } else {
      if (normaliseLocality(report.locality) !== normaliseLocality(c.locality)) continue;
      where = `same locality "${c.locality}" (no network identifier to compare)`;
    }
    return { incident: c, reason: `Grouped: same utility, same issue type (${family}), ${where}, within ${GROUP_WINDOW_HOURS} h of the last report.` };
  }
  return null;
}
