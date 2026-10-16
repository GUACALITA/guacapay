-- Provider events already applied. A repeated event ID is ignored.

CREATE TABLE processed_events (
  event_id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments (id),
  processed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
