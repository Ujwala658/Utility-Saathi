import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type DB = Database.Database;

const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url));

/** Open a database, applying the schema if it is new. Use ':memory:' in tests. */
export function openDb(file: string): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (!exists) db.exec(readFileSync(schemaPath, 'utf8'));
  return db;
}

export const newId = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;

export function audit(db: DB, actorId: string | null, action: string, entityType: string, entityId: string | null, detail: object, at: string) {
  db.prepare('INSERT INTO audit_log (actor_id, action, entity_type, entity_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    actorId,
    action,
    entityType,
    entityId,
    JSON.stringify(detail),
    at,
  );
}

/** Next value of a named counter, used for human-readable references. */
export function nextCounter(db: DB, name: string): number {
  db.prepare('INSERT INTO counters (name, value) VALUES (?, 0) ON CONFLICT(name) DO NOTHING').run(name);
  return (db.prepare('UPDATE counters SET value = value + 1 WHERE name = ? RETURNING value').get(name) as { value: number }).value;
}
