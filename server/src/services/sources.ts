import type { DB } from '../db/index.js';

export interface SourceRow {
  id: string;
  name: string;
  publisher: string;
  url: string | null;
  access_method: string;
  licence: string;
  fields: string;
  geography: string;
  time_period: string;
  publisher_updated: string | null;
  last_refresh_at: string | null;
  verified_at: string | null;
  stale_after_days: number | null;
  source_type: string;
  used_for: string;
  limitations: string;
  integration_status: string;
}

/** A source is stale when its last refresh (or verification) is older than its staleness window. */
export function freshness(s: Pick<SourceRow, 'last_refresh_at' | 'verified_at' | 'stale_after_days'>, now = new Date()) {
  const last = s.last_refresh_at ?? s.verified_at;
  if (s.stale_after_days === null) return { state: 'not_applicable' as const, last, ageDays: null };
  if (!last) return { state: 'never_refreshed' as const, last: null, ageDays: null };
  const ageDays = Math.floor((now.getTime() - Date.parse(last)) / 86_400_000);
  return { state: ageDays > s.stale_after_days ? ('stale' as const) : ('fresh' as const), last, ageDays };
}

export function listSources(db: DB, now = new Date()) {
  return (db.prepare('SELECT * FROM dataset_sources ORDER BY source_type, name').all() as SourceRow[]).map((s) => ({ ...s, freshness: freshness(s, now) }));
}
