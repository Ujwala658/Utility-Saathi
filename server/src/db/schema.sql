-- Utility Saathi schema (SQLite). Reproducible: applied in full on every fresh database.
-- Integrity rules that matter for safety (one open payment per bill, legal
-- payment state transitions, append-only histories) are enforced here, not
-- only in application code.
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('tenant', 'owner', 'admin')),
  password_hash TEXT NOT NULL,
  is_demo       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE properties (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES users(id),
  label        TEXT NOT NULL,
  address_line TEXT NOT NULL,
  locality     TEXT NOT NULL,
  city         TEXT NOT NULL,
  state        TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE property_memberships (
  id          TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  granted_by  TEXT NOT NULL REFERENCES users(id),
  granted_at  TEXT NOT NULL,
  revoked_at  TEXT,
  revoked_by  TEXT REFERENCES users(id)
);
CREATE UNIQUE INDEX one_active_membership ON property_memberships(property_id, user_id) WHERE revoked_at IS NULL;

CREATE TABLE utility_accounts (
  id               TEXT PRIMARY KEY,
  property_id      TEXT NOT NULL REFERENCES properties(id),
  utility          TEXT NOT NULL CHECK (utility IN ('electricity', 'water')),
  account_number   TEXT NOT NULL UNIQUE,
  provider_name    TEXT NOT NULL,
  tariff_code      TEXT NOT NULL,
  meter_digits     INTEGER NOT NULL,
  meter_multiplier REAL NOT NULL DEFAULT 1
);

CREATE TABLE bills (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL REFERENCES utility_accounts(id),
  bill_number         TEXT NOT NULL UNIQUE,
  period_start        TEXT NOT NULL,
  period_end          TEXT NOT NULL,
  previous_reading    REAL,
  current_reading     REAL,
  reading_type        TEXT NOT NULL CHECK (reading_type IN ('actual', 'estimated')),
  credits_json        TEXT NOT NULL DEFAULT '[]',
  arrears_paise       INTEGER NOT NULL DEFAULT 0 CHECK (arrears_paise >= 0),
  adjustments_json    TEXT NOT NULL DEFAULT '[]',
  stated_total_paise  INTEGER CHECK (stated_total_paise >= 0),
  issued_on           TEXT NOT NULL,
  due_on              TEXT NOT NULL,
  units               REAL,
  tariff_version      TEXT,
  payable_paise       INTEGER,
  calc_status         TEXT NOT NULL,
  anomaly_codes       TEXT NOT NULL DEFAULT '',
  data_label          TEXT NOT NULL DEFAULT 'synthetic_demo',
  UNIQUE (account_id, period_end)
);
CREATE INDEX bills_by_account ON bills(account_id, period_end);

-- Payments ---------------------------------------------------------------
CREATE TABLE payment_transitions (
  from_state TEXT NOT NULL,
  to_state   TEXT NOT NULL,
  PRIMARY KEY (from_state, to_state)
);
INSERT INTO payment_transitions VALUES
  ('initiated', 'pending'), ('initiated', 'failed'),
  ('pending', 'debit_confirmed'), ('pending', 'failed'),
  ('debit_confirmed', 'credit_reconciled'), ('debit_confirmed', 'reversed');

CREATE TABLE payment_transactions (
  id              TEXT PRIMARY KEY,
  txn_ref         TEXT NOT NULL UNIQUE,
  bill_id         TEXT NOT NULL REFERENCES bills(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL,
  amount_paise    INTEGER NOT NULL CHECK (amount_paise > 0),
  state           TEXT NOT NULL CHECK (state IN ('initiated', 'pending', 'debit_confirmed', 'credit_reconciled', 'failed', 'reversed')),
  receipt_ref     TEXT UNIQUE,
  simulated       INTEGER NOT NULL DEFAULT 1 CHECK (simulated = 1),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (user_id, idempotency_key)
);
-- At most one unresolved and at most one reconciled transaction per bill.
CREATE UNIQUE INDEX one_open_payment_per_bill ON payment_transactions(bill_id)
  WHERE state IN ('initiated', 'pending', 'debit_confirmed');
CREATE UNIQUE INDEX one_reconciled_payment_per_bill ON payment_transactions(bill_id)
  WHERE state = 'credit_reconciled';

CREATE TRIGGER payment_new_must_be_initiated BEFORE INSERT ON payment_transactions
WHEN NEW.state <> 'initiated'
BEGIN SELECT RAISE(ABORT, 'new payment transactions must start in initiated'); END;

CREATE TRIGGER payment_legal_transition BEFORE UPDATE OF state ON payment_transactions
WHEN NEW.state <> OLD.state AND NOT EXISTS (
  SELECT 1 FROM payment_transitions WHERE from_state = OLD.state AND to_state = NEW.state)
BEGIN SELECT RAISE(ABORT, 'illegal payment state transition'); END;

CREATE TRIGGER payment_identity_immutable BEFORE UPDATE OF bill_id, user_id, amount_paise, idempotency_key, txn_ref ON payment_transactions
BEGIN SELECT RAISE(ABORT, 'payment identity fields are immutable'); END;

CREATE TABLE payment_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id     TEXT NOT NULL REFERENCES payment_transactions(id),
  from_state TEXT,
  to_state   TEXT NOT NULL,
  source     TEXT NOT NULL,
  note       TEXT,
  actor_id   TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TRIGGER payment_events_no_update BEFORE UPDATE ON payment_events
BEGIN SELECT RAISE(ABORT, 'payment events are append-only'); END;
CREATE TRIGGER payment_events_no_delete BEFORE DELETE ON payment_events
BEGIN SELECT RAISE(ABORT, 'payment events are append-only'); END;

CREATE TABLE blocked_payment_attempts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id         TEXT NOT NULL REFERENCES bills(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  existing_txn_id TEXT REFERENCES payment_transactions(id),
  reason          TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

-- Service reports and incidents ------------------------------------------
-- Synthetic infrastructure topology: feeders -> transformers; water zones -> valves.
CREATE TABLE infra_nodes (
  id        TEXT PRIMARY KEY,
  utility   TEXT NOT NULL CHECK (utility IN ('electricity', 'water')),
  kind      TEXT NOT NULL CHECK (kind IN ('feeder', 'transformer', 'zone', 'valve')),
  parent_id TEXT REFERENCES infra_nodes(id),
  locality  TEXT NOT NULL,
  label     TEXT NOT NULL,
  data_label TEXT NOT NULL DEFAULT 'synthetic_demo'
);

CREATE TABLE incidents (
  id                TEXT PRIMARY KEY,
  ref               TEXT NOT NULL UNIQUE,
  utility           TEXT NOT NULL,
  category_family   TEXT NOT NULL,
  locality          TEXT NOT NULL,
  group_key         TEXT,
  status            TEXT NOT NULL CHECK (status IN ('reported_unverified', 'under_investigation', 'verified_fault',
                      'planned_maintenance', 'restoration_in_progress', 'service_restored', 'closed')),
  report_count      INTEGER NOT NULL DEFAULT 0,
  first_reported_at TEXT NOT NULL,
  last_report_at    TEXT NOT NULL,
  eta_at            TEXT,
  eta_source        TEXT,
  updated_at        TEXT NOT NULL,
  data_label        TEXT NOT NULL DEFAULT 'synthetic_demo',
  CHECK ((eta_at IS NULL) = (eta_source IS NULL))
);

CREATE TABLE service_reports (
  id              TEXT PRIMARY KEY,
  reporter_id     TEXT NOT NULL REFERENCES users(id),
  utility         TEXT NOT NULL CHECK (utility IN ('electricity', 'water')),
  category        TEXT NOT NULL,
  locality        TEXT NOT NULL,
  infra_node_id   TEXT REFERENCES infra_nodes(id),
  description     TEXT NOT NULL DEFAULT '',
  reported_at     TEXT NOT NULL,
  incident_id     TEXT NOT NULL REFERENCES incidents(id),
  grouping_reason TEXT NOT NULL,
  data_label      TEXT NOT NULL DEFAULT 'synthetic_demo'
);

CREATE TABLE incident_updates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id     TEXT NOT NULL REFERENCES incidents(id),
  author_id       TEXT NOT NULL REFERENCES users(id),
  from_status     TEXT NOT NULL,
  to_status       TEXT NOT NULL,
  note            TEXT NOT NULL,
  evidence_source TEXT,
  eta_at          TEXT,
  eta_source      TEXT,
  created_at      TEXT NOT NULL
);

-- Complaints -------------------------------------------------------------
CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

CREATE TABLE complaints (
  id                  TEXT PRIMARY KEY,
  ref                 TEXT NOT NULL UNIQUE,
  user_id             TEXT NOT NULL REFERENCES users(id),
  property_id         TEXT REFERENCES properties(id),
  bill_id             TEXT REFERENCES bills(id),
  category            TEXT NOT NULL CHECK (category IN ('billing', 'meter', 'payment', 'power', 'water', 'other')),
  subject             TEXT NOT NULL,
  description         TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('submitted', 'acknowledged', 'under_review', 'escalated', 'resolved', 'closed')),
  assigned_to         TEXT REFERENCES users(id),
  resolution_note     TEXT,
  provider_submission TEXT NOT NULL DEFAULT 'simulated_not_submitted',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE complaint_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  complaint_id TEXT NOT NULL REFERENCES complaints(id),
  actor_id     TEXT NOT NULL REFERENCES users(id),
  kind         TEXT NOT NULL CHECK (kind IN ('created', 'status_change', 'comment', 'assignment', 'evidence')),
  from_status  TEXT,
  to_status    TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL
);
CREATE TRIGGER complaint_events_no_update BEFORE UPDATE ON complaint_events
BEGIN SELECT RAISE(ABORT, 'complaint history is append-only'); END;
CREATE TRIGGER complaint_events_no_delete BEFORE DELETE ON complaint_events
BEGIN SELECT RAISE(ABORT, 'complaint history is append-only'); END;

-- Audit and provenance -----------------------------------------------------
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    TEXT REFERENCES users(id),
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

CREATE TABLE dataset_sources (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  publisher          TEXT NOT NULL,
  url                TEXT,
  access_method      TEXT NOT NULL,
  licence            TEXT NOT NULL,
  fields             TEXT NOT NULL,
  geography          TEXT NOT NULL,
  time_period        TEXT NOT NULL,
  publisher_updated  TEXT,
  last_refresh_at    TEXT,
  verified_at        TEXT,
  stale_after_days   INTEGER,
  source_type        TEXT NOT NULL CHECK (source_type IN ('official_live', 'official_historical', 'public_third_party', 'synthetic_demo', 'manual')),
  used_for           TEXT NOT NULL,
  limitations        TEXT NOT NULL,
  integration_status TEXT NOT NULL
);
