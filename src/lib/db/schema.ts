export const SCHEMA = `
PRAGMA foreign_keys = ON;

-- ============ RAW LAYER (immutable) ============
CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS raw_files (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES import_batches(id),
  source_type TEXT NOT NULL CHECK (source_type IN ('fidelity','schwab','sf_households','sf_financial_accounts','rep_codes')),
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,         -- identical bytes are never imported twice
  byte_size INTEGER NOT NULL,
  content BLOB NOT NULL,               -- original bytes
  ingested_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS raw_rows (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES raw_files(id),
  row_number INTEGER NOT NULL,         -- 1 = first data row
  values_json TEXT NOT NULL,           -- {header: unmodified string}
  UNIQUE (file_id, row_number)
);
CREATE TRIGGER IF NOT EXISTS raw_files_no_update BEFORE UPDATE ON raw_files BEGIN SELECT RAISE(ABORT,'raw_files is immutable'); END;
CREATE TRIGGER IF NOT EXISTS raw_files_no_delete BEFORE DELETE ON raw_files BEGIN SELECT RAISE(ABORT,'raw_files is immutable'); END;
CREATE TRIGGER IF NOT EXISTS raw_rows_no_update BEFORE UPDATE ON raw_rows BEGIN SELECT RAISE(ABORT,'raw_rows is immutable'); END;
CREATE TRIGGER IF NOT EXISTS raw_rows_no_delete BEFORE DELETE ON raw_rows BEGIN SELECT RAISE(ABORT,'raw_rows is immutable'); END;

-- ============ CANONICAL LAYER (source facts) ============
CREATE TABLE IF NOT EXISTS advisors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
-- Grain: one row per (custodian, rep_code). Rep code alone is NOT a key.
CREATE TABLE IF NOT EXISTS rep_code_map (
  custodian TEXT NOT NULL CHECK (custodian IN ('Fidelity','Schwab')),
  rep_code TEXT NOT NULL,
  advisor_id INTEGER NOT NULL REFERENCES advisors(id),
  raw_row_id INTEGER NOT NULL REFERENCES raw_rows(id),
  PRIMARY KEY (custodian, rep_code)
);
-- Grain: one row per Salesforce Household Id.
CREATE TABLE IF NOT EXISTS households (
  sf_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  primary_advisor_name TEXT,
  advisor_id INTEGER REFERENCES advisors(id),
  primary_email TEXT,
  created_date TEXT,
  raw_row_id INTEGER NOT NULL REFERENCES raw_rows(id)
);
-- Grain: one row per Salesforce Financial Account Id (source ID preserved).
CREATE TABLE IF NOT EXISTS sf_financial_accounts (
  sf_id TEXT PRIMARY KEY,
  household_sf_id TEXT NOT NULL,       -- deliberately not an FK: dangling links must be reportable, not rejected
  account_number_raw TEXT NOT NULL,
  account_key TEXT,                    -- NULL => invalid identity
  custodian_raw TEXT NOT NULL,
  custodian TEXT CHECK (custodian IN ('Fidelity','Schwab')),
  registration_raw TEXT,
  registration TEXT NOT NULL,
  status TEXT,
  notes TEXT,
  raw_row_id INTEGER NOT NULL REFERENCES raw_rows(id)
);
CREATE INDEX IF NOT EXISTS idx_sfa_key ON sf_financial_accounts(custodian, account_key);
-- Grain: one row per custodian source row. Account identity = (custodian, account_key);
-- an observation additionally carries valuation_date. NO tax IDs / SSN fragments are copied here (they stay in raw only).
CREATE TABLE IF NOT EXISTS custodian_observations (
  id INTEGER PRIMARY KEY,
  custodian TEXT NOT NULL CHECK (custodian IN ('Fidelity','Schwab')),
  raw_row_id INTEGER NOT NULL UNIQUE REFERENCES raw_rows(id),
  account_number_raw TEXT NOT NULL,
  account_key TEXT,                    -- NULL => invalid identity
  valuation_date TEXT,                 -- ISO, parsed from the ROW, not the filename
  balance_cents INTEGER,               -- NULL = unknown (blank/malformed); never 0 by default
  balance_raw TEXT,
  registration_raw TEXT,
  registration TEXT NOT NULL,
  owner_display TEXT,
  owner_name_key TEXT,
  rep_code TEXT
);
CREATE INDEX IF NOT EXISTS idx_obs_key ON custodian_observations(custodian, account_key, valuation_date);

-- ============ DERIVED LAYER (rebuildable) ============
CREATE TABLE IF NOT EXISTS recon_runs (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  policy TEXT NOT NULL
);
-- Grain: one row per account entity (custodian+account_key) per run, or per invalid-identity source row.
CREATE TABLE IF NOT EXISTS recon_results (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES recon_runs(id),
  entity_key TEXT NOT NULL,
  custodian TEXT,
  account_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('matched','custodian_only','salesforce_only','ambiguous','invalid_identity')),
  balance_cents INTEGER,               -- value used in AUM (NULL if unknown/excluded)
  in_aum INTEGER NOT NULL DEFAULT 0,
  valuation_date TEXT,
  rep_code TEXT,
  custodian_advisor TEXT,              -- via custodian+rep_code, or 'Unassigned'
  sf_advisor TEXT,
  household_sf_id TEXT,
  sf_account_ids TEXT NOT NULL,        -- JSON array
  observation_ids TEXT NOT NULL,       -- JSON array (all lineage incl. duplicates)
  raw_row_refs TEXT NOT NULL,          -- JSON array of {file,row}
  UNIQUE (run_id, entity_key)
);
CREATE TABLE IF NOT EXISTS recon_exceptions (
  id INTEGER PRIMARY KEY,
  result_id INTEGER NOT NULL REFERENCES recon_results(id),
  code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','review','error')),
  reason TEXT NOT NULL,
  UNIQUE (result_id, code)
);

-- ============ LOCAL WORKFLOW (never written back to Salesforce/custodians) ============
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('operations','advisor')),
  advisor_name TEXT
);
CREATE TABLE IF NOT EXISTS proposed_changes (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('link_account_to_household','merge_households')),
  payload_json TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('proposed','approved','rejected','undone')),
  proposed_by TEXT NOT NULL, proposed_at TEXT NOT NULL,
  decided_by TEXT, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS approved_overrides (
  id INTEGER PRIMARY KEY,
  change_id INTEGER NOT NULL UNIQUE REFERENCES proposed_changes(id),
  kind TEXT NOT NULL, payload_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
  subject TEXT NOT NULL, before_json TEXT, after_json TEXT
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'audit_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'audit_events is append-only'); END;
`;
