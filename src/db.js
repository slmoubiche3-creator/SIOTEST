// SQLite storage using Node's built-in driver (no native dependency to build).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  customer_key TEXT,
  customer_name TEXT,
  customer_email TEXT,
  sender_label TEXT,
  team TEXT NOT NULL,
  category TEXT NOT NULL,
  urgency TEXT NOT NULL,
  language TEXT,
  summary TEXT,
  need TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  assignee TEXT,
  team_locked INTEGER NOT NULL DEFAULT 0,
  urgency_locked INTEGER NOT NULL DEFAULT 0,
  secondary_teams TEXT NOT NULL DEFAULT '[]',
  flags TEXT NOT NULL DEFAULT '[]',
  reasons TEXT NOT NULL DEFAULT '[]',
  confidence REAL,
  engine TEXT,
  deadline_at TEXT,
  deadline_phrase TEXT,
  sla_started_at TEXT NOT NULL,
  first_received_at TEXT NOT NULL,
  last_received_at TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  incident_id INTEGER,
  responded_at TEXT,
  resolved_at TEXT,
  notified_critical_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conv_customer ON conversations(customer_key, status);
CREATE INDEX IF NOT EXISTS conv_team ON conversations(team, status);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  source TEXT,
  received_at TEXT NOT NULL,
  received_at_raw TEXT,
  date_notes TEXT NOT NULL DEFAULT '[]',
  from_raw TEXT,
  customer_name TEXT,
  customer_email TEXT,
  sender_issue TEXT,
  subject TEXT,
  body TEXT NOT NULL,
  category TEXT,
  team TEXT,
  urgency TEXT,
  language TEXT,
  summary TEXT,
  need TEXT,
  reasons TEXT NOT NULL DEFAULT '[]',
  flags TEXT NOT NULL DEFAULT '[]',
  confidence REAL,
  deadline_at TEXT,
  deadline_phrase TEXT,
  secondary_teams TEXT NOT NULL DEFAULT '[]',
  incident_term TEXT,
  engine TEXT,
  engine_error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS msg_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS msg_incident ON messages(category, incident_term, received_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ev_conv ON events(conversation_id);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,
  category TEXT NOT NULL,
  term TEXT,
  team TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  team TEXT NOT NULL,
  conversation_id INTEGER,
  incident_id INTEGER,
  recipients TEXT NOT NULL DEFAULT '[]',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  channels TEXT NOT NULL DEFAULT '{}'
);
`;

const JSON_COLUMNS = new Set(['secondary_teams', 'flags', 'reasons', 'date_notes', 'recipients', 'channels', 'data']);

// Rows come back as null-prototype objects with JSON stored as text.
export function hydrate(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = JSON_COLUMNS.has(k) && typeof v === 'string' ? JSON.parse(v) : v;
  return out;
}

export function openDb(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  const stmts = new Map();
  const prep = (sql) => {
    if (!stmts.has(sql)) stmts.set(sql, db.prepare(sql));
    return stmts.get(sql);
  };
  const encode = (params) => params.map((p) => (p !== null && typeof p === 'object' ? JSON.stringify(p) : p ?? null));
  return {
    raw: db,
    all: (sql, ...params) => prep(sql).all(...encode(params)).map(hydrate),
    get: (sql, ...params) => hydrate(prep(sql).get(...encode(params))),
    run: (sql, ...params) => prep(sql).run(...encode(params)),
    transaction(fn) {
      db.exec('BEGIN');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    close: () => db.close(),
  };
}
