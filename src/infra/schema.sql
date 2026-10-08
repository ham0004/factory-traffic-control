CREATE TABLE IF NOT EXISTS junctions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS junction_state (
  junction_id TEXT PRIMARY KEY REFERENCES junctions(id),
  state_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

-- Queue length is COUNT(status = 'WAITING'), never a stored counter, so it can't go negative.
CREATE TABLE IF NOT EXISTS vehicles (
  junction_id TEXT NOT NULL,
  vehicle_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  vehicle_type TEXT,
  status TEXT NOT NULL CHECK (status IN ('WAITING', 'CLEARED', 'TOMBSTONE')),
  arrived_at TEXT,
  cleared_at TEXT,
  last_sequence_no INTEGER,
  PRIMARY KEY (junction_id, vehicle_id)
);

CREATE TABLE IF NOT EXISTS processed_events (
  event_id TEXT PRIMARY KEY,
  junction_id TEXT,
  payload_hash TEXT NOT NULL,
  sensor_ts TEXT,
  received_at TEXT NOT NULL,
  outcome TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS controller_commands (
  command_id TEXT PRIMARY KEY,
  junction_id TEXT NOT NULL,
  desired_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACKED', 'FAILED', 'TIMEOUT', 'STALE')),
  attempts INTEGER NOT NULL DEFAULT 1,
  sent_at TEXT NOT NULL,
  acked_at TEXT,
  actual_json TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  junction_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  direction TEXT,
  previous_state TEXT,
  new_state TEXT,
  command_id TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_junction ON audit_log(junction_id, id DESC);
